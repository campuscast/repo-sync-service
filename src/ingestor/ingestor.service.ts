import { Injectable, Logger } from '@nestjs/common';
import { SchemaValidatorService } from '../schema-validator/schema-validator.service';
import { DedupService } from '../dedup/dedup.service';
import { RateLimiterService } from '../rate-limiter/rate-limiter.service';

/** Limits per single WS message */
const MAX_OPS_PER_BATCH = parseInt(process.env.MAX_OPS_PER_BATCH || '50', 10);
const MAX_PAYLOAD_BYTES = parseInt(process.env.MAX_PAYLOAD_BYTES || '65536', 10); // 64KB

@Injectable()
export class IngestorService {
  private readonly logger = new Logger(IngestorService.name);

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

    let accepted = 0;
    let rejected = 0;
    const rejectedReasons: string[] = [];

    for (const op of ops) {
      // 1. Schema validation
      if (!this.schemaValidator.validateOp(op)) {
        rejected++;
        rejectedReasons.push(`invalid_schema:${op.causal?.operation_id || 'unknown'}`);
        continue;
      }

      // 2. Dedup check
      const opId = op.causal?.operation_id;
      if (opId && await this.dedup.isDuplicate(opId)) {
        this.logger.debug(`Duplicate op: ${opId}`);
        rejected++;
        continue;
      }

      // 3. Rate limit
      const clientId = op.causal?.client_id || 'unknown';
      if (!await this.rateLimiter.check(clientId)) {
        rejected++;
        rejectedReasons.push(`rate_limited:${clientId}`);
        continue;
      }

      // 4. Forward to schedule service (stub)
      accepted++;
    }

    return { accepted, rejected, rejectedReasons };
  }
}
