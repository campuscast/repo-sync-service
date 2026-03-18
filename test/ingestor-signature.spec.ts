import { IngestorService } from '../src/ingestor/ingestor.service';
import { buildCanonicalScheduleOpPayload } from '../src/ingestor/op-signature';

describe('IngestorService — signed editor operations', () => {
  const schemaValidator = { validateOp: jest.fn() };
  const dedup = { isDuplicate: jest.fn() };
  const rateLimiter = { check: jest.fn() };

  let service: IngestorService;

  beforeEach(() => {
    jest.resetAllMocks();
    schemaValidator.validateOp.mockReturnValue(true);
    dedup.isDuplicate.mockResolvedValue(false);
    rateLimiter.check.mockResolvedValue(true);
    service = new IngestorService(schemaValidator as any, dedup as any, rateLimiter as any);
  });

  it('accepts valid user-session signed op without device identity check', async () => {
    const op = {
      op_type: 'add_slot',
      causal: {
        operation_id: 'op-1',
        client_id: 'editor:user-1',
        lamport_ts: 1,
        session_id: 'editor-session-1',
      },
      actor: {
        auth_type: 'user_session',
        user_id: 'user-1',
        session_id: 'editor-session-1',
      },
      signature: {
        signature: 'base64-signature',
        key_id: 'operation-1234abcd',
        algorithm: 'Ed25519',
      },
      slot: {
        slot_id: 'slot-1',
        asset_id: 'asset-1',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-01T01:00:00.000Z',
        zone_id: 'zone-1',
        group_id: 'group-1',
        priority: 50,
      },
    };

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/schedules/schedule-1')) {
        return new Response(JSON.stringify({ zone_id: 'zone-1' }), { status: 200 });
      }

      if (url.endsWith('/signing/verify')) {
        const payload = JSON.parse(String(init?.body)) as { data_base64: string };
        const canonicalPayload = Buffer.from(payload.data_base64, 'base64').toString('utf8');
        expect(canonicalPayload).toBe(buildCanonicalScheduleOpPayload(op));
        return new Response(JSON.stringify({ valid: true }), { status: 200 });
      }

      if (url.endsWith('/policy/check')) {
        const payload = JSON.parse(String(init?.body)) as { action: string; user_id?: string; device_id?: string };
        expect(payload.action).toBe('schedule:write');
        expect(payload.user_id).toBe('user-1');
        expect(payload.device_id).toBeUndefined();
        return new Response(JSON.stringify({ allowed: true }), { status: 200 });
      }

      if (url.endsWith('/schedules/schedule-1/ops')) {
        return new Response(
          JSON.stringify({
            results: [{ operation_id: 'op-1', accepted: true }],
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const result = await service.processOps('schedule-1', [op], 'corr-1');

    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.results).toEqual([{ operation_id: 'op-1', accepted: true }]);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        (typeof input === 'string' ? input : input.toString()).includes('/devices/'),
      ),
    ).toBe(false);
  });
});
