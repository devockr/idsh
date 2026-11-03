import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { apply, registerTools, type Config, type HostContext, type HostTool } from '../src/index.ts'
import { type BrokerAnswer } from '../src/socket.ts'
import { buildLogSource, startDeployJob, type JobSpec, type Jobs } from '../src/stream.ts'
import { fakeBroker } from './server.ts'

// The plugin adds its own slack to an operation's declared budget; keep both numbers named.
const SLACK_MS = 5_000
const OP_TIMEOUT_MS = 900_000
const TOOL_TIMEOUT_MS = OP_TIMEOUT_MS + SLACK_MS
const SHORT_OP_TIMEOUT_MS = 200
const SHORT_TOOL_TIMEOUT_MS = SHORT_OP_TIMEOUT_MS + SLACK_MS
/** Bounded wait for a condition a timer will satisfy, so a slow machine does not fail the test. */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_WINDOW_MS
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** The most a timer-driven assertion waits before giving up. */
const POLL_WINDOW_MS = 2_000

/** A number that is not a whole number of milliseconds, for the interval validation. */
const FRACTIONAL_MS = 1.5

/** Long enough for the initial read, short enough that a stalled refresh fails within the test. */
const STALL_TIMEOUT_MS = 200

const TABLE = [
  {
    name: 'log.tail',
    summary: 'The last lines of a host log.',
    input: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'disk.usage',
    summary: 'df -h.',
    input: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const DEFAULT_JOBS: Jobs = {
  start() {
    throw new Error('this test does not expect a background job')
  },
}

function context(
  selected: readonly string[] = ['Run'],
  custom?: string,
  jobs: Jobs = DEFAULT_JOBS,
): {
  ctx: HostContext
  tools: HostTool[]
  warnings: string[]
  asks: Array<Record<string, unknown>>
} {
  const tools: HostTool[] = []
  const warnings: string[] = []
  const asks: Array<Record<string, unknown>> = []
  return {
    tools,
    warnings,
    asks,
    ctx: {
      tools: {
        register(tool) {
          // dsh's registry is keyed by name and refuses a second registration with one, so the
          // harness must too: a refresh that mounts before it disposes would pass here otherwise.
          if (tools.some(one => one.name === tool.name)) {
            throw new Error(`tool "${tool.name}" is already registered`)
          }
          tools.push(tool)
          // Cordis hands back a disposer; the harness has to honour it, or a refresh looks like a
          // duplicate registration.
          return () => {
            const at = tools.indexOf(tool)
            if (at >= 0) {
              tools.splice(at, 1)
            }
          }
        },
      },
      logger: {
        warn(message) {
          warnings.push(message)
        },
      },
      userQuestions: {
        ask: (request: Record<string, unknown>) => {
          asks.push(request)
          return Promise.resolve({
            answers: [
              {
                id: 'confirm',
                selected,
                ...(custom === undefined ? {} : { custom }),
              },
            ],
          })
        },
      },
      // Cordis serves a service through `get`, never as a property of the plugin's context.
      get(name: string): Jobs {
        assert.equal(name, 'jobs')
        return jobs
      },
    },
  }
}

/** A context that provides the job registry, as a deployment does. */
function withJobs(ctx: HostContext, jobs: Jobs): HostContext {
  return {
    ...ctx,
    get: (name: string): Jobs => {
      assert.equal(name, 'jobs')
      return jobs
    },
  }
}

void test('the broker table becomes one tool per operation', async () => {
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(TABLE) })}\n`
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? describe
      : `${JSON.stringify({ ok: true, result: 'answer' })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await registerTools(ctx, { socketPath: broker.socketPath })
    assert.deepEqual(
      tools.map(tool => tool.name),
      ['idsh_log_tail', 'idsh_disk_usage'],
    )
    assert.deepEqual(tools[0]?.parameters, TABLE[0]?.input)
    // The declaration that earns the envelope, and the only reason an old broker answers with the
    // bare table instead: pin it, or a regression turns every boot into a false "older broker".
    assert.deepEqual(broker.requests[0], { op: 'ops.describe', args: { protocol: 1 } })
    const result = await tools[0]?.execute(
      { file: 'messages' },
      { signal: new AbortController().signal },
    )
    assert.deepEqual(result, { text: 'answer', truncated: false })
    const rendered = tools[0].output.render({}, { text: 'answer', truncated: true })
    assert.match(rendered[0].text, /capped this answer/u)
    assert.deepEqual(broker.requests.at(-1), {
      op: 'log.tail',
      args: { file: 'messages' },
    })
  } finally {
    await broker.close()
  }
})

void test('a broker that is down warns and registers no tools', async () => {
  const { ctx, tools, warnings } = context()
  await apply(ctx, { socketPath: '/nonexistent/idsh-host/host.sock' })
  assert.deepEqual(tools, [])
  assert.equal(warnings.length, 1)
})

void test('a table that is not an array registers nothing', async () => {
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify({ nope: true }) })}\n`,
  )
  try {
    const { ctx, tools, warnings } = context()
    await apply(ctx, { socketPath: broker.socketPath })
    assert.deepEqual(tools, [])
    assert.match(warnings[0] ?? '', /did not describe a table/u)
  } finally {
    await broker.close()
  }
})

void test('an operation whose schema is an array is refused', async () => {
  const table = [{ ...TABLE[0], input: [] }]
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await assert.rejects(registerTools(ctx, { socketPath: broker.socketPath }), /object input/u)
    assert.deepEqual(tools, [])
  } finally {
    await broker.close()
  }
})

void test('a bad entry rejects the whole table', async () => {
  const table = [TABLE[0], { name: 'broken' }]
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await assert.rejects(registerTools(ctx, { socketPath: broker.socketPath }))
    assert.deepEqual(tools, [])
  } finally {
    await broker.close()
  }
})

void test('a tool call whose arguments are not an object is refused', async () => {
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify(TABLE) })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await registerTools(ctx, { socketPath: broker.socketPath })
    for (const invalid of ['not-an-object', []]) {
      await assert.rejects(
        tools[0].execute(invalid, { signal: new AbortController().signal }),
        /arguments must be an object/u,
      )
    }
  } finally {
    await broker.close()
  }
})

void test('a job whose arguments are an array fails before the call', async () => {
  let reached = false
  const started: JobSpec[] = []
  const jobs = {
    start(spec: JobSpec) {
      started.push(spec)
      return 'job-1'
    },
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'host-ops-guard-'))
  startDeployJob(jobs, {
    name: 'deploy.build',
    args: [],
    endpoint: { socketPath: path.join(dir, 'host.sock') },
    statePath: dir,
    logPath: path.join(dir, 'build.log'),
    call: () => {
      reached = true
      return Promise.resolve({ text: 'built', truncated: false })
    },
  })
  const spec = started[0]
  assert.ok(spec !== undefined)
  const outcome = await spec.run({ append: () => undefined }).done
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.detail), /object arguments/u)
  assert.equal(reached, false)
  await rm(dir, { recursive: true, force: true })
})

void test('a job whose arguments are not an object fails before the call', async () => {
  let reached = false
  const started: JobSpec[] = []
  const jobs = {
    start(spec: JobSpec) {
      started.push(spec)
      return 'job-1'
    },
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'host-ops-guard-'))
  startDeployJob(jobs, {
    name: 'deploy.build',
    args: 'not-an-object',
    endpoint: { socketPath: path.join(dir, 'host.sock') },
    statePath: dir,
    logPath: path.join(dir, 'build.log'),
    call: () => {
      reached = true
      return Promise.resolve({ text: 'built', truncated: false })
    },
  })
  const spec = started[0]
  assert.ok(spec !== undefined)
  const hooks = spec.run({ append: () => undefined })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.detail), /object arguments/u)
  assert.equal(reached, false)
  await rm(dir, { recursive: true, force: true })
})

void test('a bad config registers nothing and warns', async () => {
  const bad = context()
  await apply(bad.ctx, { socketPath: {} } as Config)
  assert.deepEqual(bad.tools, [])
  assert.match(bad.warnings[0] ?? '', /socketPath must be a non-empty string/u)

  const alsoBad = context()
  await apply(alsoBad.ctx, { timeoutMs: 0 })
  assert.deepEqual(alsoBad.tools, [])
  assert.match(alsoBad.warnings[0] ?? '', /timeoutMs must be a positive integer/u)

  // statePath is part of the same contract now: an invalid one registers no tools either.
  const stateBad = context()
  await apply(stateBad.ctx, { statePath: '' })
  assert.deepEqual(stateBad.tools, [])
  assert.match(stateBad.warnings[0] ?? '', /statePath must be a non-empty string/u)
})

void test('a registration that fails rolls back the ones already made', async () => {
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(TABLE) })}\n`
  const broker = await fakeBroker(() => describe)
  const disposed: string[] = []
  const tools: string[] = []
  const ctx: HostContext = {
    tools: {
      register(tool) {
        if (tools.length === 1) {
          throw new Error('registry is full')
        }
        tools.push(tool.name)
        return () => {
          disposed.push(tool.name)
        }
      },
    },
    logger: { warn: () => true },
    get: () => DEFAULT_JOBS,
    userQuestions: {
      ask: () => Promise.resolve({ answers: [{ id: 'confirm', selected: [] }] }),
    },
  }
  try {
    await assert.rejects(registerTools(ctx, { socketPath: broker.socketPath }), /registry is full/u)
    assert.deepEqual(tools, ['idsh_log_tail'])
    assert.deepEqual(disposed, ['idsh_log_tail'])
  } finally {
    await broker.close()
  }
})

void test('two operations that map to the same tool name register nothing', async () => {
  const table = [TABLE[0], { ...TABLE[1], name: 'log/tail' }]
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await assert.rejects(registerTools(ctx, { socketPath: broker.socketPath }), /same tool name/u)
    assert.deepEqual(tools, [])
  } finally {
    await broker.close()
  }
})

void test('a table entry that is not an object rejects the table', async () => {
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify([null]) })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await assert.rejects(registerTools(ctx, { socketPath: broker.socketPath }), /not an object/u)
    assert.deepEqual(tools, [])
  } finally {
    await broker.close()
  }
})

void test('a destructive operation asks before it calls the broker', async () => {
  const table = [
    {
      name: 'deploy.recreate',
      summary: 'Recreate the container.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
    },
  ]
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`,
  )
  try {
    const cancelled = context(['Cancel'])
    await registerTools(cancelled.ctx, { socketPath: broker.socketPath })
    const agent = { session: 'test-session' }
    await assert.rejects(
      cancelled.tools[0].execute(
        {},
        { signal: new AbortController().signal, agent, callId: 'call-1' },
      ),
      /was not confirmed/u,
    )
    assert.equal(cancelled.asks[0]?.agent, agent)
    assert.deepEqual(cancelled.asks[0]?.wait, { callId: 'call-1' })
    // An operation with no arguments says so by saying nothing: `{}` reads like a placeholder that
    // failed to fill in.
    const asked = cancelled.asks[0]?.['questions'] as Array<{ question: string }> | undefined
    const question = asked?.[0]?.question ?? ''
    assert.equal(
      question,
      'Run deploy.recreate on the host?\n\nChoose Run to proceed; a typed reply is not an approval.',
    )
    assert.deepEqual(
      broker.requests.map(request => request.op),
      ['ops.describe'],
    )

    const accepted = context(['Run'])
    await registerTools(accepted.ctx, { socketPath: broker.socketPath })
    const answer = await accepted.tools[0].execute({}, { signal: new AbortController().signal })
    assert.deepEqual(answer, { text: JSON.stringify(table), truncated: false })
    assert.deepEqual(
      broker.requests.map(request => request.op),
      ['ops.describe', 'ops.describe', 'deploy.recreate'],
    )
  } finally {
    await broker.close()
  }
})

void test('an operation with its own timeout sets the tool and the wait', async () => {
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
      timeoutMs: OP_TIMEOUT_MS,
    },
  ]
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await registerTools(ctx, { socketPath: broker.socketPath })
    // The broker's budget plus the slack the plugin adds, on the tool and on the socket wait.
    assert.equal(tools[0]?.timeoutMs, TOOL_TIMEOUT_MS)
  } finally {
    await broker.close()
  }
})

void test('execute passes the operation timeout to the caller', async () => {
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
      timeoutMs: SHORT_OP_TIMEOUT_MS,
    },
  ]
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`
  const broker = await fakeBroker(request => (request.op === 'ops.describe' ? describe : null))
  const calls: Array<{ timeoutMs?: number }> = []
  const call = (
    endpoint: { timeoutMs?: number },
    op: string,
  ): Promise<{ text: string; truncated: boolean }> => {
    // The table itself goes through the injected caller now, so only the op is answered this way.
    if (op === 'ops.describe') {
      return Promise.resolve({ text: JSON.stringify(table), truncated: false })
    }
    calls.push(endpoint)
    return Promise.reject(new Error(`did not answer within ${String(endpoint.timeoutMs)} ms`))
  }
  try {
    const { ctx, tools } = context(['Run'])
    await registerTools(ctx, { socketPath: broker.socketPath }, call)
    await assert.rejects(
      tools[0].execute({}, { signal: new AbortController().signal }),
      new RegExp(`did not answer within ${String(SHORT_TOOL_TIMEOUT_MS)} ms`, 'u'),
    )
    assert.equal(calls[0]?.timeoutMs, SHORT_TOOL_TIMEOUT_MS)
  } finally {
    await broker.close()
  }
})

void test('a typed answer is a reply, not a confirmation', async () => {
  const table = [
    {
      name: 'deploy.recreate',
      summary: 'Recreate.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
    },
  ]
  const describe = JSON.stringify({ ok: true, result: JSON.stringify(table) })
  const refused = JSON.stringify({
    ok: false,
    error: { code: 'unavailable', message: 'stub says no' },
  })

  const run = async (selected: string[], custom?: string) => {
    const { ctx, tools } = context(selected, custom)
    const broker = await fakeBroker(request =>
      request.op === 'ops.describe' ? `${describe}\n` : `${refused}\n`,
    )
    try {
      await registerTools(ctx, { socketPath: broker.socketPath })
      return await tools[0].execute({}, { signal: new AbortController().signal })
    } finally {
      await broker.close()
    }
  }

  // The option confirms; the broker's own refusal is what comes back.
  await assert.rejects(run(['Run']), /stub says no/u)
  // A question is not an approval: it is passed back so the assistant can answer it.
  await assert.rejects(
    run([], 'What does this touch?'),
    /not confirmed; the host was not touched; the person replied: "What does this touch\?"/u,
  )
  // An empty answer says nothing at all.
  await assert.rejects(
    run([]),
    /host-ops: deploy\.recreate was not confirmed; the host was not touched$/u,
  )
})

void test('a deploy runs as a job that follows the broker build log', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'idsh-host-ops-job-'))
  const logPath = path.join(host, 'build-call-1.log')
  await writeFile(logPath, 'step 1\n')
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build main.',
      input: {
        type: 'object',
        properties: { log: { type: 'string' } },
        additionalProperties: false,
      },
      confirm: true,
      timeoutMs: 900_000,
    },
    {
      name: 'broker.update',
      summary: 'Update the broker.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
      timeoutMs: 900_000,
    },
  ]
  const describe = JSON.stringify({ ok: true, result: JSON.stringify(table) })
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? `${describe}\n`
      : `${JSON.stringify({ ok: true, result: 'built main' })}\n`,
  )
  try {
    const built = context()
    const started: JobSpec[] = []
    const ctx = withJobs(built.ctx, {
      start(spec: JobSpec) {
        started.push(spec)
        return 'deploy-1'
      },
    })
    await registerTools(ctx, { socketPath: broker.socketPath }, undefined, host)
    const answer = await built.tools[0].execute(
      {},
      {
        signal: new AbortController().signal,
        agent: { id: 'ses_abc' },
        callId: 'call-1',
      },
    )
    assert.ok(typeof answer === 'object' && answer !== null && 'text' in answer)
    assert.ok(typeof answer.text === 'string')
    assert.match(answer.text, /started deploy-1/u)

    const spec = started[0]
    assert.equal(spec.kind, 'deploy')
    assert.equal(spec.owner, 'ses_abc')
    assert.deepEqual(spec.toolCall, { callId: 'call-1', rootCallId: 'call-1' })
    assert.match(spec.label, /^deploy\.build /u)

    // The source starts where the file was, so an earlier build is not replayed.
    const source = spec.output?.[0]
    assert.ok(source !== undefined)
    await writeFile(logPath, 'step 1\nstep 2\n')
    const read = source.read(0)
    assert.match(read.text, /step 2/u)
    assert.doesNotMatch(read.text, /step 1/u)
    // The cursor moves: no re-send of what was already read, and a later line is the next delta.
    assert.equal(source.read(read.nextOffset).text, '')
    await writeFile(logPath, 'step 1\nstep 2\nstep 3\n')
    assert.match(source.read(read.nextOffset).text, /step 3/u)

    const hooks = spec.run({
      append() {
        // the source is pulled by the registry, not pushed by the producer
      },
    })
    // broker.update takes minutes too, but writes no log: it must stay synchronous.
    const update = built.tools.find(tool => tool.name === 'idsh_broker_update')
    assert.ok(update !== undefined)
    await update.execute({}, { signal: new AbortController().signal })
    assert.equal(started.length, 1)

    const outcome = await hooks.done
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.result, 'built main')
  } finally {
    await broker.close()
    await rm(host, { recursive: true, force: true })
  }
})

void test('a refused deploy job fails with the broker reason', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'idsh-host-ops-job-'))
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build main.',
      input: {
        type: 'object',
        properties: { log: { type: 'string' } },
        additionalProperties: false,
      },
      confirm: true,
      timeoutMs: 900_000,
    },
  ]
  const describe = JSON.stringify({ ok: true, result: JSON.stringify(table) })
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? `${describe}\n`
      : `${JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'stub says no' } })}\n`,
  )
  try {
    const built = context()
    const started: JobSpec[] = []
    const ctx = withJobs(built.ctx, {
      start(spec: JobSpec) {
        started.push(spec)
        return 'deploy-1'
      },
    })
    await registerTools(ctx, { socketPath: broker.socketPath }, undefined, host)
    await built.tools[0].execute({}, { signal: new AbortController().signal })
    const hooks = started[0].run({
      append() {
        // the source is pulled by the registry, not pushed by the producer
      },
    })
    const outcome = await hooks.done
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.detail ?? '', /stub says no/u)
  } finally {
    await broker.close()
    await rm(host, { recursive: true, force: true })
  }
})

void test('a cancelled deploy job settles killed', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'idsh-host-ops-job-'))
  const table = [
    {
      name: 'deploy.main',
      summary: 'Deploy main.',
      input: {
        type: 'object',
        properties: { log: { type: 'string' } },
        additionalProperties: false,
      },
      confirm: true,
      timeoutMs: 900_000,
    },
  ]
  const describe = JSON.stringify({ ok: true, result: JSON.stringify(table) })
  // The op never answers; the kill aborts the client call.
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe' ? `${describe}\n` : null,
  )
  try {
    const built = context()
    const started: JobSpec[] = []
    const ctx = withJobs(built.ctx, {
      start(spec: JobSpec) {
        started.push(spec)
        return 'deploy-1'
      },
    })
    await registerTools(ctx, { socketPath: broker.socketPath }, undefined, host)
    await built.tools[0].execute({}, { signal: new AbortController().signal })
    const hooks = started[0].run({
      append() {
        // the source is pulled by the registry, not pushed by the producer
      },
    })
    hooks.cancel()
    const outcome = await hooks.done
    assert.equal(outcome.status, 'killed')
    assert.match(outcome.detail ?? '', /cancelled/u)
  } finally {
    await broker.close()
    await rm(host, { recursive: true, force: true })
  }
})

void test('apply carries the configured state path into the job', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'idsh-host-ops-job-'))
  await writeFile(path.join(host, 'build-call-1.log'), 'history\n')
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build main.',
      input: {
        type: 'object',
        properties: { log: { type: 'string' } },
        additionalProperties: false,
      },
      confirm: true,
      timeoutMs: 900_000,
    },
  ]
  const describe = JSON.stringify({ ok: true, result: JSON.stringify(table) })
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? `${describe}\n`
      : `${JSON.stringify({ ok: true, result: 'done' })}\n`,
  )
  try {
    const built = context()
    const started: JobSpec[] = []
    const ctx = withJobs(built.ctx, {
      start(spec: JobSpec) {
        started.push(spec)
        return 'deploy-1'
      },
    })
    await apply(ctx, { socketPath: broker.socketPath, statePath: host })
    await built.tools[0].execute({}, { signal: new AbortController().signal })
    const source = started[0].output?.[0]
    assert.ok(source !== undefined)
    // The configured directory is where the baseline came from: its history is not replayed.
    assert.equal(source.read(0).text, '')
  } finally {
    await broker.close()
    await rm(host, { recursive: true, force: true })
  }
})

void test('a multibyte character split across reads arrives whole', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'idsh-host-ops-decoder-'))
  const logPath = path.join(host, 'build-call-1.log')
  await writeFile(logPath, '')
  try {
    const source = buildLogSource(logPath)
    // "中" is three bytes; the first poll sees only the first two.
    const encoded = Buffer.from('中')
    await writeFile(logPath, encoded.subarray(0, 2))
    assert.equal(source.read(0).text, '')
    await writeFile(logPath, encoded)
    assert.equal(source.read(2).text, '中')
  } finally {
    await rm(host, { recursive: true, force: true })
  }
})

void test('a call id the broker would reject is replaced by a safe log name', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'idsh-host-ops-job-'))
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build main.',
      input: {
        type: 'object',
        properties: { log: { type: 'string' } },
        additionalProperties: false,
      },
      confirm: true,
      timeoutMs: 900_000,
    },
  ]
  const describe = JSON.stringify({ ok: true, result: JSON.stringify(table) })
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? `${describe}\n`
      : `${JSON.stringify({ ok: true, result: 'done' })}\n`,
  )
  try {
    const built = context()
    const started: JobSpec[] = []
    const ctx = withJobs(built.ctx, {
      start(spec: JobSpec) {
        started.push(spec)
        return 'deploy-1'
      },
    })
    await registerTools(ctx, { socketPath: broker.socketPath }, undefined, host)
    // A dot is not a broker-safe log id, so the plugin must not forward it.
    await built.tools[0].execute({}, { signal: new AbortController().signal, callId: 'call.1' })
    const spec = started[0]
    // The safe name is what the label's arguments carry, since that is what the broker sees.
    const log = (JSON.parse(spec.label.slice('deploy.build '.length)) as { log: string }).log
    assert.match(log, /^build-[A-Za-z0-9]+$/u)
    assert.doesNotMatch(log, /call\.1/u)
  } finally {
    await broker.close()
    await rm(host, { recursive: true, force: true })
  }
})

void test('a broker without the log argument stays synchronous', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'idsh-host-ops-job-'))
  await writeFile(path.join(host, 'build.log'), 'history\n')
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build main.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
      timeoutMs: 900_000,
    },
  ]
  const describe = JSON.stringify({ ok: true, result: JSON.stringify(table) })
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? `${describe}\n`
      : `${JSON.stringify({ ok: true, result: 'done' })}\n`,
  )
  try {
    const built = context()
    const started: JobSpec[] = []
    const ctx = withJobs(built.ctx, {
      start(spec: JobSpec) {
        started.push(spec)
        return 'deploy-1'
      },
    })
    await registerTools(ctx, { socketPath: broker.socketPath }, undefined, host)
    await built.tools[0].execute({}, { signal: new AbortController().signal, callId: 'call-1' })
    // No per-build log to follow, so an old broker stays synchronous: no job, the answer is the call.
    assert.deepEqual(started, [])
  } finally {
    await broker.close()
    await rm(host, { recursive: true, force: true })
  }
})

void test('an operation with a preview is asked about what it resolved', async () => {
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: {
        type: 'object',
        properties: { pr: { type: 'integer' } },
        additionalProperties: false,
      },
      confirm: true,
      preview: 'deploy.source',
    },
    {
      name: 'deploy.source',
      summary: 'Resolve the source.',
      input: {
        type: 'object',
        properties: { pr: { type: 'integer' }, sha: { type: 'string' }, for: { type: 'string' } },
        additionalProperties: false,
      },
      timeoutMs: OP_TIMEOUT_MS,
    },
  ]
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`
  const broker = await fakeBroker(request => {
    if (request.op === 'ops.describe') {
      return describe
    }
    if (request.op === 'deploy.source') {
      return `${JSON.stringify({ ok: true, result: 'pr 82 at aaaaaaa; main at bbbbbbb' })}\n`
    }
    return `${JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'never ran' } })}\n`
  })
  try {
    const { ctx, tools, asks } = context(['Run'])
    await registerTools(ctx, { socketPath: broker.socketPath })
    await assert.rejects(
      tools[0].execute({ pr: 82 }, { signal: new AbortController().signal }),
      /never ran/u,
    )
    // Resolved first, then asked, then run.
    assert.deepEqual(
      broker.requests.map(request => request.op),
      ['ops.describe', 'deploy.source', 'deploy.build'],
    )
    assert.equal(asks.length, 1)
    const source = broker.requests.find(request => request.op === 'deploy.source')
    assert.deepEqual(source?.args, { pr: 82, for: 'deploy.build' })
    const asked = asks[0]?.['questions'] as Array<{ question: string }> | undefined
    const question = asked?.[0]?.question ?? ''
    assert.match(question, /pr 82 at aaaaaaa; main at bbbbbbb/u)
    // The other half of the branch: an operation that does have arguments still shows them.
    assert.match(question, /\{"pr":82\}/u)
  } finally {
    await broker.close()
  }
})

void test('an unresolvable preview is an error, not a question', async () => {
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
      preview: 'deploy.source',
    },
    {
      name: 'deploy.source',
      summary: 'Resolve the source.',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? describe
      : `${JSON.stringify({ ok: false, error: { code: 'bad-argument', message: 'no such PR' } })}\n`,
  )
  try {
    const { ctx, tools, asks } = context(['Run'])
    await registerTools(ctx, { socketPath: broker.socketPath })
    await assert.rejects(
      tools[0].execute({ pr: 82 }, { signal: new AbortController().signal }),
      /no such PR/u,
    )
    // Nothing was asked, and the operation itself was never called.
    assert.equal(asks.length, 0)
    assert.deepEqual(
      broker.requests.map(request => request.op),
      ['ops.describe', 'deploy.source'],
    )
  } finally {
    await broker.close()
  }
})

void test('the preview does not see arguments its operation does not accept', async () => {
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: {
        type: 'object',
        properties: { note: { type: 'string' } },
        additionalProperties: false,
      },
      confirm: true,
      preview: 'deploy.source',
    },
    {
      name: 'deploy.source',
      summary: 'Resolve the source.',
      input: {
        type: 'object',
        properties: { pr: { type: 'integer' }, sha: { type: 'string' }, for: { type: 'string' } },
        additionalProperties: false,
      },
      timeoutMs: OP_TIMEOUT_MS,
    },
  ]
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`
  const broker = await fakeBroker(request => {
    if (request.op === 'ops.describe') {
      return describe
    }
    if (request.op === 'deploy.source') {
      return `${JSON.stringify({ ok: true, result: 'PR #82 at aaaaaaa; main at bbbbbbb' })}\n`
    }
    return `${JSON.stringify({ ok: true, result: 'built' })}\n`
  })
  try {
    const { ctx, tools } = context(['Run'])
    await registerTools(ctx, { socketPath: broker.socketPath })
    const built = tools.find(tool => tool.name === 'idsh_deploy_build')
    await built?.execute({ pr: 82, note: 'call-1' }, { signal: new AbortController().signal })
    const source = broker.requests.find(request => request.op === 'deploy.source')
    // `note` is the build's own argument; a preview that received it would refuse the request.
    assert.deepEqual(source?.args, { pr: 82, for: 'deploy.build' })
    const build = broker.requests.find(request => request.op === 'deploy.build')
    assert.deepEqual(build?.args, { pr: 82, note: 'call-1' })
  } finally {
    await broker.close()
  }
})

void test('a missing or destructive preview is refused at registration', async () => {
  const missing = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
      preview: 'deploy.source',
    },
  ]
  const destructive = [
    ...missing,
    {
      name: 'deploy.source',
      summary: 'Resolve the source.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
    },
  ]
  for (const [table, message] of [
    [missing, /previews deploy\.source, which the broker does not offer/u],
    [destructive, /previews deploy\.source, which itself needs confirmation/u],
  ] as const) {
    const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`
    const broker = await fakeBroker(() => describe)
    try {
      const { ctx } = context()
      await assert.rejects(registerTools(ctx, { socketPath: broker.socketPath }), message)
    } finally {
      await broker.close()
    }
  }
})

void test('the preview is called with its own budget, not the default', async () => {
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: {
        type: 'object',
        properties: { pr: { type: 'integer' } },
        additionalProperties: false,
      },
      confirm: true,
      preview: 'deploy.source',
      timeoutMs: OP_TIMEOUT_MS,
    },
    {
      name: 'deploy.source',
      summary: 'Resolve the source.',
      input: {
        type: 'object',
        properties: { pr: { type: 'integer' }, for: { type: 'string' } },
        additionalProperties: false,
      },
      timeoutMs: SHORT_OP_TIMEOUT_MS,
    },
  ]
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`
  const broker = await fakeBroker(() => describe)
  const budgets: Array<{ op: string; timeoutMs?: number }> = []
  const call = (
    endpoint: { timeoutMs?: number },
    op: string,
  ): Promise<{ text: string; truncated: boolean }> => {
    if (op === 'ops.describe') {
      return Promise.resolve({ text: JSON.stringify(table), truncated: false })
    }
    budgets.push({
      op,
      ...(endpoint.timeoutMs === undefined ? {} : { timeoutMs: endpoint.timeoutMs }),
    })
    return Promise.resolve({ text: '', truncated: false })
  }
  try {
    const { ctx, tools } = context(['Run'])
    await registerTools(ctx, { socketPath: broker.socketPath }, call)
    await tools
      .find(tool => tool.name === 'idsh_deploy_build')
      ?.execute({ pr: 82 }, { signal: new AbortController().signal })
    // The preview's budget plus the plugin's slack, not the build's.
    const preview = budgets.find(entry => entry.op === 'deploy.source')
    assert.equal(preview?.timeoutMs, SHORT_OP_TIMEOUT_MS + SLACK_MS)
  } finally {
    await broker.close()
  }
})

void test('a previewed operation gets the preview budget on top of its own', async () => {
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      confirm: true,
      preview: 'deploy.source',
      timeoutMs: OP_TIMEOUT_MS,
    },
    {
      name: 'deploy.source',
      summary: 'Resolve the source.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: SHORT_OP_TIMEOUT_MS,
    },
  ]
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`
  const broker = await fakeBroker(() => describe)
  try {
    const { ctx, tools } = context()
    await registerTools(ctx, { socketPath: broker.socketPath })
    // On the synchronous path the preview runs inside the call, so its budget is part of the tool's.
    assert.equal(tools[0]?.timeoutMs, OP_TIMEOUT_MS + SHORT_OP_TIMEOUT_MS + SLACK_MS)
  } finally {
    await broker.close()
  }
})

void test('a build runs as a job without injecting the registry', async () => {
  // What the deployment looks like: reading `ctx.jobs` throws (the service lives in a sibling
  // fiber), while the injection-free accessor returns it. A registry that is present must be used.
  const table = [
    {
      name: 'deploy.build',
      summary: 'Build the :dev image.',
      input: {
        type: 'object',
        properties: { pr: { type: 'integer' }, log: { type: 'string' } },
        additionalProperties: false,
      },
      confirm: true,
    },
  ]
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`
      : `${JSON.stringify({ ok: true, result: 'built' })}\n`,
  )
  try {
    const { ctx, tools } = context()
    const started: string[] = []
    const jobs = {
      start(): string {
        const id = `job-${String(started.length + 1)}`
        started.push(id)
        return id
      },
    }
    const deployment = {
      ...ctx,
      get jobs(): never {
        throw new Error('cannot get property "jobs" without inject')
      },
      get(name: string): Jobs | undefined {
        return name === 'jobs' ? jobs : undefined
      },
    } as HostContext
    await registerTools(deployment, { socketPath: broker.socketPath })
    const build = tools.find(tool => tool.name === 'idsh_deploy_build')
    assert.ok(build !== undefined)
    const answer = (await build.execute(
      { pr: 82, log: 'call-1' },
      { signal: new AbortController().signal },
    )) as { text: string }
    // The job path, not the synchronous fallback: the registry was found where cordis put it.
    assert.match(answer.text, /started job-1: deploy\.build runs in the background/u)
    assert.deepEqual(started, ['job-1'])
  } finally {
    await broker.close()
  }
})

void test('a table that changes is picked up without a reload', async () => {
  let table: unknown[] = [TABLE[0]]
  const answer = (): string =>
    `${JSON.stringify({ ok: true, result: JSON.stringify({ protocol: 1, version: '1.0.0', ops: table }) })}\n`
  const broker = await fakeBroker(request => (request.op === 'ops.describe' ? answer() : null))
  try {
    const { ctx, tools } = context()
    const registered = await registerTools(ctx, { socketPath: broker.socketPath })
    assert.deepEqual(
      tools.map(tool => tool.name),
      ['idsh_log_tail'],
    )

    // The same table again: nothing is re-registered and nothing is disposed.
    assert.equal(await registered.refresh(), false)
    assert.equal(tools.length, 1)

    // A broker that grew an operation: the tools are replaced, so a call can reach it now.
    table = [TABLE[0], { ...TABLE[1], name: 'run', summary: 'Run one declared binary.' }]
    assert.equal(await registered.refresh(), true)
    assert.deepEqual(
      tools.map(tool => tool.name),
      ['idsh_log_tail', 'idsh_run'],
    )

    registered.dispose()
    assert.deepEqual(tools, [])
  } finally {
    await broker.close()
  }
})

void test('a refreshMs that is not a positive integer is refused, not coerced', async () => {
  for (const refreshMs of [true, '5', FRACTIONAL_MS, 0, -1] as unknown[]) {
    const base = context()
    // `apply` turns a rejected config into its one warning, so the message is the assertion.
    await apply(base.ctx, { socketPath: '/nonexistent/host.sock', refreshMs } as never)
    assert.match(base.warnings.at(0) ?? '', /refreshMs must be a positive integer/u)
    assert.deepEqual(base.tools, [])
  }
})

void test('the timer replaces the tools without a reload', async () => {
  let table: unknown[] = [TABLE[0]]
  const answer = (): string =>
    `${JSON.stringify({ ok: true, result: JSON.stringify({ protocol: 1, version: '1.0.0', ops: table }) })}\n`
  const broker = await fakeBroker(request => (request.op === 'ops.describe' ? answer() : null))
  try {
    const base = context()
    let stop: (() => void) | undefined
    const ctx: HostContext = {
      ...base.ctx,
      effect(run) {
        stop = run()
      },
    }
    await apply(ctx, { socketPath: broker.socketPath, refreshMs: 5 })
    assert.deepEqual(
      base.tools.map(tool => tool.name),
      ['idsh_log_tail'],
    )

    table = [TABLE[0], TABLE[1]]
    // The timer is the thing under test: wait for the outcome, not a fixed slice of time.
    await waitFor(() => base.tools.length === 2)
    assert.deepEqual(
      base.tools.map(tool => tool.name),
      ['idsh_log_tail', 'idsh_disk_usage'],
    )

    // The effect's disposer is the plugin's own disposal: the tools go with it.
    stop?.()
    assert.deepEqual(base.tools, [])
  } finally {
    await broker.close()
  }
})

void test('a disposed registration ignores a refresh', async () => {
  const broker = await fakeBroker(
    () =>
      `${JSON.stringify({ ok: true, result: JSON.stringify({ protocol: 1, version: '1.0.0', ops: TABLE }) })}\n`,
  )
  try {
    const { ctx, tools } = context()
    const registered = await registerTools(ctx, { socketPath: broker.socketPath })
    registered.dispose()
    assert.deepEqual(tools, [])
    assert.equal(await registered.refresh(), false)
    assert.deepEqual(tools, [])
  } finally {
    await broker.close()
  }
})

void test('a disposal during an in-flight read mounts nothing', async () => {
  let calls = 0
  let started!: () => void
  let release!: (answer: BrokerAnswer) => void
  const readStarted = new Promise<void>(resolve => {
    started = resolve
  })
  // A caller whose second read stays pending until the test says otherwise, so the disposal lands
  // between the request and its answer.
  const call = async (): Promise<BrokerAnswer> => {
    calls += 1
    const table = calls === 1 ? [TABLE[0]] : TABLE
    if (calls === 1) {
      return {
        text: JSON.stringify({ protocol: 1, version: '1.0.0', ops: table }),
        truncated: false,
      }
    }
    return new Promise<BrokerAnswer>(resolve => {
      release = resolve
      started()
    })
  }
  const { ctx, tools } = context()
  const registered = await registerTools(ctx, { socketPath: '/unused' }, call)
  const refresh = registered.refresh()
  await readStarted
  registered.dispose()
  release({ text: JSON.stringify({ protocol: 1, version: '1.0.0', ops: TABLE }), truncated: false })
  assert.equal(await refresh, false)
  assert.deepEqual(tools, [])
})

void test('a stalled broker under a short interval sees one read and one warning', async () => {
  // The first describe answers; everything after it hangs until the client's own timeout.
  let answered = false
  const broker = await fakeBroker(request => {
    if (request.op !== 'ops.describe') {
      return null
    }
    if (answered) {
      return null
    }
    answered = true
    return `${JSON.stringify({ ok: true, result: JSON.stringify({ protocol: 1, version: '1.0.0', ops: TABLE }) })}\n`
  })
  try {
    const base = context()
    let stop: (() => void) | undefined
    const ctx: HostContext = {
      ...base.ctx,
      effect(run) {
        stop = run()
      },
    }
    // A millisecond interval against a timeout the initial read can also meet: without coalescing
    // this is a storm, and the 200 ms leaves the first read room on a loaded worker.
    await apply(ctx, { socketPath: broker.socketPath, refreshMs: 1, timeoutMs: STALL_TIMEOUT_MS })
    // The initial read must have landed before the warning means anything; an initial timeout would
    // otherwise satisfy the wait below without testing the refresh at all.
    assert.deepEqual(
      base.tools.map(tool => tool.name),
      ['idsh_log_tail', 'idsh_disk_usage'],
    )
    await waitFor(() => base.warnings.length > 0)
    // Stop before the next stalled read can finish and warn again.
    stop?.()
    assert.equal(base.warnings.length, 1)
    assert.match(base.warnings.at(0) ?? '', /re-reading the broker table failed/u)
    // The initial load and the one stalled read; joined ticks add nothing.
    assert.ok(broker.requests.length <= 3, String(broker.requests.length))
  } finally {
    await broker.close()
  }
})

void test('a joined tick reports one failure, not one per tick', async () => {
  let calls = 0
  let started!: () => void
  let fail!: (error: Error) => void
  const readStarted = new Promise<void>(resolve => {
    started = resolve
  })
  const call = async (): Promise<BrokerAnswer> => {
    calls += 1
    if (calls === 1) {
      return {
        text: JSON.stringify({ protocol: 1, version: '1.0.0', ops: [TABLE[0]] }),
        truncated: false,
      }
    }
    return new Promise<BrokerAnswer>((_resolve, reject) => {
      fail = reject
      started()
    })
  }
  const { ctx, tools, warnings } = context()
  const registered = await registerTools(ctx, { socketPath: '/unused' }, call)
  const first = registered.refresh()
  await readStarted
  // Both ticks wait on the same read; when it fails, only that read reports it.
  const second = registered.refresh()
  fail(new Error('the broker timed out'))
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  assert.equal(warnings.length, 1)
  assert.match(warnings.at(0) ?? '', /the broker timed out/u)
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['idsh_log_tail'],
  )
})

void test('a tick that arrives during a read joins it instead of starting another', async () => {
  let calls = 0
  let started!: () => void
  let release!: (answer: BrokerAnswer) => void
  const readStarted = new Promise<void>(resolve => {
    started = resolve
  })
  const call = async (): Promise<BrokerAnswer> => {
    calls += 1
    const table = calls === 1 ? [TABLE[0]] : TABLE
    if (calls === 1) {
      return {
        text: JSON.stringify({ protocol: 1, version: '1.0.0', ops: table }),
        truncated: false,
      }
    }
    return new Promise<BrokerAnswer>(resolve => {
      release = resolve
      started()
    })
  }
  const { ctx, tools } = context()
  const registered = await registerTools(ctx, { socketPath: '/unused' }, call)
  const first = registered.refresh()
  await readStarted
  // A second tick while the read is pending must join it: same promise, no second read.
  const second = registered.refresh()
  assert.equal(second, first)
  release({ text: JSON.stringify({ protocol: 1, version: '1.0.0', ops: TABLE }), truncated: false })
  assert.equal(await first, true)
  assert.equal(calls, 2)
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['idsh_log_tail', 'idsh_disk_usage'],
  )
})

void test('an older broker is named once, not once per poll', async () => {
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify(TABLE) })}\n`,
  )
  try {
    const { ctx, warnings } = context()
    const registered = await registerTools(ctx, { socketPath: broker.socketPath })
    assert.equal(warnings.length, 1)
    await registered.refresh()
    await registered.refresh()
    assert.equal(warnings.length, 1)
  } finally {
    await broker.close()
  }
})

void test('a refresh that cannot mount puts the previous tools back', async () => {
  let table: unknown[] = [TABLE[0]]
  const answer = (): string =>
    `${JSON.stringify({ ok: true, result: JSON.stringify({ protocol: 1, version: '1.0.0', ops: table }) })}\n`
  const broker = await fakeBroker(request => (request.op === 'ops.describe' ? answer() : null))
  try {
    const base = context()
    let failOnce = false
    const ctx: HostContext = {
      ...base.ctx,
      tools: {
        register(tool) {
          if (failOnce) {
            failOnce = false
            throw new Error('the registry refused it')
          }
          return base.ctx.tools.register(tool)
        },
      },
    }
    const registered = await registerTools(ctx, { socketPath: broker.socketPath })
    assert.deepEqual(
      base.tools.map(tool => tool.name),
      ['idsh_log_tail'],
    )

    // The new table mounts, but the registry refuses the new name: the old tools come back.
    table = [TABLE[0], TABLE[1]]
    failOnce = true
    assert.equal(await registered.refresh(), false)
    assert.match(base.warnings.at(-1) ?? '', /registry refused it/u)
    assert.deepEqual(
      base.tools.map(tool => tool.name),
      ['idsh_log_tail'],
    )

    // Once the registry cooperates, the same table is applied.
    assert.equal(await registered.refresh(), true)
    assert.deepEqual(
      base.tools.map(tool => tool.name),
      ['idsh_log_tail', 'idsh_disk_usage'],
    )
  } finally {
    await broker.close()
  }
})

void test('a broker speaking another protocol is named in a warning', async () => {
  const legacy = `${JSON.stringify({ ok: true, result: JSON.stringify(TABLE) })}\n`
  const current = `${JSON.stringify({
    ok: true,
    result: JSON.stringify({ protocol: 1, version: '9.9.9', ops: TABLE }),
  })}\n`
  const future = `${JSON.stringify({
    ok: true,
    result: JSON.stringify({ protocol: 2, version: '9.9.9', ops: TABLE }),
  })}\n`

  for (const [describe, expected] of [
    [legacy, /describes no protocol, so it is older than this plugin/u],
    [future, /broker 9\.9\.9 speaks protocol 2 but this plugin speaks 1/u],
  ] as const) {
    const broker = await fakeBroker(() => describe)
    try {
      const { ctx, tools, warnings } = context()
      await registerTools(ctx, { socketPath: broker.socketPath })
      assert.match(warnings.join('\n'), expected)
      // The warning is not a refusal: the table is readable, so the tools exist.
      assert.deepEqual(
        tools.map(tool => tool.name),
        ['idsh_log_tail', 'idsh_disk_usage'],
      )
    } finally {
      await broker.close()
    }
  }

  // The same protocol is silent: a warning on every boot would be noise.
  const broker = await fakeBroker(() => current)
  try {
    const { ctx, warnings } = context()
    await registerTools(ctx, { socketPath: broker.socketPath })
    assert.deepEqual(warnings, [])
  } finally {
    await broker.close()
  }
})
