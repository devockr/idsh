/* eslint-disable @typescript-eslint/no-magic-numbers -- this file is where the numbers are named */
/**
 * Every number the broker is built from, in one place.
 *
 * The lint rule against bare literals is right for behaviour and wrong for definitions: a number
 * gets here only after it has a name and a reason.
 */

/** The byte that ends a protocol line: `\n`, as a number. */
export const NEWLINE_BYTE = 10

/** Bytes in a kibibyte. */
export const BYTES_PER_KIB = 1024

/** One protocol line may not exceed this many bytes. */
export const MAX_LINE_BYTES = 16 * BYTES_PER_KIB

/** One answer may not exceed this many bytes. */
export const MAX_OUTPUT_BYTES = 64 * BYTES_PER_KIB

/** The default rate-limit window, one minute. */
export const DEFAULT_WINDOW_MS = 60_000

/** How much of the end of a log one tail reads. */
export const TAIL_WINDOW_BYTES = 256 * BYTES_PER_KIB

/** The longest `log.tail` pattern, in characters. */
export const MAX_PATTERN_CHARS = 200

/** Arguments are capped to this many characters in the audit log. */
export const MAX_AUDIT_ARGS_CHARS = 200

/** How long the liveness probe of an existing socket waits before calling it stale. */
export const LIVENESS_TIMEOUT_MS = 200

/** How much longer than an operation's own deadline the wrapper waits. */
export const TIMEOUT_SLACK_MS = 1000

/** The largest delay Node's timers accept (2^31 - 1 ms). */
export const MAX_TIMER_MS = 2_147_483_647

/** The deployment container's name, unless the host says otherwise. */
export const DEFAULT_CONTAINER = 'dsh'

/** The docker client, unless the host says otherwise. */
export const DEFAULT_DOCKER = 'docker'

/** The default per-operation deadline. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10_000

/** UTF-8 continuation byte: the top two bits are `10`. */
export const UTF8_CONTINUATION_MASK = 0b1100_0000
export const UTF8_CONTINUATION_PREFIX = 0b1000_0000

/** The longest UTF-8 sequence, so a cut inside one backs off by at most this much. */
export const MAX_UTF8_SEQUENCE = 4

/** One operation may buffer this much program output before failing. */
export const MAX_EXEC_BUFFER_BYTES = 1024 * BYTES_PER_KIB

/** How many requests may be queued on one connection before reading pauses. */
export const INTAKE_QUEUE_LIMIT = 16

/** Directory permission bits that let someone else replace what is inside. */
export const FORBIDDEN_DIRECTORY_BITS = 0o022

/** Files the broker writes — the audit log — are readable by their owner only. */
export const FILE_MODE = 0o600

/** The socket is readable by its owner only. */
export const SOCKET_MODE = 0o600

/** The socket's directory is openable by its owner only. */
export const DIRECTORY_MODE = 0o700
