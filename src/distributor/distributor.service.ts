import { Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';

@Injectable()
export class DistributorService {
  private readonly logger = new Logger(DistributorService.name);

  /** scheduleId -> Set of connected WebSocket clients */
  private readonly rooms = new Map<string, Set<WebSocket>>();

  /** Subscribe a client to a schedule room */
  join(scheduleId: string, client: WebSocket): void {
    if (!this.rooms.has(scheduleId)) {
      this.rooms.set(scheduleId, new Set());
    }
    this.rooms.get(scheduleId)!.add(client);
    this.logger.debug(`Client joined room=${scheduleId}, size=${this.rooms.get(scheduleId)!.size}`);
  }

  /** Remove client from a specific room */
  leave(scheduleId: string, client: WebSocket): void {
    this.rooms.get(scheduleId)?.delete(client);
    if (this.rooms.get(scheduleId)?.size === 0) {
      this.rooms.delete(scheduleId);
    }
  }

  /** Remove client from ALL rooms (on disconnect) */
  leaveAll(client: WebSocket): void {
    for (const [scheduleId, clients] of this.rooms) {
      clients.delete(client);
      if (clients.size === 0) {
        this.rooms.delete(scheduleId);
      }
    }
  }

  /** Broadcast a message to all clients in a room EXCEPT the sender */
  broadcast(scheduleId: string, message: object, excludeClient?: WebSocket): number {
    const clients = this.rooms.get(scheduleId);
    if (!clients) return 0;

    const payload = JSON.stringify(message);
    let sent = 0;
    for (const client of clients) {
      if (client === excludeClient) continue;
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sent++;
      }
    }
    this.logger.debug(`Broadcast to room=${scheduleId}: ${sent} clients`);
    return sent;
  }
}
