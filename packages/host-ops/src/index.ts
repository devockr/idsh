/**
 * The agent-facing half: it asks the broker for its operation table at load time and registers one
 * dsh tool per operation, so the model sees the broker's own names and schemas.
 *
 * There is no shell here either: a tool call is one request to the broker, which validates the
 * arguments against the same schema and owns the audit line.
 */
import { DEFAULT_SOCKET_PATH, DEFAULT_STATE_PATH, DEFAULT_TIMEOUT_MS } from './constants.ts'
import { callBroker, type BrokerAnswer, type BrokerEndpoint } from './socket.ts'
import { startDeployJob, type Jobs } from './stream.ts'
import { isRecord, readField } from './values.ts'

/** The broker's own answer, narrowed where the tool runner hands it back untyped. */
const asAnswer = (value: unknown): BrokerAnswer => {
  if (!isRecord(value) || typeof value.text !== 'string') {
    throw new TypeError('the broker answered without text')
  }
  return { text: value.text, truncated: value.truncated === true }
}

/** A little longer than the broker's own deadline, so its answer, not ours, is the verdict. */
const OP_TIMEOUT_SLACK_MS = 5000

/** Operations whose log a job can follow: a build writes one, an update does not. */
let logSequence = 0

const FOLLOWS_BUILD_LOG = new Set(['deploy.build', 'deploy.main'])

/** The option that approves a destructive operation. */
const CONFIRM_OPTION = 'Run'

export const name = '@idsh/host-ops'
export const inject = ['tools', 'userQuestions']

export interface Config {
  /** Where the deployment mounts the broker's socket. */
  readonly socketPath?: string
  /** How long one call may take, in milliseconds. */
  readonly timeoutMs?: number
  /** Where the broker's state directory is mounted, so a deploy job can follow its build log. */
  readonly statePath?: string
  /** How often the broker's table is asked for again, in milliseconds; a minute by default. */
  readonly refreshMs?: number
}

interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

interface ToolExecution {
  readonly signal: AbortSignal
  /** The calling agent, forwarded to the question service so the card is scoped to it. */
  readonly agent?: unknown
  /** The tool call, so the question card attaches to its row and a job to its record. */
  readonly callId?: string
  readonly rootCallId?: string
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

/** The services this plugin consumes from its context. */
export interface Services {
  readonly jobs: Jobs
}

export interface HostContext {
  readonly tools: { register(tool: HostTool): () => void }
  /**
   * Cordis's read without the inject requirement: every plugin context has it, and it is how a
   * sibling-provided service — the job registry — is reached. Typed over the services this plugin
   * consumes, so a new dependency is named once here and the read is checked against it.
   */
  get<K extends keyof Services>(name: K): Services[K]
  /**
   * Cordis's lifecycle helper, optional so a test context can leave it out: the refresh timer is
   * registered through it, so the plugin's own disposal is what clears it.
   */
  readonly effect?: (run: () => () => void) => void
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
  /** The read-only operation that resolves what this one would do. */
  readonly preview?: string
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
export const apply = (ctx: HostContext, config: Config = {}): Promise<void> =>
  discover(ctx, config).catch((error: unknown) => {
    ctx.logger.warn(
      `host-ops: ${error instanceof Error ? error.message : String(error)}; no host tools this boot`,
    )
  })

/**
 * Validate the whole configuration, then register. A bad value rejects here — including `statePath`
 * — so the warning is true: nothing was registered this boot.
 */
async function discover(ctx: HostContext, config: Config): Promise<void> {
  const endpoint = endpointOf(config)
  const statePath = statePathOf(config)
  const table = await registerTools(ctx, endpoint, callBroker, statePath)
  if (typeof ctx.effect !== 'function') {
    return
  }
  // Asked again on a timer because the two sides have two lifecycles (#88's warning says so): a
  // broker upgrade used to need a container recreate even when the plugin itself had not changed.
  // The table is small, the call is one socket roundtrip, and an unchanged fingerprint registers
  // nothing, so the cost of the poll is a comparison.
  ctx.effect(() => {
    const timer = setInterval(() => {
      table.refresh().catch((error: unknown) => {
        ctx.logger.warn(
          `host-ops: re-reading the broker table failed: ${error instanceof Error ? error.message : String(error)}; keeping the tools it registered`,
        )
      })
    }, endpoint.refreshMs)
    // A timer must not hold the process open on its own.
    timer.unref()
    return () => {
      clearInterval(timer)
      table.dispose()
    }
  })
}

/** The caller the tools use; a test can pass a stub instead of waiting on a socket. */
type BrokerCaller = typeof callBroker

/** The registration: what it mounted, and how to refresh or drop it. */
export interface ToolTable {
  /** Re-read the broker's table; `true` when what is registered changed. */
  refresh(): Promise<boolean>
  /** Unregister everything this registration put in place. */
  dispose(): void
}

/**
 * Ask the broker for its table and register each operation, answering with the registration.
 *
 * Exported for the tests: they hand it a fake caller and then drive `refresh` and `dispose`
 * directly instead of waiting for the timer.
 */
export async function registerTools(
  ctx: HostContext,
  endpoint: BrokerEndpoint,
  call: BrokerCaller = callBroker,
  statePath: string | undefined = DEFAULT_STATE_PATH,
): Promise<ToolTable> {
  let warned = ''
  const load = async (): Promise<{ catalogue: DescribedOp[]; fingerprint: string }> => {
    // The argument is the negotiation: a broker new enough to answer with `{protocol, …}` does so
    // only for a client that declares one, and an older broker ignores it and sends the bare table.
    const described = await call(endpoint, 'ops.describe', { protocol: PROTOCOL })
    const parsed: unknown = JSON.parse(described.text)
    // A broker older than this plugin answers with the bare table: usable, but it cannot say which
    // arguments it takes beyond the ones in the entry, so the mismatch is worth one line in the log.
    const describedTable = isRecord(parsed) ? parsed : undefined
    const table: unknown = describedTable === undefined ? parsed : describedTable['ops']
    if (!Array.isArray(table)) {
      throw new TypeError('the broker did not describe a table of operations')
    }
    // The poll would otherwise repeat the same warning every minute; one table, one warning.
    const tableKey = JSON.stringify([describedTable?.['protocol'], describedTable?.['version']])
    if (tableKey !== warned) {
      warnProtocol(ctx, describedTable)
      warned = tableKey
    }
    // Build and validate the whole table first, then register: a bad entry leaves nothing behind.
    const catalogue = (table as unknown[]).map(value => asOp(value))
    // The preview is called before the confirmation gate, so an unknown name would fail the deploy
    // with an operation fault and a destructive one would run unasked.
    for (const op of catalogue) {
      if (op.preview === undefined) {
        continue
      }
      const preview = catalogue.find(candidate => candidate.name === op.preview)
      if (preview === undefined) {
        throw new Error(
          `host-ops: ${op.name} previews ${op.preview}, which the broker does not offer`,
        )
      }
      if (preview.confirm === true) {
        throw new Error(
          `host-ops: ${op.name} previews ${op.preview}, which itself needs confirmation`,
        )
      }
    }
    return { catalogue, fingerprint: JSON.stringify(catalogue) }
  }

  // Built and validated before anything is registered or dropped: a table with two operations on
  // one tool name must fail while the old tools are still mounted.
  const build = (catalogue: DescribedOp[]): HostTool[] => {
    const tools = catalogue.map(op => toolFor(ctx, endpoint, op, catalogue, call, statePath))
    const names = new Set<string>()
    for (const tool of tools) {
      if (names.has(tool.name)) {
        throw new Error(
          `host-ops: two operations map to the same tool name ${JSON.stringify(tool.name)}`,
        )
      }
      names.add(tool.name)
    }
    return tools
  }

  const register = (tools: readonly HostTool[]): Mounted[] => {
    const mounted: Mounted[] = []
    try {
      for (const tool of tools) {
        mounted.push({ dispose: ctx.tools.register(tool) })
      }
    } catch (error) {
      for (const one of mounted) {
        one.dispose()
      }
      throw error
    }
    return mounted
  }

  const mount = (catalogue: DescribedOp[]): Mounted[] => register(build(catalogue))

  let mounted: Mounted[] = []
  let fingerprint = ''
  let disposed = false
  // One refresh at a time: two overlapping reads could mount the older table over the newer one.
  let queue: Promise<unknown> = Promise.resolve()
  // Nothing is mounted until the table has loaded and validated, so a failure here leaves the
  // caller's warning ("no tools this boot") true.
  const first = await load()
  mounted = mount(first.catalogue)
  let previous = first.catalogue
  fingerprint = first.fingerprint

  const refreshOnce = async (): Promise<boolean> => {
    const next = await load()
    // A disposal that happened while the read was in flight must not be undone by a mount.
    if (disposed || next.fingerprint === fingerprint) {
      return false
    }
    // Validation happens before the old tools are touched, so a table that cannot even be built
    // (two operations on one tool name) leaves them mounted.
    const tools = build(next.catalogue)
    // The registry is keyed by tool name, so the new tools cannot be registered while the old
    // ones hold their names. Drop them first, and put them back if registering the new ones fails.
    for (const one of mounted) {
      one.dispose()
    }
    try {
      mounted = register(tools)
    } catch (error) {
      mounted = mount(previous)
      throw error
    }
    previous = next.catalogue
    fingerprint = next.fingerprint
    return true
  }

  return {
    refresh(): Promise<boolean> {
      const next = queue.then(() => refreshOnce())
      // The queue keeps going even when one read failed, so one bad poll does not stop the rest.
      queue = next.catch(() => undefined)
      return next
    },
    dispose(): void {
      disposed = true
      for (const one of mounted) {
        one.dispose()
      }
      mounted = []
      fingerprint = ''
    },
  }
}

/** What one registration put in place: the disposer Cordis handed back. */
interface Mounted {
  readonly dispose: () => void
}

function statePathOf(config: Config): string {
  const statePath = config.statePath ?? DEFAULT_STATE_PATH
  if (typeof statePath !== 'string' || statePath === '') {
    throw new Error('host-ops: statePath must be a non-empty string')
  }
  return statePath
}

function endpointOf(config: Config): BrokerEndpoint {
  const socketPath: unknown = config.socketPath ?? DEFAULT_SOCKET_PATH
  if (typeof socketPath !== 'string' || socketPath === '') {
    throw new Error('host-ops: socketPath must be a non-empty string')
  }
  const refreshMs = config.refreshMs ?? REFRESH_MS
  if (!Number.isInteger(refreshMs) || refreshMs < 1) {
    throw new Error('host-ops: refreshMs must be a positive integer')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('host-ops: timeoutMs must be a positive integer')
  }
  return { socketPath, timeoutMs, refreshMs }
}

/**
 * The model-facing tool name. Providers only accept `[a-zA-Z0-9_-]`, while an operation name is the
 * broker's own (`log.tail`); the tool calls the broker with the operation name it was given. The
 * `idsh_` prefix namespaces them, so a sanitized name such as `read` or `bash` cannot collide with
 * a built-in tool or another plugin's.
 */
/** Start one long operation as a job and return its id. */
function enqueueDeploy(
  ctx: HostContext,
  op: DescribedOp,
  args: Record<string, unknown>,
  exec: ToolExecution,
  call: BrokerCaller,
  endpoint: BrokerEndpoint,
  statePath: string,
): string {
  const jobs = ctx.get('jobs')
  // The call id names the log when the broker accepts it; anything else would be refused.
  const log =
    exec.callId !== undefined && /^[\w-]{1,64}$/u.test(exec.callId)
      ? exec.callId
      : `build-${String(Date.now())}${String(logSequence++)}`
  const agentId = readField(exec.agent, 'id')
  const agent = typeof agentId === 'string' ? { id: agentId } : undefined
  return startDeployJob(jobs, {
    name: op.name,
    args: { ...args, log },
    call,
    endpoint,
    statePath,
    logPath: `${statePath}/build-${log}.log`,
    ...(agent?.id === undefined ? {} : { owner: agent.id }),
    ...(exec.callId === undefined
      ? {}
      : {
          toolCall: {
            callId: exec.callId,
            rootCallId: exec.rootCallId ?? exec.callId,
          },
        }),
  })
}

function toolName(op: string): string {
  return `idsh_${op.replaceAll(/[^\w-]/gu, '_')}`
}

function toolFor(
  ctx: HostContext,
  endpoint: BrokerEndpoint,
  op: DescribedOp,
  ops: readonly DescribedOp[],
  call: BrokerCaller,
  statePath: string,
): HostTool {
  // A long operation says so; the tool call and the socket wait inherit it together. A preview
  // runs inside the same call on the synchronous path, so its budget is part of this one.
  const previewOp = ops.find(candidate => candidate.name === op.preview)
  const previewBudget = previewOp?.timeoutMs ?? 0
  const timeoutMs =
    op.timeoutMs === undefined ? undefined : op.timeoutMs + previewBudget + OP_TIMEOUT_SLACK_MS
  // The preview is its own operation with its own budget: resolving refs is not a build's wait.
  const previewEndpoint =
    previewOp?.timeoutMs === undefined
      ? endpoint
      : { ...endpoint, timeoutMs: previewOp.timeoutMs + OP_TIMEOUT_SLACK_MS }
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
        const answer = asAnswer(value)
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
      // The runner hands the arguments back untyped. Absent ones are an empty object; anything else
      // that is not an object is a caller error, and turning it into `{}` would hand the broker a
      // request nobody made.
      if (args !== undefined && args !== null && !isRecord(args)) {
        throw new TypeError('host-ops: arguments must be an object, not an array or a scalar')
      }
      const input = isRecord(args) ? args : {}
      const confirmation: Confirmation =
        op.confirm === true
          ? await confirmed(ctx, op, input, exec, () =>
              op.preview === undefined
                ? Promise.resolve(undefined)
                : call(previewEndpoint, op.preview, previewArgs(op, ops, input), exec.signal).then(
                    answer => answer.text,
                  ),
            )
          : { ok: true }
      if (confirmation.ok === false) {
        throw new Error(
          `host-ops: ${op.name} was not confirmed; the host was not touched` +
            (confirmation.reply === undefined
              ? ''
              : `; the person replied: ${JSON.stringify(confirmation.reply)}`),
        )
      }
      const endpointForCall = timeoutMs === undefined ? endpoint : { ...endpoint, timeoutMs }
      // A long operation is not enough: only a build with a per-build log can be followed. An
      // older broker declares no `log` and writes one shared file, so it stays synchronous.
      const properties = readField(op.input, 'properties')
      const supportsLog = isRecord(properties) && typeof properties['log'] === 'object'
      if (supportsLog && FOLLOWS_BUILD_LOG.has(op.name)) {
        const id = enqueueDeploy(ctx, op, input, exec, call, endpointForCall, statePath)
        return {
          text: `started ${id}: ${op.name} runs in the background; follow it with job_output`,
          truncated: false,
        }
      }
      return call(endpointForCall, op.name, input, exec.signal)
    },
  }
}

function asOp(value: unknown): DescribedOp {
  if (!isRecord(value)) {
    throw new Error('the broker described an operation that is not an object')
  }
  const { name, summary, input, confirm, preview, timeoutMs } = value
  if (typeof name !== 'string' || typeof summary !== 'string' || !isRecord(input)) {
    throw new Error('the broker described an operation without a name, summary or object input')
  }
  return {
    name,
    summary,
    input,
    ...(confirm === true ? { confirm: true } : {}),
    ...(typeof preview === 'string' && preview !== '' ? { preview } : {}),
    // The broker's per-operation budget travels with the operation; dropping it silently is how
    // a long build ends up waiting the default 15 seconds again.
    ...(typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0
      ? { timeoutMs }
      : {}),
  }
}

/**
 * The arguments a preview gets: the ones it declares, and which operation it resolves for.
 *
 * A build's own `log` is not a source argument, and handing it over would make the preview refuse a
 * request the build itself accepts.
 */
function previewArgs(
  op: DescribedOp,
  ops: readonly DescribedOp[],
  input: Record<string, unknown>,
): Record<string, unknown> {
  const preview = ops.find(candidate => candidate.name === op.preview)
  const properties = readField(preview?.input, 'properties')
  if (!isRecord(properties)) {
    return {}
  }
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    // `for` says which operation this answers for; a caller does not get to choose that.
    if (key !== 'for' && properties[key] !== undefined) {
      args[key] = value
    }
  }
  if (properties['for'] !== undefined) {
    args['for'] = op.name
  }
  return args
}

/** The protocol this plugin builds its tools from, and declares when it asks for the table. */
const PROTOCOL = 1

/**
 * How often the table is asked for again. A broker upgrade is rare; a minute of staleness after one
 * is the price of not needing a container recreate for a table that has not changed at all.
 */
const REFRESH_MS = 60_000

/**
 * Say so when the broker and this plugin are out of step.
 *
 * Two lifecycles produce the two sides — the plugin is baked into the image, the broker runs from
 * the deployment's checkout — so neither update drags the other along. A mismatch is not fatal (the
 * table is still readable), but silence is how a stale pair is discovered by its symptoms instead
 * of by its cause.
 */
function warnProtocol(ctx: HostContext, table: Record<string, unknown> | undefined): void {
  const protocol = table?.['protocol']
  const version = table?.['version']
  const broker = typeof version === 'string' && version !== '' ? `broker ${version}` : 'the broker'
  if (typeof protocol !== 'number') {
    ctx.logger.warn(
      `host-ops: ${broker} describes no protocol, so it is older than this plugin (protocol ${String(PROTOCOL)}); update it (broker.update) — the plugin re-reads the table every minute`,
    )
    return
  }
  if (protocol !== PROTOCOL) {
    ctx.logger.warn(
      `host-ops: ${broker} speaks protocol ${String(protocol)} but this plugin speaks ${String(PROTOCOL)}; the lower number is the older side — update it; the plugin re-reads the table every minute`,
    )
  }
}

/** The person's answer: Run, or the reply they typed instead of choosing. */
type Confirmation = { ok: false; reply?: string } | { ok: true }

/**
 * Ask the person before a destructive operation.
 *
 * The question is asked inside the tool call and blocks: the answer comes from the question
 * service, so the model cannot fabricate one. Only the explicit "Run" option approves; a typed
 * answer is a reply, passed back so the assistant can answer it and ask again.
 */
async function confirmed(
  ctx: HostContext,
  op: DescribedOp,
  args: Record<string, unknown>,
  exec: ToolExecution,
  resolve: () => Promise<string | undefined>,
): Promise<Confirmation> {
  // Resolve before asking: a question about "PR 82" is not a question about a commit, and a source
  // that cannot be resolved is an error the person should see instead of a prompt.
  const resolved = await resolve()
  // Blocks of text, not one formatted blob. `JSON.stringify` already answers whether there is
  // anything to show — an argument-free call is exactly the string `{}`, which reads like a
  // placeholder that failed to fill in — and a resolved source is a block of its own.
  const blocks = [`Run ${op.name} on the host?`]
  const shown = JSON.stringify(args)
  if (shown !== '{}') {
    blocks.push(shown)
  }
  if (resolved !== undefined) {
    blocks.push(resolved)
  }
  blocks.push(`Choose ${CONFIRM_OPTION} to proceed; a typed reply is not an approval.`)
  const answer = await ctx.userQuestions.ask({
    questions: [
      {
        id: 'confirm',
        header: 'Host operation',
        question: blocks.join('\n\n'),
        options: [{ label: CONFIRM_OPTION, description: op.summary }, { label: 'Cancel' }],
      },
    ],
    signal: exec.signal,
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    ...(exec.callId === undefined ? {} : { wait: { callId: exec.callId } }),
  })
  const item = answer.answers.find(entry => entry.id === 'confirm')
  if (item?.selected.includes(CONFIRM_OPTION) === true) {
    return { ok: true }
  }
  // A typed answer is the person asking something, not approving: pass it back so the assistant
  // can answer and ask again, and leave the host untouched.
  const reply = item?.custom?.trim()
  return reply === undefined || reply === '' ? { ok: false } : { ok: false, reply }
}
