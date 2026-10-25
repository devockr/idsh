/**
 * The agent-facing half: it asks the broker for its operation table at load time and registers one
 * dsh tool per operation, so the model sees the broker's own names and schemas.
 *
 * There is no shell here either: a tool call is one request to the broker, which validates the
 * arguments against the same schema and owns the audit line.
 */
import { callBroker, type BrokerEndpoint } from './client.ts'
import { DEFAULT_SOCKET_PATH, DEFAULT_TIMEOUT_MS } from './constants.ts'

export const name = 'host-ops'
export const inject = ['tools']

export interface Config {
  /** Where the deployment mounts the broker's socket. */
  readonly socketPath?: string
  /** How long one call may take, in milliseconds. */
  readonly timeoutMs?: number
}

interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

interface ToolExecution {
  readonly signal: AbortSignal
}

/** The slice of dsh a tool needs; structural, so this package imports no dsh code. */
export interface HostTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolExecution): Promise<unknown>
}

export interface HostContext {
  readonly tools: { register(tool: HostTool): () => void }
  readonly logger: { warn(message: string): void }
}

interface DescribedOp {
  readonly name: string
  readonly summary: string
  readonly input: Record<string, unknown>
}

/**
 * Load the table and register its tools.
 *
 * A broker that is down does not fail the profile: the plugin logs and registers nothing, so the
 * delegation still boots and the tools appear on the next reload, when the broker is up.
 */
export const apply = (ctx: HostContext, config: Config = {}): Promise<void> => {
  const endpoint = endpointOf(config)
  // An arrow, so the loader keeps the returned promise: tools exist when loading finishes.
  return registerTools(ctx, endpoint).catch((error: unknown) => {
    ctx.logger.warn(
      `host-ops: ${error instanceof Error ? error.message : String(error)}; no host tools this boot`,
    )
  })
}

/** Ask the broker for its table and register each operation. Exported for the tests. */
export async function registerTools(
  ctx: HostContext,
  endpoint: BrokerEndpoint,
): Promise<void> {
  const described = await callBroker(endpoint, 'ops.describe', {})
  const ops = JSON.parse(described) as unknown
  if (!Array.isArray(ops)) {
    throw new TypeError('the broker did not describe a table of operations')
  }
  for (const value of ops) {
    ctx.tools.register(toolFor(endpoint, asOp(value)))
  }
}

function endpointOf(config: Config): BrokerEndpoint {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('host-ops: timeoutMs must be a positive integer')
  }
  return {
    socketPath: config.socketPath ?? DEFAULT_SOCKET_PATH,
    timeoutMs,
  }
}

function toolFor(endpoint: BrokerEndpoint, op: DescribedOp): HostTool {
  return {
    name: op.name,
    description: op.summary,
    parameters: op.input,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: (args, exec) =>
      callBroker(
        endpoint,
        op.name,
        args as Record<string, unknown>,
        exec.signal,
      ),
  }
}

function asOp(value: unknown): DescribedOp {
  if (value === null || typeof value !== 'object') {
    throw new Error('the broker described an operation that is not an object')
  }
  const { name, summary, input } = value as Record<string, unknown>
  if (
    typeof name !== 'string' ||
    typeof summary !== 'string' ||
    input === null ||
    typeof input !== 'object'
  ) {
    throw new Error(
      'the broker described an operation without a name, summary or input',
    )
  }
  return { name, summary, input: input as Record<string, unknown> }
}
