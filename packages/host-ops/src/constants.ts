/**
 * The numbers this plugin is built from.
 */

/** Where the deployment mounts the broker's socket, unless its profile says otherwise. */
export const DEFAULT_SOCKET_PATH = '/run/idsh-host/host.sock'

/** How long one call may take. The broker's own operations stop at 10 seconds. */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * A response line is bounded to cap memory, not to guess the broker's size: a 64 KiB result can
 * become a 384 KiB line once JSON escapes control bytes, so this sits above that with room.
 */
export const MAX_RESPONSE_BYTES = 1024 * 1024

/** The largest delay Node's timers accept (2^31 - 1 ms). */
export const MAX_TIMER_MS = 2_147_483_647

/** The byte that ends a protocol line: `\n`, as a number. */
export const NEWLINE_BYTE = 10
