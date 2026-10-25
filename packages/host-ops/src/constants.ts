/* eslint-disable @typescript-eslint/no-magic-numbers -- this file is where the numbers are named */
/**
 * The numbers this plugin is built from.
 */

/** Where the deployment mounts the broker's socket, unless its profile says otherwise. */
export const DEFAULT_SOCKET_PATH = '/run/idsh-host/host.sock'

/** How long one call may take. The broker's own operations stop at 10 seconds. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** A response line is bounded too: the broker caps a result at 64 KiB. */
export const MAX_RESPONSE_BYTES = 256 * 1024

/** The byte that ends a protocol line: `\n`, as a number. */
export const NEWLINE_BYTE = 10
