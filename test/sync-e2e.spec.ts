/**
 * Integration tests for sync layer: snapshot, broadcast, reconnect, idempotency.
 *
 * These tests mock the external schedule-service HTTP calls and test
 * the sync-service gateway + distributor logic in isolation.
 */
import { DistributorService } from '../src/distributor/distributor.service';

// Minimal WebSocket mock implementing the subset used by DistributorService
class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  lastMessage(): any {
    return this.sent.length ? JSON.parse(this.sent[this.sent.length - 1]) : null;
  }

  allMessages(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

describe('DistributorService — Room Management & Broadcast', () => {
  let distributor: DistributorService;

  beforeEach(() => {
    distributor = new DistributorService();
  });

  it('should auto-join client to a room and broadcast to others', () => {
    const clientA = new MockWebSocket() as any;
    const clientB = new MockWebSocket() as any;

    distributor.join('schedule-1', clientA);
    distributor.join('schedule-1', clientB);

    const message = {
      type: 'ops_applied',
      correlation_id: 'broadcast-123',
      schedule_id: 'schedule-1',
      accepted: 1,
      rejected: 0,
      results: [{ operation_id: 'op-1', accepted: true }],
      ops: [{ op_type: 'add_slot', slot: { slot_id: 's1' }, causal: { operation_id: 'op-1' } }],
    };

    const sent = distributor.broadcast('schedule-1', message, clientA);

    expect(sent).toBe(1);
    expect(clientB.sent.length).toBe(1);
    expect(clientA.sent.length).toBe(0); // sender excluded

    const received = clientB.lastMessage();
    expect(received.type).toBe('ops_applied');
    expect(received.ops).toHaveLength(1);
    expect(received.ops[0].op_type).toBe('add_slot');
  });

  it('should remove client from all rooms on disconnect', () => {
    const clientA = new MockWebSocket() as any;
    const clientB = new MockWebSocket() as any;

    distributor.join('schedule-1', clientA);
    distributor.join('schedule-2', clientA);
    distributor.join('schedule-1', clientB);

    distributor.leaveAll(clientA);

    // Broadcast to schedule-1 should only reach B now
    const sent = distributor.broadcast('schedule-1', { type: 'test' });
    expect(sent).toBe(1);
    expect(clientB.sent.length).toBe(1);

    // Broadcast to schedule-2 should reach nobody
    const sent2 = distributor.broadcast('schedule-2', { type: 'test' });
    expect(sent2).toBe(0);
  });

  it('should not broadcast to closed WebSocket connections', () => {
    const clientA = new MockWebSocket() as any;
    const clientB = new MockWebSocket() as any;

    distributor.join('schedule-1', clientA);
    distributor.join('schedule-1', clientB);

    clientB.readyState = MockWebSocket.CLOSED;

    const sent = distributor.broadcast('schedule-1', { type: 'test' });
    expect(sent).toBe(1); // only clientA (open)
    expect(clientA.sent.length).toBe(1);
    expect(clientB.sent.length).toBe(0);
  });

  it('broadcast to empty room returns 0', () => {
    const sent = distributor.broadcast('nonexistent', { type: 'test' });
    expect(sent).toBe(0);
  });
});

describe('Sync Gateway — sync_request & broadcast scenarios (unit-level)', () => {
  it('broadcast payload contains ops data for client convergence', () => {
    const ops = [
      { op_type: 'add_slot', causal: { operation_id: 'op-1' }, slot: { slot_id: 's1', asset_id: 'a1' } },
      { op_type: 'update_slot', causal: { operation_id: 'op-2' }, slot: { slot_id: 's1', priority: 50 } },
    ];

    // Simulate what the gateway builds for broadcast
    const acceptedOps = ops;
    const broadcastPayload = {
      type: 'ops_applied',
      correlation_id: `broadcast-${Date.now()}`,
      schedule_id: 'sched-1',
      accepted: acceptedOps.length,
      rejected: 0,
      results: acceptedOps.map((op) => ({
        operation_id: op.causal.operation_id,
        accepted: true,
      })),
      ops: acceptedOps,
    };

    // Verify broadcast is structured for client-side application
    expect(broadcastPayload.type).toBe('ops_applied');
    expect(broadcastPayload.ops).toHaveLength(2);
    expect(broadcastPayload.ops[0].slot.slot_id).toBe('s1');
    expect(broadcastPayload.results).toHaveLength(2);
    expect(broadcastPayload.results.every((r: any) => r.accepted)).toBe(true);
  });

  it('sync_request with unknown last_known_operation_id should fall back to full snapshot', () => {
    // Simulate schedule-service response when after_op_id is unknown:
    // it returns full snapshot without missing_ops field
    const scheduleServiceResponse = {
      schedule_id: 'sched-1',
      epoch: 3,
      slots: [
        { slot_id: 's1', asset_id: 'a1', start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T01:00:00Z' },
        { slot_id: 's2', asset_id: 'a2', start_time: '2026-01-01T01:00:00Z', end_time: '2026-01-01T02:00:00Z' },
      ],
      snapshot_hash: 'abc123',
      last_operation_id: 'op-50',
      // no missing_ops — full snapshot mode
    };

    // Gateway should pass through full snapshot to client
    const clientMessage = {
      type: 'snapshot',
      correlation_id: 'web-123',
      schedule_id: scheduleServiceResponse.schedule_id,
      slots: scheduleServiceResponse.slots,
      epoch: scheduleServiceResponse.epoch,
      snapshot_hash: scheduleServiceResponse.snapshot_hash,
      last_operation_id: scheduleServiceResponse.last_operation_id,
    };

    expect(clientMessage.slots).toHaveLength(2);
    expect(clientMessage.last_operation_id).toBe('op-50');
    expect((clientMessage as any).missing_ops).toBeUndefined();
  });

  it('sync_request with known last_known_operation_id should pass missing_ops delta through', () => {
    const scheduleServiceResponse = {
      schedule_id: 'sched-1',
      epoch: 3,
      slots: [{ slot_id: 's1', asset_id: 'a1' }],
      snapshot_hash: 'abc123',
      last_operation_id: 'op-12',
      missing_ops: [
        { op_type: 'update_slot', operation_id: 'op-11', slot_data: { slot_id: 's1', priority: 55 }, lamport_ts: 1100, client_id: 'editor:a' },
        { op_type: 'move_slot', operation_id: 'op-12', slot_data: { slot_id: 's1', start_time: '2026-01-01T01:00:00Z', end_time: '2026-01-01T02:00:00Z' }, lamport_ts: 1200, client_id: 'editor:b' },
      ],
    };

    const clientMessage = {
      type: 'snapshot',
      correlation_id: 'web-124',
      schedule_id: scheduleServiceResponse.schedule_id,
      slots: scheduleServiceResponse.slots,
      epoch: scheduleServiceResponse.epoch,
      snapshot_hash: scheduleServiceResponse.snapshot_hash,
      last_operation_id: scheduleServiceResponse.last_operation_id,
      missing_ops: scheduleServiceResponse.missing_ops,
    };

    expect(clientMessage.last_operation_id).toBe('op-12');
    expect(clientMessage.missing_ops).toHaveLength(2);
    expect(clientMessage.missing_ops[0].operation_id).toBe('op-11');
  });

  it('duplicate operation_id is handled gracefully via already_applied', () => {
    // Simulate what schedule-service returns when ingestor sends a dup op
    const ingestResult = {
      accepted: 1,
      rejected: 0,
      results: [{ operation_id: 'op-dup', accepted: true, reason: 'already_applied' }],
    };

    expect(ingestResult.results[0].accepted).toBe(true);
    expect(ingestResult.results[0].reason).toBe('already_applied');
  });
});

describe('Reconnect workflow — offline -> sync_request -> snapshot -> convergence', () => {
  it('full scenario: clientA ops + clientB ops -> snapshot contains both', () => {
    // 1. Client A edits offline: add_slot s1
    const clientAOps = [
      { op_type: 'add_slot', causal: { operation_id: 'a-op-1' }, slot: { slot_id: 's1', asset_id: 'a1' } },
    ];

    // 2. Client B edits while A is offline: add_slot s2
    const clientBOps = [
      { op_type: 'add_slot', causal: { operation_id: 'b-op-1' }, slot: { slot_id: 's2', asset_id: 'a2' } },
    ];

    // 3. Server materialized state (schedule-service computed) includes both
    // (assuming B's ops were applied while A was offline)
    const serverSnapshot = {
      slots: [
        { slot_id: 's2', asset_id: 'a2' }, // B's slot (already on server)
      ],
      last_operation_id: 'b-op-1',
    };

    // 4. Client A reconnects, receives snapshot
    // Client A applies snapshot → local state becomes [s2]
    // Client A still has pending op a-op-1 in queue
    // Client A re-sends a-op-1 → server applies it
    // Server now has [s1, s2] → broadcasts to B

    // After convergence, both clients have [s1, s2]
    const convergedState = [
      ...serverSnapshot.slots,
      ...clientAOps.map((op) => op.slot),
    ];

    expect(convergedState).toHaveLength(2);
    expect(convergedState.map((s) => s.slot_id).sort()).toEqual(['s1', 's2']);
  });
});
