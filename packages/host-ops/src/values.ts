/** Guards for the values that cross an untyped boundary — the broker's JSON and dsh's own hooks. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One field of an object-shaped value, or undefined when there is no such field. */
export const readField = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined
