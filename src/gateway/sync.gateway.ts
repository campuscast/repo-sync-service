import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { IngestorService } from '../ingestor/ingestor.service';
import { DistributorService } from '../distributor/distributor.service';
import { AuditClient } from '@campuscast/shared-libs';

@WebSocketGateway({ path: '/ws/sync' })
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SyncGateway.name);
  private readonly auditClient = new AuditClient();
  private readonly scheduleServiceUrl = process.env.SCHEDULE_SERVICE_URL || 'http://localhost:3005';

  constructor(
    private readonly ingestor: IngestorService,
    private readonly distributor: DistributorService,
  ) {}

  handleConnection(client: WebSocket): void {
    this.logger.log('Client connected');
  }

  handleDisconnect(client: WebSocket): void {
    this.logger.log('Client disconnected');
    this.distributor.leaveAll(client);
  }

  @SubscribeMessage('ops_batch')
  async handleOpsBatch(
    @MessageBody() data: { schedule_id: string; ops: any[]; correlation_id: string },
    @ConnectedSocket() client: WebSocket,
  ): Promise<void> {
    const correlationId = data.correlation_id || 'unknown';

    // Batch limit check
    const rawSize = JSON.stringify(data).length;
    const limitCheck = this.ingestor.validateBatchLimits(data.ops, rawSize);
    if (!limitCheck.ok) {
      this.logger.warn(`Batch rejected: ${limitCheck.reason} [${correlationId}]`);
      client.send(JSON.stringify({ type: 'batch_rejected', correlation_id: correlationId, reason: limitCheck.reason }));
      this.auditClient.append({
        event_type: 'security.quota_exceeded',
        actor_type: 'client',
        actor_id: data.ops?.[0]?.causal?.client_id || 'unknown',
        resource_type: 'schedule',
        resource_id: data.schedule_id,
        action: 'batch_rejected',
        detail: { reason: limitCheck.reason, ops_count: data.ops?.length, raw_bytes: rawSize },
        correlation_id: correlationId,
      });
      return;
    }

    try {
      const result = await this.ingestor.processOps(data.schedule_id, data.ops, correlationId);
      client.send(JSON.stringify({ type: 'ops_applied', correlation_id: correlationId, ...result }));

      // Auto-join the sender to this schedule's room
      this.distributor.join(data.schedule_id, client);

      // Broadcast to other editors with applicable ops data
      const acceptedOps = (result.results || [])
        .filter((r: any) => r.accepted)
        .map((r: any) => {
          const originalOp = data.ops.find((op: any) => op?.causal?.operation_id === r.operation_id);
          return originalOp || null;
        })
        .filter(Boolean);

      if (acceptedOps.length > 0) {
        this.distributor.broadcast(
          data.schedule_id,
          {
            type: 'ops_applied',
            correlation_id: `broadcast-${Date.now()}`,
            schedule_id: data.schedule_id,
            accepted: acceptedOps.length,
            rejected: 0,
            results: acceptedOps.map((op: any) => ({
              operation_id: op.causal?.operation_id,
              accepted: true,
            })),
            ops: acceptedOps,
          },
          client,
        );
      }

      // Audit rejected ops with reasons
      const rejectedResults = (result.results || []).filter((r: any) => !r.accepted);
      if (rejectedResults.length > 0) {
        this.auditClient.append({
          event_type: 'sync.ops_rejected',
          actor_type: 'client',
          actor_id: data.ops?.[0]?.causal?.client_id || 'unknown',
          resource_type: 'schedule',
          resource_id: data.schedule_id,
          action: 'ops_rejected',
          detail: { rejected: result.rejected, reasons: rejectedResults.map((r: any) => r.reason) },
          correlation_id: correlationId,
        });
      }
    } catch (err) {
      client.send(JSON.stringify({ type: 'ops_rejected', correlation_id: correlationId, error: (err as Error).message }));
    }
  }

  @SubscribeMessage('sync_request')
  async handleSyncRequest(
    @MessageBody() data: { schedule_id: string; correlation_id: string; last_known_operation_id?: string },
    @ConnectedSocket() client: WebSocket,
  ): Promise<void> {
    const correlationId = data.correlation_id || 'unknown';

    // Auto-join the client to this schedule's room
    this.distributor.join(data.schedule_id, client);

    try {
      // Build snapshot URL with optional delta parameter
      let snapshotUrl = `${this.scheduleServiceUrl}/schedules/${data.schedule_id}/snapshot`;
      if (data.last_known_operation_id) {
        snapshotUrl += `?after_op_id=${encodeURIComponent(data.last_known_operation_id)}`;
      }

      const snapshotRes = await fetch(snapshotUrl, { signal: AbortSignal.timeout(5000) });

      if (!snapshotRes.ok) {
        this.logger.warn(`Snapshot fetch failed: status=${snapshotRes.status} schedule=${data.schedule_id}`);
        client.send(JSON.stringify({
          type: 'snapshot',
          correlation_id: correlationId,
          schedule_id: data.schedule_id,
          slots: [],
        }));
        return;
      }

      const snapshot = await snapshotRes.json() as {
        schedule_id: string;
        epoch?: number;
        slots: any[];
        snapshot_hash?: string;
        last_operation_id?: string;
        missing_ops?: any[];
      };

      client.send(JSON.stringify({
        type: 'snapshot',
        correlation_id: correlationId,
        schedule_id: snapshot.schedule_id,
        slots: snapshot.slots,
        epoch: snapshot.epoch,
        snapshot_hash: snapshot.snapshot_hash,
        last_operation_id: snapshot.last_operation_id,
        ...(snapshot.missing_ops ? { missing_ops: snapshot.missing_ops } : {}),
      }));
    } catch (err) {
      this.logger.error(`sync_request failed: ${(err as Error).message}`);
      client.send(JSON.stringify({
        type: 'snapshot',
        correlation_id: correlationId,
        schedule_id: data.schedule_id,
        slots: [],
      }));
    }
  }
}
