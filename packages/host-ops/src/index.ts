/**
 * The agent-facing half: it asks the broker for its operation table at load time and registers one
 * dsh tool per operation, so the model sees the broker's own names and schemas.
 *
 * There is no shell here either: a tool call is one request to the broker, which validates the
 * arguments against the same schema and owns the audit line.
 */
import { DEFAULT_SOCKET_PATH, DEFAULT_TIMEOUT_MS } from './constants.ts'
import { callBroker, type BrokerAnswer, type BrokerEndpoint } from './socket.ts'

export const name = '@idsh/host-ops'
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
 * An arrow, so the loader keeps the returned promise: the tools exist when loading finishes. A
 * broker that is down does not fail the profile — the plugin logs and registers nothing, so the
 * delegation still boots and the tools appear on the next reload.
 */
export const apply = (ctx: HostContext, config: Config = {}): Promise<void> => {
  const endpoint = endpointOf(config)
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
  const ops = JSON.parse(described.text) as unknown
  if (!Array.isArray(ops)) {
    throw new TypeError('the broker did not describe a table of operations')
  }
  // Build and validate the whole table first, then register: a bad entry leaves nothing behind.
  const tools = ops.map(value => toolFor(endpoint, asOp(value)))
  const dispose: Array<() => void> = []
  try {
    for (const tool of tools) {
      dispose.push(ctx.tools.register(tool))
    }
  } catch (error) {
    for (const drop of dispose) {
      drop()
    }
    throw error
  }
}

function endpointOf(config: Config): BrokerEndpoint {
  const socketPath: unknown = config.socketPath ?? DEFAULT_SOCKET_PATH
  if (typeof socketPath !== 'string' || socketPath === '') {
    throw new Error('host-ops: socketPath must be a non-empty string')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('host-ops: timeoutMs must be a positive integer')
  }
  return { socketPath, timeoutMs }
}

function toolFor(endpoint: BrokerEndpoint, op: DescribedOp): HostTool {
  return {
    name: op.name,
    description: op.summary,
    parameters: op.input,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['text', 'truncated'],
      },
      render: (_args, value) => {
        const answer = value as BrokerAnswer
        return [
          {
            type: 'text',
            text: answer.truncated
              ? `${answer.text}\n[the host broker capped this answer at 64 KiB]`
              : answer.text,
          },
        ]
      },
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
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    throw new Error(
      'the broker described an operation without a name, summary or object input',
    )
  }
  return { name, summary, input: input as Record<string, unknown> }
}
