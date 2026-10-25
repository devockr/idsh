/**
 * The package's public surface: the broker, the protocol a client speaks, and the bounds both
 * share.
 *
 * The CLI is a separate entry (`bin`), and the operation table is internal — a caller starts a
 * broker or talks to one; it does not reach into the sources. The protocol is here because the
 * plugin that talks to the broker needs the same framing, and `exports` exposes nothing else.
 */
export {
  type BrokerOptions,
  DESCRIBE_OP,
  type RunningBroker,
  startBroker,
} from './broker.ts'
export { MAX_OUTPUT_BYTES, TAIL_WINDOW_BYTES } from './constants.ts'
export { capOutput, type Capped, RateLimiter } from './limits.ts'
export {
  type BrokerError,
  type BrokerErrorCode,
  BrokerFault,
  type BrokerRequest,
  type BrokerResponse,
  createLineReader,
  encode,
  MAX_LINE_BYTES,
  parseRequest,
} from './protocol.ts'
