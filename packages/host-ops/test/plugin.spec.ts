/* eslint-disable @typescript-eslint/no-magic-numbers -- the inputs of these tests are numbers */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { apply, registerTools, type HostContext, type HostTool } from '../src/index.ts'
import { buildLogSource, type JobSpec } from '../src/stream.ts'

import { fakeBroker } from './server.ts'

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

function context(
  selected: readonly string[] = ['Run'],
  custom?: string,
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
          tools.push(tool)
          return () => true
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

void test('a bad config registers nothing and warns', async () => {
  const bad = context()
  await apply(bad.ctx, { socketPath: {} as unknown as string })
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
      timeoutMs: 900_000,
    },
  ]
  const broker = await fakeBroker(
    () => `${JSON.stringify({ ok: true, result: JSON.stringify(table) })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await registerTools(ctx, { socketPath: broker.socketPath })
    // The broker's budget plus the slack the plugin adds, on the tool and on the socket wait.
    assert.equal(tools[0]?.timeoutMs, 905_000)
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
      timeoutMs: 200,
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
      /did not answer within 5200 ms/u,
    )
    assert.equal(calls[0]?.timeoutMs, 5200)
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
    const ctx = {
      ...built.ctx,
      jobs: {
        start(spec: JobSpec) {
          started.push(spec)
          return 'deploy-1'
        },
      },
    }
    await registerTools(ctx, { socketPath: broker.socketPath }, undefined, host)
    const answer = (await built.tools[0].execute(
      {},
      {
        signal: new AbortController().signal,
        agent: { id: 'ses_abc' },
        callId: 'call-1',
      },
    )) as { text: string }
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
    const ctx = {
      ...built.ctx,
      jobs: {
        start(spec: JobSpec) {
          started.push(spec)
          return 'deploy-1'
        },
      },
    }
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
    const ctx = {
      ...built.ctx,
      jobs: {
        start(spec: JobSpec) {
          started.push(spec)
          return 'deploy-1'
        },
      },
    }
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
    const ctx = {
      ...built.ctx,
      jobs: {
        start(spec: JobSpec) {
          started.push(spec)
          return 'deploy-1'
        },
      },
    }
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
    const ctx = {
      ...built.ctx,
      jobs: {
        start(spec: JobSpec) {
          started.push(spec)
          return 'deploy-1'
        },
      },
    }
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
    const ctx = {
      ...built.ctx,
      jobs: {
        start(spec: JobSpec) {
          started.push(spec)
          return 'deploy-1'
        },
      },
    }
    await registerTools(ctx, { socketPath: broker.socketPath }, undefined, host)
    await built.tools[0].execute({}, { signal: new AbortController().signal, callId: 'call-1' })
    // No per-build log to follow, so an old broker stays synchronous: no job, the answer is the call.
    assert.deepEqual(started, [])
  } finally {
    await broker.close()
    await rm(host, { recursive: true, force: true })
  }
})
