type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue {
  if (value === null) return null;

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return value as JsonPrimitive;
  }
  if (valueType === 'number') {
    const num = value as number;
    return Number.isFinite(num) ? num : 0;
  }
  if (valueType !== 'object') {
    return String(value) as JsonPrimitive;
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(obj).sort()) {
    const raw = obj[key];
    if (raw === undefined) continue;
    out[key] = normalize(raw);
  }
  return out;
}

export function buildCanonicalScheduleOpPayload(op: Record<string, any>): string {
  const canonical: Record<string, unknown> = {
    op_type: String(op?.op_type ?? ''),
    causal: {
      operation_id: String(op?.causal?.operation_id ?? ''),
      client_id: String(op?.causal?.client_id ?? ''),
      lamport_ts: Number(op?.causal?.lamport_ts ?? 0),
      ...(op?.causal?.vector_clock ? { vector_clock: op.causal.vector_clock } : {}),
      ...(op?.causal?.parent_op_id ? { parent_op_id: op.causal.parent_op_id } : {}),
      ...(op?.causal?.session_id ? { session_id: op.causal.session_id } : {}),
    },
    slot: op?.slot ?? {},
    ...(op?.params !== undefined ? { params: op.params } : {}),
    ...(op?.actor
      ? {
          actor: {
            ...(op.actor.auth_type ? { auth_type: op.actor.auth_type } : {}),
            ...(op.actor.user_id ? { user_id: op.actor.user_id } : {}),
            ...(op.actor.device_id ? { device_id: op.actor.device_id } : {}),
            ...(op.actor.session_id ? { session_id: op.actor.session_id } : {}),
          },
        }
      : {}),
  };

  return JSON.stringify(normalize(canonical));
}
