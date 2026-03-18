import { Injectable, Logger } from '@nestjs/common';
import { SchemaValidatorService } from '../schema-validator/schema-validator.service';
import { DedupService } from '../dedup/dedup.service';
import { RateLimiterService } from '../rate-limiter/rate-limiter.service';
import { buildCanonicalScheduleOpPayload } from './op-signature';

/** Limits per single WS message */
const MAX_OPS_PER_BATCH = parseInt(process.env.MAX_OPS_PER_BATCH || '50', 10);
const MAX_PAYLOAD_BYTES = parseInt(process.env.MAX_PAYLOAD_BYTES || '65536', 10); // 64KB

@Injectable()
export class IngestorService {
  private readonly logger = new Logger(IngestorService.name);
  private readonly signingKmsUrl = process.env.SIGNING_KMS_URL || 'http://localhost:3008';
  private readonly zonePolicyUrl = process.env.ZONE_SERVICE_URL || 'http://localhost:3002';
  private readonly scheduleServiceUrl = process.env.SCHEDULE_SERVICE_URL || 'http://localhost:3005';
  private readonly deviceServiceUrl = process.env.DEVICE_SERVICE_URL || 'http://localhost:3003';

  constructor(
    private readonly schemaValidator: SchemaValidatorService,
    private readonly dedup: DedupService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  validateBatchLimits(ops: any[], rawPayloadSize?: number): { ok: boolean; reason?: string } {
    if (!Array.isArray(ops)) {
      return { ok: false, reason: 'ops must be an array' };
    }
    if (ops.length > MAX_OPS_PER_BATCH) {
      return { ok: false, reason: `Batch exceeds limit: ${ops.length} > ${MAX_OPS_PER_BATCH}` };
    }
    if (rawPayloadSize && rawPayloadSize > MAX_PAYLOAD_BYTES) {
      return { ok: false, reason: `Payload exceeds size limit: ${rawPayloadSize} > ${MAX_PAYLOAD_BYTES}` };
    }
    return { ok: true };
  }

  async processOps(scheduleId: string, ops: any[], correlationId: string) {
    this.logger.log(`Processing ${ops.length} ops for schedule=${scheduleId} [${correlationId}]`);

    const scheduleRes = await fetch(`${this.scheduleServiceUrl}/schedules/${scheduleId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!scheduleRes.ok) {
      return {
        accepted: 0,
        rejected: ops.length,
        results: ops.map(op => ({
          operation_id: op?.causal?.operation_id || 'unknown',
          accepted: false,
          reason: `schedule_not_found:${scheduleId}`,
        })),
      };
    }
    const schedule = await scheduleRes.json() as { zone_id: string };
    const zoneId = schedule.zone_id;

    let accepted = 0;
    let rejected = 0;
    const preRejected: Array<{ operation_id: string; accepted: false; reason: string }> = [];
    const acceptedOps: any[] = [];

    for (const op of ops) {
      const operationId = op?.causal?.operation_id || 'unknown';

      // 1. Schema validation
      if (!this.schemaValidator.validateOp(op)) {
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: 'invalid_schema' });
        continue;
      }

      // 2. Signature verification
      const signature = op?.signature?.signature;
      const keyId = op?.signature?.key_id;
      const algorithm = op?.signature?.algorithm;
      if (!signature || !keyId || !algorithm) {
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: 'missing_signature' });
        continue;
      }
      if (algorithm !== 'Ed25519') {
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: `unsupported_signature_algorithm:${algorithm}` });
        continue;
      }

      const canonicalPayload = buildCanonicalScheduleOpPayload(op);
      const signCheckRes = await fetch(`${this.signingKmsUrl}/signing/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data_base64: Buffer.from(canonicalPayload, 'utf8').toString('base64'),
          signature,
          key_id: keyId,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!signCheckRes.ok) {
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: 'signature_verification_unavailable' });
        continue;
      }
      const signCheck = await signCheckRes.json() as { valid: boolean };
      if (!signCheck.valid) {
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: 'invalid_signature' });
        continue;
      }

      // 3. Identity / trust checks
      const editorUserId = op?.actor?.user_id || op?.causal?.user_id;
      const actorType = op?.actor?.auth_type;
      const deviceId = op?.actor?.device_id || op?.causal?.device_id || op?.causal?.client_id;
      const isEditorFlow = Boolean(editorUserId) && actorType === 'user_session';

      if (!isEditorFlow) {
        if (!deviceId) {
          rejected++;
          preRejected.push({ operation_id: operationId, accepted: false, reason: 'device_identity_required' });
          continue;
        }
        const deviceRes = await fetch(`${this.deviceServiceUrl}/devices/${encodeURIComponent(deviceId)}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!deviceRes.ok) {
          rejected++;
          preRejected.push({ operation_id: operationId, accepted: false, reason: `unknown_device:${deviceId}` });
          continue;
        }
        const device = await deviceRes.json() as { status?: string };
        if (device.status !== 'active') {
          rejected++;
          preRejected.push({ operation_id: operationId, accepted: false, reason: `device_not_trusted:${device.status || 'unknown'}` });
          continue;
        }
      }

      // 4. Dedup check
      const opId = op.causal?.operation_id;
      if (opId && await this.dedup.isDuplicate(opId)) {
        this.logger.debug(`Duplicate op: ${opId}`);
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: 'duplicate_operation' });
        continue;
      }

      // 5. Rate limit
      const clientId = op.causal?.client_id || 'unknown';
      if (!await this.rateLimiter.check(clientId)) {
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: `rate_limited:${clientId}` });
        continue;
      }

      // 6. Policy check (zone-policy source of truth)
      const policyPayload = isEditorFlow
        ? {
            user_id: editorUserId,
            zone_id: zoneId,
            action: 'schedule:write',
            resource_id: scheduleId,
          }
        : {
            device_id: deviceId,
            zone_id: zoneId,
            action: 'sync:ingest',
            resource_id: scheduleId,
          };

      const policyRes = await fetch(`${this.zonePolicyUrl}/policy/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policyPayload),
        signal: AbortSignal.timeout(5000),
      });
      if (!policyRes.ok) {
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: 'policy_check_unavailable' });
        continue;
      }
      const policy = await policyRes.json() as { allowed: boolean; reason?: string };
      if (!policy.allowed) {
        rejected++;
        preRejected.push({ operation_id: operationId, accepted: false, reason: policy.reason || 'policy_denied' });
        continue;
      }

      acceptedOps.push(op);
    }

    let forwardedResults: Array<{ operation_id: string; accepted: boolean; reason?: string; explanation?: string; compensating_ops?: any[] }> = [];
    if (acceptedOps.length > 0) {
      const forwardRes = await fetch(`${this.scheduleServiceUrl}/schedules/${scheduleId}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: acceptedOps }),
        signal: AbortSignal.timeout(7000),
      });
      if (!forwardRes.ok) {
        const reason = `schedule_forward_failed:${forwardRes.status}`;
        forwardedResults = acceptedOps.map(op => ({
          operation_id: op?.causal?.operation_id || 'unknown',
          accepted: false,
          reason,
        }));
      } else {
        const forwardPayload = await forwardRes.json() as { results?: Array<{ operation_id: string; accepted: boolean; reason?: string; explanation?: string; compensating_ops?: any[] }> };
        forwardedResults = forwardPayload.results || acceptedOps.map(op => ({
          operation_id: op?.causal?.operation_id || 'unknown',
          accepted: true,
        }));
      }
    }

    for (const result of forwardedResults) {
      if (result.accepted) accepted++;
      else rejected++;
    }

    return { accepted, rejected, results: [...preRejected, ...forwardedResults] };
  }
}
