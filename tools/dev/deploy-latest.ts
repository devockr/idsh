#!/usr/bin/env node
// Deploy the long-lived `:latest` image: build it locally from this checkout, then recreate the
// deployment from it. This is the path the issue #89 notes as "compose build, then a manual compose
// up" — two steps with nothing in between, and one of them easy to get wrong.
//
// The dev overlay must NOT be merged here: it selects `:dev` and resets the build. This uses
// `docker-compose.latest.yml` instead, which names `devockr/idsh:latest` and drops the build stanza
// so `up` cannot rebuild a different thing than the image just built. `--dry` stops after the
// config has been resolved and says what would happen.
//
// The published Dockerfile installs every plugin by name and strictly, so this build fails while a
// plugin it ships is unpublished — that is the published image's contract, not a local mistake.
import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const dry = process.argv.includes('--dry')
const IMAGE = 'devockr/idsh:latest'

const die = (message: string): never => {
  console.error(`deploy:latest: ${message}`)
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

const files = ['docker-compose.yml', 'docker-compose.broker.yml', 'docker-compose.latest.yml']
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
const compose = (args: string[]) =>
  docker(['compose', ...files.flatMap(file => ['-f', file]), ...args], env)

// Resolve first: this is the deployment about to be created, not the one running now.
interface Resolved {
  services?: Record<
    string,
    {
      image?: string
      container_name?: string
      pull_policy?: string
      healthcheck?: { test?: unknown }
      build?: { args?: Record<string, string | null> }
      volumes?: { type?: string; source?: string; bind?: { create_host_path?: boolean } }[]
    }
  >
}
const resolved = JSON.parse(await compose(['config', '--format', 'json'])) as Resolved
const service = resolved.services?.dsh ?? {}
if (service.image !== IMAGE) {
  die(
    `docker-compose.latest.yml must select ${IMAGE}; the resolved config says ${JSON.stringify(service.image)}`,
  )
}
if (service.pull_policy !== 'never') {
  die('docker-compose.latest.yml must set pull_policy: never on dsh, or up would pull the tag away')
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
console.log(`deploy:latest: image ${IMAGE}`)

if (dry) {
  console.log(
    'deploy:latest: --dry — would build the image and recreate the deployment; nothing ran',
  )
  process.exit(0)
}

// 1) The image itself. The registry comes from the resolved config, so a value set in `.env` or
//    the shell follows Compose's own precedence instead of being read twice, differently.
const registry = service.build?.args?.NPM_REGISTRY
const buildArgs = ['build', '-f', 'Dockerfile', '-t', IMAGE]
if (typeof registry === 'string' && registry !== '') {
  buildArgs.push('--build-arg', `NPM_REGISTRY=${registry}`)
}
buildArgs.push('.')
console.log('deploy:latest: building the published image')
try {
  await runStreaming(dockerBin, buildArgs)
} catch (error) {
  die(`the build failed; the running deployment was not touched:\n${stderrOf(error)}`)
}

// 2) Recreate from it. `compose up` removes the old container before creating the new one, so the
//    build above is what makes this the safe order: nothing is removed until the image exists.
console.log('deploy:latest: recreating the deployment')
try {
  await compose(['up', '-d'])
} catch (error) {
  die(`the deployment did not come up:\n${stderrOf(error)}`)
}

// 3) Prove it: compose exiting 0 is not enough — the container compose created has to be running
//    the image that was just built and its health check has to pass. A recreate that kept the old
//    container would pass every check above; the broker's own verification makes the same demands.
const expected = (await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE])).trim()
const WAIT_MS = 180_000
const POLL_MS = 2_000
const stateFormat =
  '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Image}}'
const deadline = Date.now() + WAIT_MS
let seen = ''
for (;;) {
  // Ask compose for the container it created: a name guessed here would be nobody's container
  // when the base file sets no container_name, and `inspect` on that exits non-zero.
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
  const [status, health, image] = seen.split(' ')
  if (status === 'running' && health === 'healthy' && image === expected) {
    console.log(`deploy:latest: dsh: running, healthy, ${image}`)
    break
  }
  if (Date.now() >= deadline) {
    die(
      `the container did not prove itself within ${String(WAIT_MS / 1000)}s: ${seen}` +
        (image === expected ? '' : ` (image is not what was built: ${String(image)})`) +
        (health === 'none' ? ' — the compose file declares no health check' : '') +
        ' — the previous container may be gone; fix the cause and re-run',
    )
  }
  await new Promise(resolve => setTimeout(resolve, POLL_MS))
}

// 4) Say what is running, from the container that just proved itself: a version read before the
//    proof would describe a container that may no longer exist.
for (const line of ['dsh', 'gcb'] as const) {
  const args = ['exec', 'dsh', line, '--version']
  try {
    const answer = await docker(args, env)
    console.log(`deploy:latest: dsh: ${line} ${answer.trim()}`)
  } catch (error) {
    console.log(`deploy:latest: warning — could not read ${line} — ${stderrOf(error)}`)
  }
}
