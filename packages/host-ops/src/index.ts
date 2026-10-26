/**
 * The agent-facing half: it asks the broker for its operation table at load time and registers one
 * dsh tool per operation, so the model sees the broker's own names and schemas.
 *
 * There is no shell here either: a tool call is one request to the broker, which validates the
 * arguments against the same schema and owns the audit line.
 */
import { DEFAULT_SOCKET_PATH, DEFAULT_TIMEOUT_MS } from './constants.ts'
import { callBroker, type BrokerAnswer, type BrokerEndpoint } from './socket.ts'

/** A little longer than the broker's own deadline, so its answer, not ours, is the verdict. */
const OP_TIMEOUT_SLACK_MS = 5000

export const name = '@idsh/host-ops'
export const inject = ['tools', 'userQuestions']

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
  /** The calling agent, forwarded to the question service so the card is scoped to it. */
  readonly agent?: unknown
  /** The tool call, so the question card attaches to its row. */
  readonly callId?: string
}

/** The slice of dsh a tool needs; structural, so this package imports no dsh code. */
export interface HostTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly timeoutMs?: number
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolExecution): Promise<unknown>
}

export interface Question {
  readonly id: string
  readonly header?: string
  readonly question: string
  readonly options?: ReadonlyArray<{
    readonly label: string
    readonly description?: string
  }>
}

export interface QuestionAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface HostContext {
  readonly tools: { register(tool: HostTool): () => void }
  readonly logger: { warn(message: string): void }
  readonly userQuestions: {
    ask(request: {
      questions: readonly Question[]
      signal?: AbortSignal
      agent?: unknown
      wait?: { callId: string }
    }): Promise<{ answers: readonly QuestionAnswer[] }>
  }
}

interface DescribedOp {
  readonly name: string
  readonly summary: string
  readonly input: Record<string, unknown>
  /** Destructive: ask the person before the broker is called. */
  readonly confirm?: boolean
  /** How long the broker may take; a build is minutes, not the client's default. */
  readonly timeoutMs?: number
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
  const tools = ops.map(value => toolFor(ctx, endpoint, asOp(value)))
  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(
        `host-ops: two operations map to the same tool name ${JSON.stringify(tool.name)}`,
      )
    }
    names.add(tool.name)
  }
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

/**
 * The model-facing tool name. Providers only accept `[a-zA-Z0-9_-]`, while an operation name is
 * the broker's own (`log.tail`); the tool calls the broker with the operation name it was given.
 * The `idsh_` prefix namespaces them, so a sanitized name such as `read` or `bash` cannot collide
 * with a built-in tool or another plugin's.
 */
function toolName(op: string): string {
  return `idsh_${op.replaceAll(/[^\w-]/gu, '_')}`
}

function toolFor(
  ctx: HostContext,
  endpoint: BrokerEndpoint,
  op: DescribedOp,
): HostTool {
  // A long operation says so; the tool call and the socket wait inherit it together.
  const timeoutMs =
    op.timeoutMs === undefined ? undefined : op.timeoutMs + OP_TIMEOUT_SLACK_MS
  return {
    name: toolName(op.name),
    description: op.summary,
    parameters: op.input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
              ? `${answer.text}\n[the host broker capped this answer]`
              : answer.text,
          },
        ]
      },
    },
    async execute(args, exec) {
      if (op.confirm === true && !(await confirmed(ctx, op, args, exec))) {
        throw new Error(
          `host-ops: ${op.name} was not confirmed; the host was not touched`,
        )
      }
      return callBroker(
        timeoutMs === undefined ? endpoint : { ...endpoint, timeoutMs },
        op.name,
        args as Record<string, unknown>,
        exec.signal,
      )
    },
  }
}

function asOp(value: unknown): DescribedOp {
  if (value === null || typeof value !== 'object') {
    throw new Error('the broker described an operation that is not an object')
  }
  const { name, summary, input, confirm } = value as Record<string, unknown>
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
  return {
    name,
    summary,
    input: input as Record<string, unknown>,
    ...(confirm === true ? { confirm: true } : {}),
  }
}

/**
 * Ask the person before a destructive operation.
 *
 * The question is asked inside the tool call and blocks: the answer comes from the question
 * service, so the model cannot fabricate one. Anything other than the explicit "Run" option —
 * cancel, a skipped question, an empty answer — means no.
 */
async function confirmed(
  ctx: HostContext,
  op: DescribedOp,
  args: unknown,
  exec: ToolExecution,
): Promise<boolean> {
  const answer = await ctx.userQuestions.ask({
    questions: [
      {
        id: 'confirm',
        header: 'Host operation',
        question: `Run ${op.name} on the host?\n\n${JSON.stringify(args)}`,
        options: [
          { label: 'Run', description: op.summary },
          { label: 'Cancel' },
        ],
      },
    ],
    signal: exec.signal,
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    ...(exec.callId === undefined ? {} : { wait: { callId: exec.callId } }),
  })
  const item = answer.answers.find(entry => entry.id === 'confirm')
  return item?.selected.includes('Run') === true
}
