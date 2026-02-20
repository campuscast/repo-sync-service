import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { IngestorService } from '../ingestor/ingestor.service';

@WebSocketGateway({ path: '/ws/sync' })
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SyncGateway.name);

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
    try {
      const result = await this.ingestor.processOps(data.schedule_id, data.ops, data.correlation_id);
      client.send(JSON.stringify({ type: 'ops_applied', correlation_id: data.correlation_id, ...result }));
    } catch (err) {
      client.send(JSON.stringify({ type: 'ops_rejected', correlation_id: data.correlation_id, error: (err as Error).message }));
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
