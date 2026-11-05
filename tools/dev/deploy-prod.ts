#!/usr/bin/env node
// Deploy the production pair: pinned images, no build, no moving tag.
//
// This is the deployment file's channel: `docker-compose.prod.yml` names `IDSH_IMAGE` and
// `GCB_IMAGE`, and this script only drives it. In its default mode it pulls the pinned tags and
// recreates the deployment from them; `--build` builds *this* checkout instead, tags it by commit,
// and points `IDSH_IMAGE` at that tag for the run — the pre-release path, where the published
// image cannot be built yet because its plugins are not published. `GCB_IMAGE` is the operator's
// in both modes: the broker's checkout is not this repository.
//
// `--dry` resolves the config, checks the images, the health check and the strict bind sources,
// and stops. `--no-pull` skips step 1 for an image that is already local.
import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const dry = process.argv.includes('--dry')
const build = process.argv.includes('--build')
const noPull = process.argv.includes('--no-pull')

const die = (message: string): never => {
  console.error(`deploy:prod: ${message}`)
  process.exit(1)
}

const run = async (cmd: string, args: string[], extraEnv: Record<string, string> = {}) => {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
  return stdout
}

const stderrOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    // `docker exec` reports failures with an empty stderr; a blank line is not a reason.
    if ('stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() !== '') {
      return error.stderr.trim()
    }
    if ('message' in error && typeof error.message === 'string') {
      return error.message.trim()
    }
  }
  return String(error).trim()
}

/** Run with the terminal attached: a multi-minute build must not go silent, nor hit a 1 MiB cap. */
const runStreaming = (cmd: string, args: string[], extraEnv: Record<string, string> = {}) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: repo,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          code === null ? `terminated by ${String(signal)}` : `exited with ${String(code)}`,
        ),
      )
    })
  })

// docker is not on every PATH this runs under, so resolve it: $DOCKER, then PATH, then the usual
// places — the same order `deploy-dev.ts` uses, for the same reason.
const resolveDocker = async (): Promise<string> => {
  const candidates = [
    process.env.DOCKER,
    'docker',
    '/usr/local/bin/docker',
    '/usr/bin/docker',
    '/opt/bin/docker',
  ].filter((candidate): candidate is string => typeof candidate === 'string')
  for (const candidate of candidates) {
    try {
      await run(candidate, ['version'])
      return candidate
    } catch {
      // not this one
    }
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not this one either
    }
  }
  return die(
    'docker not found — run this on the host with docker on PATH, or set DOCKER=/path/to/docker',
  )
}

const dockerBin = await resolveDocker()
const docker = (args: string[], extraEnv?: Record<string, string>) => run(dockerBin, args, extraEnv)

const brokerImage = process.env.GCB_IMAGE ?? ''
if (brokerImage === '') {
  die('GCB_IMAGE is not set — pin the broker image, e.g. ghcr.io/code-vaults/gcb-host:sha-<commit>')
}
const pinned = process.env.IDSH_IMAGE ?? ''
if (!build && pinned === '') {
  die('IDSH_IMAGE is not set — pin it (e.g. ghcr.io/devockr/idsh:sha-<commit>) or pass --build')
}

// A deployment that supervises the broker on the host has no broker overlay; the base and the
// channel are the whole config then.
const files = ['docker-compose.yml']
if (
  await fs.access(path.join(repo, 'docker-compose.broker.yml')).then(
    () => true,
    () => false,
  )
) {
  files.push('docker-compose.broker.yml')
}
files.push('docker-compose.prod.yml')
for (const file of files) {
  try {
    await fs.access(path.join(repo, file))
  } catch {
    die(`${file} is missing next to tools/`)
  }
}

const env = {
  UID: String(process.getuid?.() ?? ''),
  GID: String(process.getgid?.() ?? ''),
}

// `--build` tags by commit, so the run still names something immutable rather than `:latest`;
// the deployment's own `IDSH_IMAGE` is replaced for this invocation only.
let image = pinned
if (build) {
  const short = (await run('git', ['rev-parse', '--short', 'HEAD'])).trim()
  if (short === '') {
    die('git could not name the commit this checkout is at')
  }
  image = `devockr/idsh:${short}`
  console.log(`deploy:prod: building ${image} from this checkout`)
  try {
    await runStreaming(dockerBin, ['build', '-f', 'Dockerfile', '-t', image, '.'])
  } catch (error) {
    die(`the build failed; the running deployment was not touched:\n${stderrOf(error)}`)
  }
}

const composeEnv = { ...env, IDSH_IMAGE: image, GCB_IMAGE: brokerImage }
const composeWith = (list: readonly string[], args: string[]) =>
  docker(['compose', ...list.flatMap(file => ['-f', file]), ...args], composeEnv)
const compose = (args: string[]) => composeWith(files, args)

// Resolve first: this is the deployment about to be created, not the one running now.
interface Resolved {
  services?: Record<
    string,
    {
      image?: string
      healthcheck?: { test?: unknown }
      build?: { args?: Record<string, string | null> }
      volumes?: { type?: string; source?: string; bind?: { create_host_path?: boolean } }[]
    }
  >
}
const resolved = JSON.parse(await compose(['config', '--format', 'json'])) as Resolved
const service = resolved.services?.dsh ?? {}
if (service.image !== image) {
  die(
    `docker-compose.prod.yml must run IDSH_IMAGE; the resolved config says ${JSON.stringify(service.image)}`,
  )
}
if (resolved.services?.gcb?.image !== brokerImage) {
  die(
    `docker-compose.prod.yml must run GCB_IMAGE; the resolved config says ${JSON.stringify(resolved.services?.gcb?.image)}`,
  )
}
if (service.healthcheck?.test === undefined) {
  die('the deployment declares no health check; the verification after up would fail on it')
}
// `up` removes the old container before it creates the new one, so a strict bind source that is
// missing takes the deployment down. Check those now, while nothing is at stake.
for (const [name, other] of Object.entries(resolved.services ?? {})) {
  for (const mount of other.volumes ?? []) {
    if (mount.type !== 'bind' || mount.bind?.create_host_path !== false) {
      continue
    }
    const source = mount.source ?? ''
    if (source === '') {
      die(`service ${name}: a bind mount names no source`)
    }
    try {
      statSync(source)
    } catch {
      die(`service ${name}: bind source ${source} does not exist; nothing was touched`)
    }
  }
}
console.log(`deploy:prod: dsh ${image}`)
console.log(`deploy:prod: gcb ${brokerImage}`)

if (dry) {
  console.log('deploy:prod: --dry — the config resolves; nothing was pulled, built or recreated')
  process.exit(0)
}

// 1) The images. A pinned tag is already immutable, so pulling is about presence, not freshness.
if (!build && !noPull) {
  console.log('deploy:prod: pulling the pinned images')
  try {
    await compose(['pull'])
  } catch (error) {
    die(
      `could not pull the pinned images:\n${stderrOf(error)}\n` +
        'pass --no-pull when both are already local, or fix the tags',
    )
  }
}

// 2) Recreate. `compose up` removes the old container before creating the new one, so the images
//    above are present first; `--no-build` keeps it from building the reset `build` stanza.
console.log('deploy:prod: recreating the deployment')
try {
  await compose(['up', '-d', '--no-build'])
} catch (error) {
  die(`the deployment did not come up:\n${stderrOf(error)}`)
}

// 3) Prove it: compose exiting 0 is not enough — the container compose created has to be running
//    the image that was named and its health check has to pass. The broker's own verification
//    makes the same two demands, and a recreate that kept the old container would pass every check
//    above.
const expected = (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).trim()
const WAIT_MS = 180_000
const POLL_MS = 2_000
const stateFormat =
  '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Image}}'
const deadline = Date.now() + WAIT_MS
let seen = ''
for (;;) {
  // Ask compose for the container it created: a name guessed here would be nobody's container.
  let id = ''
  try {
    id = ((await compose(['ps', '-q', 'dsh'])).trim().split(/\r?\n/u)[0] ?? '').trim()
  } catch {
    id = ''
  }
  if (id === '') {
    seen = 'no container'
  } else {
    try {
      seen = (await docker(['inspect', id, '--format', stateFormat])).trim()
    } catch (error) {
      seen = `inspect failed: ${stderrOf(error)}`
    }
  }
  const [status, health, actual] = seen.split(' ')
  if (status === 'running' && health === 'healthy' && actual === expected) {
    console.log(`deploy:prod: dsh: running, healthy, ${actual}`)
    break
  }
  if (Date.now() >= deadline) {
    die(
      `the container did not prove itself within ${String(WAIT_MS / 1000)}s: ${seen}` +
        (actual === expected ? '' : ` (image is not what was named: ${String(actual)})`) +
        (health === 'none' ? ' — the compose file declares no health check' : '') +
        ' — the previous container may be gone; fix the cause and re-run',
    )
  }
  await new Promise(resolve => setTimeout(resolve, POLL_MS))
}

// 4) Say what is running, from the container that just proved itself.
for (const line of ['dsh', 'gcb'] as const) {
  try {
    const answer = await docker(['exec', 'dsh', line, '--version'], env)
    console.log(`deploy:prod: dsh: ${line} ${answer.trim()}`)
  } catch (error) {
    console.log(`deploy:prod: warning — could not read ${line} — ${stderrOf(error)}`)
  }
}
