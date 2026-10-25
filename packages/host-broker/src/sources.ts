/**
 * The operations this slice exposes.
 *
 * Each one names a **source** rather than a command: a fixed set of files or one fixed program,
 * with a small set of validated arguments. That is the whole shape — the questions asked of a host
 * are unbounded, the places an answer can come from are not. Nothing here takes a path or an
 * arbitrary argument, so there is no path guard to get wrong yet.
 */
import { spawn } from 'node:child_process'
import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  MAX_ERROR_CHARS,
  MAX_EXEC_BUFFER_BYTES,
  MAX_PATTERN_CHARS,
  TAIL_WINDOW_BYTES,
} from './constants.ts'
import type { Keep } from './limits.ts'
import { BrokerFault } from './protocol.ts'

/** Where an operation reads from, which container it drives, and how long a program may run. */
export interface OpContext {
  readonly logDir: string
  readonly procDir: string
  readonly execTimeoutMs: number
  readonly container: string
  readonly dockerPath: string
}

/** One typed operation. `input` is the JSON Schema the plugin turns into a tool parameter. */
export interface OpDefinition {
  readonly name: string
  readonly summary: string
  readonly input: Record<string, unknown>
  /** The end a cap keeps; a log wants its tail, everything else its head. */
  readonly keep?: Keep
  run(args: Record<string, unknown>, ctx: OpContext): Promise<string>
}

/**
 * Run one fixed program with fixed arguments.
 *
 * No shell and no caller-supplied argv; both pipes are collected in arrival order, so a log that
 * writes to stderr is not reordered or welded onto stdout. Past the buffer ceiling the oldest bytes
 * are dropped — a tail reader wants the newest — and `capOutput` then trims to the answer size.
 */
function runFixed(
  ctx: OpContext,
  program: string,
  args: readonly string[],
  keep: Keep = 'head',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own group, so a timeout can stop whatever the program started too.
      detached: true,
    })
    const state: { settled: boolean; timer?: NodeJS.Timeout } = {
      settled: false,
    }
    let buffer = Buffer.alloc(0)

    const settle = (failure?: Error): void => {
      if (state.settled) {
        return
      }
      state.settled = true
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
      }
      if (failure === undefined) {
        resolve(buffer.toString('utf8'))
      } else {
        reject(failure)
      }
    }
    const collect = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_EXEC_BUFFER_BYTES) {
        // The retained window's start never reaches a client: the answer cap keeps the last
        // 64 KiB of it, and that boundary is repaired by `decodeTail`.
        buffer =
          keep === 'tail'
            ? buffer.subarray(buffer.length - MAX_EXEC_BUFFER_BYTES)
            : buffer.subarray(0, MAX_EXEC_BUFFER_BYTES)
      }
    }

    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    state.timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      settle(
        new BrokerFault(
          'timeout',
          `no answer within ${String(ctx.execTimeoutMs)} ms`,
        ),
      )
    }, ctx.execTimeoutMs)
    child.once('error', (error: NodeJS.ErrnoException) => {
      settle(
        new BrokerFault(
          'unavailable',
          `${error.code ?? 'spawn failed'}: ${error.message}`,
        ),
      )
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        settle()
        return
      }
      // The program's own message is the useful part, and docker/df put the cause last: keep the
      // tail of the output, from a line boundary, rather than its opening lines.
      const text = buffer.toString('utf8').trim()
      // Only a cut needs a boundary repair: a short message is complete as it stands.
      const cut = text.length > MAX_ERROR_CHARS
      let tail = cut ? text.slice(-MAX_ERROR_CHARS) : text
      if (cut) {
        // A slice can start on the low half of a surrogate pair.
        if (/^[\uDC00-\uDFFF]/u.test(tail)) {
          tail = tail.slice(1)
        }
        const boundary = tail.indexOf('\n')
        tail = boundary === -1 ? tail : tail.slice(boundary + 1)
      }
      const message = tail.trim()
      settle(
        new BrokerFault(
          'unavailable',
          message === ''
            ? `${program} exited with ${code ?? signal ?? 'no status'}`
            : message,
        ),
      )
    })
  })
}

/* ------------------------------------------------------------------ argument checks */

function rejectUnknown(
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new BrokerFault(
        'bad-argument',
        `unknown argument ${JSON.stringify(key)}`,
      )
    }
  }
}

function choice<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const value = args[name]
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BrokerFault(
      'bad-argument',
      `${name} must be one of ${allowed.map(item => JSON.stringify(item)).join(', ')}`,
    )
  }
  return value as T
}

function integer(
  args: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = args[name]
  if (value === undefined) {
    return fallback
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new BrokerFault(
      'bad-argument',
      `${name} must be an integer between ${min} and ${max}`,
    )
  }
  return value
}

function text(
  args: Record<string, unknown>,
  name: string,
  maxChars: number,
): string | undefined {
  const value = args[name]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.length > maxChars) {
    throw new BrokerFault(
      'bad-argument',
      `${name} must be a string of at most ${maxChars} characters`,
    )
  }
  return value
}

/* ------------------------------------------------------------------ log.tail */

/** The most rows `log.tail` returns, and the default when the caller does not ask. */
const MAX_LINES = 500
const DEFAULT_LINES = 100

/** The one directory `log.tail` reads, and the only three names it knows inside it. */
const LOG_TARGETS = ['messages', 'syslog', 'kern'] as const

type LogFile = (typeof LOG_TARGETS)[number]

const LOG_FILES: Record<LogFile, string> = {
  messages: 'messages',
  syslog: 'syslog',
  kern: 'kern.log',
}

/**
 * The last `lines` rows of one log.
 *
 * A window is read from the end rather than the whole file: a log can be gigabytes, and the answer
 * is bounded anyway. One byte before the window is read as well, so the first row is dropped only
 * when the window really starts inside it — a window that starts on a line boundary keeps its first
 * whole row.
 */
async function tail(
  file: LogFile,
  lines: number,
  pattern: string | undefined,
  ctx: OpContext,
): Promise<string> {
  const filePath = path.join(ctx.logDir, LOG_FILES[file])
  let info
  try {
    info = await stat(filePath)
  } catch {
    throw new BrokerFault(
      'unavailable',
      `${file} is not being written on this host`,
    )
  }
  if (!info.isFile()) {
    throw new BrokerFault('unavailable', `${file} is not a regular file`)
  }

  const offset = Math.max(0, info.size - TAIL_WINDOW_BYTES - 1)
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, TAIL_WINDOW_BYTES + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    let body = buffer.subarray(0, bytesRead).toString('utf8')
    if (offset > 0) {
      const firstBreak = body.indexOf('\n')
      body = firstBreak === -1 ? '' : body.slice(firstBreak + 1)
    }
    let rows = body.split('\n').filter(row => row !== '')
    // A literal substring, not a regular expression: nothing to escape, nothing that can backtrack.
    if (pattern !== undefined) {
      rows = rows.filter(row => row.includes(pattern))
    }
    return rows.slice(-lines).join('\n')
  } finally {
    await handle.close()
  }
}

/* ------------------------------------------------------------------ proc.read */

/** The fixed set `proc.read` can answer from. */
const PROC_TARGETS = [
  'mdstat',
  'loadavg',
  'meminfo',
  'uptime',
  'vmstat',
] as const

type ProcFile = (typeof PROC_TARGETS)[number]

async function readProc(file: ProcFile, ctx: OpContext): Promise<string> {
  try {
    return await readFile(path.join(ctx.procDir, file), 'utf8')
  } catch {
    throw new BrokerFault('unavailable', `${file} is not readable on this host`)
  }
}

/* ------------------------------------------------------------------ disk.usage */

/** One fixed program with one fixed argument. */
function diskUsage(ctx: OpContext): Promise<string> {
  return runFixed(ctx, 'df', ['-h'])
}

/* ------------------------------------------------------------------ deploy.status / deploy.log */

/** The most lines one log answer may ask for, and the default. */
const MAX_LOG_LINES = 1000
const DEFAULT_LOG_LINES = 100

/** The shape every `run` operation takes: one program, fixed argv. */
function docker(
  ctx: OpContext,
  args: readonly string[],
  keep: Keep = 'head',
): Promise<string> {
  return runFixed(ctx, ctx.dockerPath, args, keep)
}

/* ------------------------------------------------------------------ the table */

export const OPS: readonly OpDefinition[] = [
  {
    name: 'log.tail',
    summary:
      'The last lines of a host log, optionally only the lines containing a literal string.',
    keep: 'tail',
    input: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: [...LOG_TARGETS],
          description: 'Which host log to read.',
        },
        lines: {
          type: 'integer',
          description: `How many trailing lines to return, 1 to ${String(MAX_LINES)}. Default ${String(DEFAULT_LINES)}.`,
        },
        pattern: {
          type: 'string',
          description: `Keep only rows containing this literal text (at most ${String(MAX_PATTERN_CHARS)} characters; not a regular expression).`,
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['file', 'lines', 'pattern'])
      const file = choice(args, 'file', LOG_TARGETS)
      const lines = integer(args, 'lines', 1, MAX_LINES, DEFAULT_LINES)
      return tail(file, lines, text(args, 'pattern', MAX_PATTERN_CHARS), ctx)
    },
  },
  {
    name: 'proc.read',
    summary:
      'One of a fixed set of kernel state files: mdstat, loadavg, meminfo, uptime, vmstat.',
    input: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: [...PROC_TARGETS],
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['file'])
      const file = choice(args, 'file', PROC_TARGETS)
      return readProc(file, ctx)
    },
  },
  {
    name: 'deploy.status',
    summary:
      'The deployment container: its image, creation time and state, straight from docker.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      rejectUnknown(args, [])
      return docker(ctx, [
        'inspect',
        '--format',
        'image={{.Config.Image}} id={{.Image}} created={{.Created}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} exit={{.State.ExitCode}}',
        ctx.container,
      ])
    },
  },
  {
    name: 'deploy.log',
    summary: 'The tail of the deployment container log.',
    keep: 'tail',
    input: {
      type: 'object',
      properties: {
        lines: {
          type: 'integer',
          description: `How many trailing lines to return, 1 to ${String(MAX_LOG_LINES)}. Default ${String(DEFAULT_LOG_LINES)}.`,
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['lines'])
      const lines = integer(args, 'lines', 1, MAX_LOG_LINES, DEFAULT_LOG_LINES)
      return docker(
        ctx,
        ['logs', '--tail', String(lines), ctx.container],
        'tail',
      )
    },
  },
  {
    name: 'disk.usage',
    summary: 'df -h: the mounted filesystems and how full they are.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      rejectUnknown(args, [])
      return diskUsage(ctx)
    },
  },
]

export function findOp(name: string): OpDefinition | undefined {
  return OPS.find(op => op.name === name)
}

/** The table as the plugin sees it: names, summaries and the parameter schema of each. */
export function describeOps(): string {
  return JSON.stringify(
    OPS.map(({ name, summary, input }) => ({ name, summary, input })),
    null,
    2,
  )
}
