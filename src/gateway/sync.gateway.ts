import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { IngestorService } from '../ingestor/ingestor.service';
import { AuditClient } from '@campuscast/shared-libs';

@WebSocketGateway({ path: '/ws/sync' })
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SyncGateway.name);
  private readonly auditClient = new AuditClient();

  constructor(private readonly ingestor: IngestorService) {}

  handleConnection(client: WebSocket): void {
    this.logger.log('Client connected');
  }

  handleDisconnect(client: WebSocket): void {
    this.logger.log('Client disconnected');
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
    @MessageBody() data: { schedule_id: string; correlation_id: string },
    @ConnectedSocket() client: WebSocket,
  ): Promise<void> {
    client.send(JSON.stringify({ type: 'snapshot', correlation_id: data.correlation_id, schedule_id: data.schedule_id, slots: [] }));
  }
}
