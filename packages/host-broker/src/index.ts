/**
 * The package's entry point: what a host-side caller imports.
 *
 * The CLI is a separate entry (`bin`), and the operation table is internal — a caller starts a
 * broker, or connects to one; it does not reach into the sources.
 */
export {
  type BrokerOptions,
  DESCRIBE_OP,
  type RunningBroker,
  startBroker,
} from './broker.ts'
export type {
  BrokerError,
  BrokerErrorCode,
  BrokerRequest,
  BrokerResponse,
} from './protocol.ts'
