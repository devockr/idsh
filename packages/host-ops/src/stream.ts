/**
 * Long deploy operations as dsh background jobs: the tool call returns an id at once and the broker
 * keeps building, while a pull source hands the build log to the job's output ring — the UI streams
 * it, and `job_output` reads it. A call that is cut off (a container recreate, say) no longer
 * blocks on the build.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

import type { BrokerAnswer, BrokerEndpoint } from './socket.ts'
import { isRecord } from './values.ts'

/** A host's background-job registry, structurally: the plugin imports no dsh code. */
export interface JobHandle {
  append(text: string, options?: { readonly channel?: 'log' | 'stderr' | 'stdout' }): void
}

export interface JobSourceRead {
  readonly text: string
  readonly nextOffset: number
  readonly lossy: boolean
}

export interface JobOutputSource {
  readonly channel?: 'log' | 'stderr' | 'stdout'
  read(fromByte: number): JobSourceRead
}

export interface JobOutcome {
  readonly status: 'completed' | 'failed' | 'killed'
  readonly detail?: string
  readonly result?: string
}

export interface JobHooks {
  done: Promise<JobOutcome>
  cancel(reason?: string): void
}

export interface JobSpec {
  readonly kind: string
  readonly label: string
  readonly owner?: string
  readonly toolCall?: { readonly callId?: string; readonly rootCallId?: string }
  readonly output?: readonly JobOutputSource[]
  run(job: JobHandle): JobHooks
}

export interface Jobs {
  start(spec: JobSpec): string
}

export interface StreamTarget {
  readonly name: string
  readonly args: unknown
  readonly call: (
    endpoint: BrokerEndpoint,
    op: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<BrokerAnswer>
  readonly endpoint: BrokerEndpoint
  readonly statePath: string
  /** The one log this call writes; the job follows it and nothing else. */
  readonly logPath: string
  readonly owner?: string
  readonly toolCall?: { readonly callId?: string; readonly rootCallId?: string }
}

/**
 * The broker appends to one log, so the source reports only what landed since the last read.
 *
 * The baseline is the file's size when the job starts: what an earlier build wrote is history the
 * job must not replay. Offsets are bytes, and a read decodes exactly the new range, so a chunk can
 * never split a character.
 */
export function buildLogSource(file: string): JobOutputSource {
  // A character can straddle two polls; the decoder keeps its bytes for the next read.
  const decoder = new StringDecoder('utf8')
  let offset = (() => {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  })()
  return {
    channel: 'stdout',
    read(fromByte) {
      const start = fromByte > 0 ? fromByte : offset
      let size: number
      try {
        size = statSync(file).size
      } catch {
        return { text: '', nextOffset: start, lossy: false }
      }
      if (size <= start) {
        return { text: '', nextOffset: start, lossy: false }
      }
      const buffer = Buffer.alloc(size - start)
      const fd = openSync(file, 'r')
      let read: number
      try {
        read = readSync(fd, buffer, 0, buffer.length, start)
      } finally {
        closeSync(fd)
      }
      // A short read must not leave the zero-filled tail of the buffer in the ring.
      offset = start + read
      return {
        text: decoder.write(buffer.subarray(0, read)),
        nextOffset: offset,
        lossy: false,
      }
    },
  }
}

/** Start the operation as a job; the returned id is what the tool answers with. */
export function startDeployJob(jobs: Jobs, target: StreamTarget): string {
  const controller = new AbortController()
  return jobs.start({
    kind: 'deploy',
    label: `${target.name} ${JSON.stringify(target.args)}`,
    ...(target.owner === undefined ? {} : { owner: target.owner }),
    ...(target.toolCall === undefined ? {} : { toolCall: target.toolCall }),
    output: [buildLogSource(target.logPath)],
    run() {
      const work = (async (): Promise<JobOutcome> => {
        try {
          if (!isRecord(target.args)) {
            throw new Error('host-ops: a job must carry object arguments')
          }
          const answer = await target.call(
            target.endpoint,
            target.name,
            target.args,
            controller.signal,
          )
          // The log arrives through the source; the answer is the job's result, once.
          return { status: 'completed', result: answer.text }
        } catch (error) {
          // A kill aborts the call; the job is `killed`, and the reason is the answer.
          if (controller.signal.aborted) {
            return {
              status: 'killed',
              detail: error instanceof Error ? error.message : 'the host operation was cancelled',
            }
          }
          return {
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          }
        }
      })()
      return {
        done: work,
        cancel() {
          controller.abort()
        },
      }
    },
  })
}
