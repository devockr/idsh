/**
 * Guards for the values that cross an untyped boundary — the broker's JSON and dsh's own hooks.
 *
 * A record is an object _and not an array_: every call site here treats the value as a bag of
 * fields, and an array answers "no such field" for every key while still passing an `object` check.
 * The looser "is an object" checks elsewhere (the broker's request parser, the profile manifests)
 * are named `isObject` for that reason.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One field of an object-shaped value, or undefined when there is no such field. */
export const readField = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined
