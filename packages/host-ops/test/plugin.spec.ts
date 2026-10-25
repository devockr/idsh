import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  apply,
  registerTools,
  type HostContext,
  type HostTool,
} from '../src/index.ts'

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

function context(): {
  ctx: HostContext
  tools: HostTool[]
  warnings: string[]
} {
  const tools: HostTool[] = []
  const warnings: string[] = []
  return {
    tools,
    warnings,
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
      ['log.tail', 'disk.usage'],
    )
    assert.deepEqual(tools[0]?.parameters, TABLE[0]?.input)
    const result = await tools[0]?.execute(
      { file: 'messages' },
      { signal: new AbortController().signal },
    )
    assert.deepEqual(result, { text: 'answer', truncated: false })
    const rendered = tools[0].output.render(
      {},
      { text: 'answer', truncated: true },
    )
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
    () =>
      `${JSON.stringify({ ok: true, result: JSON.stringify({ nope: true }) })}\n`,
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

void test('a bad config is refused before anything is discovered', () => {
  const { ctx } = context()
  assert.throws(
    () => apply(ctx, { socketPath: {} as unknown as string }),
    /socketPath must be a non-empty string/u,
  )
  assert.throws(
    () => apply(ctx, { timeoutMs: 0 }),
    /timeoutMs must be a positive integer/u,
  )
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
  }
  try {
    await assert.rejects(
      registerTools(ctx, { socketPath: broker.socketPath }),
      /registry is full/u,
    )
    assert.deepEqual(tools, ['log.tail'])
    assert.deepEqual(disposed, ['log.tail'])
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
    await assert.rejects(
      registerTools(ctx, { socketPath: broker.socketPath }),
      /not an object/u,
    )
    assert.deepEqual(tools, [])
  } finally {
    await broker.close()
  }
})
