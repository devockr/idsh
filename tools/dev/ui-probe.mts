#!/usr/bin/env node

/**
 * Boot a throwaway `dsh web` instance and drive it with a real browser.
 *
 * The point is to verify things that only a browser can show — a client plugin's runtime effect,
 * the settings surface a remote page gets, touch behaviour — without touching the live profile or
 * the live session. Everything lives in a disposable $DSH_HOME; the browser itself lives under
 * ~/.dsh/cache so a container rebuild does not re-download it.
 *
 * Usage: node tools/dev/ui-probe.mts [--install <pnpm-spec>]... [--bare] [--host <host>] [--keep]
 * [--shot <name>]
 *
 * - `--install <pnpm-spec>` adds a package to the probe profile before booting; repeatable, and a
 *   spec whose package is already there replaces it.
 * - `--bare` starts from the shipped web template alone, without the plugin set the image baked. The
 *   default inherits that set, since finding bugs in those plugins is what this tool is for;
 *   `--bare` narrows down which one is at fault.
 * - `--host <host>` is the authority to browse, `127.0.0.1` by default; pass a LAN address to
 *   reproduce what a remote page sees.
 * - `--keep` leaves the probe instance and its `$DSH_HOME` behind for poking.
 * - `--shot <name>` prefixes the screenshots it writes, `probe` by default.
 */

// Must be set before playwright resolves its browser path. The default is a bind
// mount, so the download survives `docker compose up -d --force-recreate`.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/home/app/.dsh/cache/ms-playwright'

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(name)
/**
 * Every operand of a repeatable `name`, rejecting an absent one or a following flag: a silently
 * defaulted `--host` would probe the wrong origin, and an operand that looks like a flag is a
 * typo.
 */
const values = (name: string): string[] => {
  const found: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) {
      continue
    }
    const value: string | undefined = argv[index + 1]
    // The guard is deliberate: argv can be shorter than the flag suggests, which the type of an
    // index read does not admit. Hence the comparison the linter calls impossible.
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${name} needs a value`)
    }
    found.push(value)
    index += 1
  }
  return found
}
/** The loopback authority, however it is spelled — `localhost` is not a remote origin. */
const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.')

// Named so the numbers say what they are: waits are for the UI to settle, and the slices are how
// much of a long value is worth printing. Numbers inside a page.evaluate stay literal — that code
// runs in the browser and cannot see these.
const READINESS_TIMEOUT_MS = 60_000
const HTTP_SEE_OTHER = 303
const HTTP_BAD_REQUEST = 400
const WAIT_AFTER_LOAD_MS = 4000
const WAIT_AFTER_CLICK_MS = 2500
const WAIT_FOR_RENDER_MS = 2000
const WAIT_FOR_SETTLE_MS = 5000
const CONTEXT_BEFORE_CHARS = 60
const CONTEXT_AFTER_CHARS = 160
const HTML_HEAD_CHARS = 200
const LOG_TAIL_LINES = 25
const OUTPUT_TAIL_CHARS = 400
// A throwaway state directory under the system temp is the point: it is ours to delete, and
// PROBE_HOME overrides it for a caller who wants to keep one.
// eslint-disable-next-line sonarjs/publicly-writable-directories
const HOME = process.env.PROBE_HOME ?? '/tmp/dsh-ui-probe'
// Whether this run owns HOME. A caller-supplied PROBE_HOME can hold their own profile, so it is
// never removed; the default directory is ours, and a run that was kept or killed must not turn
// every later run into a reuse of its leftovers.
const HOME_EXISTED =
  process.env.PROBE_HOME !== undefined &&
  (await fs.access(HOME).then(
    () => true,
    () => false,
  ))
const SHOTS = process.env.PROBE_SHOTS ?? '/home/app/.dsh/cache/ui-probe'
const PROFILE = process.env.PROBE_PROFILE ?? 'probe'
// Every use of it is a path component under PROFILES, and the --bare cleanup deletes that tree, so
// a value that is anything but a single directory name is refused rather than joined onto a path.
if (!/^\w[\w.-]*$/.test(PROFILE)) {
  throw new Error(`PROBE_PROFILE must be a single directory name, not ${JSON.stringify(PROFILE)}`)
}
const HOST = values('--host')[0] ?? '127.0.0.1'
const INSTALLS = values('--install')
/**
 * The plugin set the image baked, which is exactly what a deployment gets. A probe that only ever
 * saw the shipped template could not find a bug in those plugins, which is the tool's purpose, so
 * this set is installed by default; `--install` follows it and replaces any package it names.
 */
const BARE = flag('--bare')
const KEEP = flag('--keep')
const SHOT = values('--shot')[0] ?? 'probe'
const SCENARIO = values('--scenario')[0]
// PROBE_DSH points at another lib/bin.js — a pristine copy is what an unpatched deployment
// looks like; without it the probe drives the installed dsh.
const DSH = process.env.PROBE_DSH ?? 'dsh'
// The launcher wants --expose-internals, exactly as entrypoint.sh invokes it.
const dshArgv = (args: string[]): [string, string[]] =>
  DSH.endsWith('.js') ? [process.execPath, ['--expose-internals', DSH, ...args]] : [DSH, args]

// The instance is ours to clean up whatever happens: a rejected boot, a thrown scenario or an
// early exit all land here, so nothing outlives the probe unless --keep asked for it — and a HOME
// that was already there is not ours to delete.
let child: ChildProcess | undefined
const forget = async () => {
  if (!KEEP && !HOME_EXISTED) {
    await fs.rm(HOME, { recursive: true, force: true })
  }
}
// Two layers, because they can do different things. "exit" cannot await, but kill() is
// synchronous, so it terminates the child on every path — an unhandled rejection after boot
// would otherwise orphan a dsh holding its port. The directory is removed where an await is
// possible: the handlers below, the finally, and the explicit calls. A SIGKILL leaves it; the
// next run clears it.
let stopping = false
const stop = async (error?: unknown) => {
  if (stopping) {
    return
  }
  stopping = true
  if (error !== undefined) {
    console.error(error)
  }
  if (!KEEP) {
    child?.kill('SIGTERM')
  }
  // A failed cleanup is still a failure, and it must not keep the process alive: exit runs in a
  // finally so it happens either way.
  let status = error === undefined ? 0 : 1
  try {
    await forget()
  } catch (cleanupError) {
    console.error(cleanupError)
    status = 1
  } finally {
    process.exit(status)
  }
}
process.on('exit', () => {
  if (!KEEP) {
    child?.kill('SIGTERM')
  }
})
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
process.on('uncaughtException', error => void stop(error))
process.on('unhandledRejection', error => void stop(error))

await fs.mkdir(SHOTS, { recursive: true })

/** Run dsh to completion, collecting both streams — the callers report status and output. */
const run = (
  args: string[],
  opts: SpawnOptions = {},
): Promise<{ status: number; stdout: string; stderr: string }> =>
  new Promise(resolve => {
    const proc = spawn(...dshArgv(args), {
      env: { ...process.env, DSH_HOME: HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    proc.on('error', (error: Error) => resolve({ status: 1, stdout, stderr: String(error) }))
    proc.on('close', (status: number | null) => resolve({ status: status ?? 1, stdout, stderr }))
  })

/**
 * The plugin sources the image baked, by the same rule Dockerfile.dev bakes them: every directory
 * under /opt/dsh/packages whose manifest declares a `dsh` field. That directory is world-readable
 * on purpose, so this needs nothing the image does not already publish.
 */
async function bakedSpecs(): Promise<string[]> {
  const root = '/opt/dsh/packages'
  let dirs: string[]
  try {
    dirs = await fs.readdir(root)
  } catch {
    // Not the image that baked them; there is nothing to inherit.
    return []
  }
  const specs: string[] = []
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(root, dir, 'package.json'), 'utf8'),
      ) as { dsh?: unknown }
      if (parsed.dsh) {
        specs.push(`link:${path.join(root, dir)}`)
      }
    } catch {
      // A directory without a readable manifest is not a dsh plugin.
    }
  }
  return specs
}

/** Say which set is in play: a silent default that installed nothing reads as success. */
function reportBaked(inherited: string[]) {
  const found = inherited.length > 0 ? `${inherited.length} to install` : 'none found'
  process.stdout.write(`image plugin set: ${found}\n`)
  if (inherited.length === 0) {
    process.stderr.write(
      'probe: no plugin sources under /opt/dsh/packages; name them with --install\n',
    )
  }
}

/** The probe profile: created from the shipped web template, never the live one. */
async function prepareProfile() {
  await fs.mkdir(HOME, { recursive: true })
  // `--bare` has to mean an empty profile even when an earlier run left one behind: the probe
  // reuses PROBE_HOME, so without this a bare run would boot whatever that run installed.
  if (BARE) {
    await fs.rm(path.join(HOME, 'profiles', PROFILE), {
      recursive: true,
      force: true,
    })
  }
  // Idempotent: a crashed earlier run leaves the profile behind, and recreating it is
  // an error rather than a no-op.
  const profileManifest = path.join(HOME, 'profiles', PROFILE, 'package.json')
  if (
    !(await fs.access(profileManifest).then(
      () => true,
      () => false,
    ))
  ) {
    const created = await run([PROFILE, '--from-default-profile', 'web', '--dump-config'])
    if (created.status !== 0) {
      throw new Error(`could not create the probe profile:\n${created.stdout}${created.stderr}`)
    }
  }
  // Say which set is in play: a silent default that installed nothing looked exactly like a
  // successful run that found no plugin problems.
  const inherited = BARE ? [] : await bakedSpecs()
  if (!BARE) {
    reportBaked(inherited)
  }
  const specs: Array<[string, string]> = [
    ...inherited.map((spec): [string, string] => [spec, 'image']),
    ...INSTALLS.map((spec): [string, string] => [spec, '--install']),
  ]
  for (const [spec, source] of specs) {
    const r = await run(['plugin', '--profile', PROFILE, 'add', spec])
    process.stdout.write(`install (${source}) ${spec}: ${r.status === 0 ? 'ok' : 'FAILED'}\n`)
    if (r.status !== 0) {
      // Booting anyway would probe a profile without the plugin that was asked for — the baked
      // set or the caller's — and still exit 0. Fail here, where the message means something.
      throw new Error(`could not install ${spec} (from ${source}):\n${r.stdout}${r.stderr}`)
    }
  }
}

/**
 * Boot the instance, wait for the readiness line, return { url, token, child }.
 *
 * `--host` is what defines `ctx.webStartup.host`. The baked profile ships @idsh/remote-access,
 * whose webserver row falls back to the wildcard when that is undefined, and 0.2.1-alpha.2 and
 * later refuse the wildcard from any layer — so leaving the bind to the profile cannot boot at all,
 * and a patch overlay is not needed to say one concrete address.
 */
async function boot() {
  // Launcher options have to precede the app's: the launcher hands everything from
  // the first token it does not recognize to the app, so `--host` must come before
  // `--port`.
  const args = [
    '--profile',
    PROFILE,
    '--host',
    // dsh takes one concrete IP literal, and `isLoopback` also accepts `localhost` and `[::1]`:
    // normalise those to 127.0.0.1, the authority the printed URL uses anyway.
    isLoopback(HOST) ? '127.0.0.1' : HOST,
    '--port',
    '0',
    '--no-open',
  ]
  child = spawn(...dshArgv(args), {
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise<{ url: string; token: string | null; out: string }>((resolve, reject) => {
    if (child === undefined) {
      reject(new Error('dsh did not spawn'))

      return
    }

    const proc = child
    let out = ''
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`no readiness line in 60s:\n${out}`))
    }, READINESS_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      const m = /dsh web: (https?:\/\/\S+)/.exec(out)
      if (!m) {
        return
      }
      clearTimeout(timer)
      proc.stdout?.off('data', onData)
      const url = new URL(isLoopback(HOST) ? m[1] : m[1].replace(/\/\/[^/:]+/, `//${HOST}`))
      resolve({
        url: url.toString(),
        token: url.searchParams.get('token'),
        out,
      })
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    proc.on('exit', (code: number | null) => {
      // The timer would otherwise hold the event loop for its full minute and then kill a
      // process that has already exited.
      clearTimeout(timer)
      reject(new Error(`dsh exited early (${code}):\n${out}`))
    })
  })
}

const { chromium } = await import('playwright')

await prepareProfile().catch(async error => {
  await forget()
  throw error
})
const { url, token, out } = await boot().catch(async error => {
  await forget()
  throw error
})
process.stdout.write(`probe up: ${url.replace(token ?? '', '<token>')}\n`)

// Without a browser the useful half is still available: the served shell carries the
// composed boot graph, so the plugin rows and their bundle URLs can be checked
// directly. This is the mode to use where the container has no browser libraries.
if (flag('--no-browser')) {
  let failed = false
  const origin = new URL(url).origin
  // The token URL answers 303 and sets the session cookie; the redirect target then
  // needs that cookie. fetch follows redirects but keeps no cookie jar, so a plain
  // fetch(url) lands on the 401 page. Exchange it explicitly instead.
  const exchange = await fetch(url, { redirect: 'manual' })
  const cookie = exchange.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .filter(Boolean)
    .join('; ')
  if (exchange.status !== HTTP_SEE_OTHER) {
    failed = true
  }
  const cookieNote = cookie ? `${cookie.length} bytes` : 'NONE'
  process.stdout.write(`token       : ${exchange.status} → cookie ${cookieNote}\n`)
  const res = await fetch(`${origin}/`, { headers: { cookie } })
  const html = await res.text()
  // The shell injects it as globalThis["__DSH_BOOT__"], with `<` and `&` escaped so a
  // plugin-controlled string cannot break out of the script element.
  const boot = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\S[\s\S]*?)<\/script>/.exec(html)
  const graph = (boot?.[1] ?? '').replaceAll('&quot;', '"').replaceAll('&amp;', '&')
  process.stdout.write(
    `shell       : ${res.status} ${res.headers.get('content-type') ?? ''} ${html.length} bytes\n`,
  )
  const graphNote = boot ? `${graph.length} bytes` : 'NOT FOUND'
  process.stdout.write(`boot graph  : ${graphNote}\n`)
  if (!boot) {
    failed = true
    const at = html.search(/__DSH_BOOT__/)
    process.stdout.write(
      at >= 0
        ? `  at ${at}: ${JSON.stringify(html.slice(Math.max(0, at - CONTEXT_BEFORE_CHARS), at + CONTEXT_AFTER_CHARS))}\n`
        : `  no __DSH_BOOT__; head: ${JSON.stringify(html.slice(0, HTML_HEAD_CHARS))}\n`,
    )
  }
  // remote-access is a server-side patch with no client half, so its absence from the boot graph
  // is by design and not an assertion; the two client plugins are.
  for (const wanted of ['privileged-ui', 'mobile', 'remote-access']) {
    const expected = wanted !== 'remote-access'
    const found = graph.includes(wanted)
    if (expected && !found) {
      failed = true
    }
    process.stdout.write(
      `contains ${wanted}: ${found ? 'yes' : 'NO'}${expected ? '' : ' (server half, not in the client graph)'}\n`,
    )
  }
  // URLs appear both escaped (inside the boot graph) and as plain script attributes.
  const urls = [
    ...new Set(
      [...html.matchAll(/["']((?:plugins|\/plugins)\/[^"']+client\.js[^"']*)["']/g)].map(m =>
        m[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'),
      ),
    ),
  ]
  process.stdout.write(`bundle urls : ${urls.length}\n`)
  // The boot graph naming a plugin is not the same as the shell serving its bundle: a client half
  // that never made it into the composition would otherwise pass this mode silently.
  for (const wanted of ['privileged-ui', 'mobile']) {
    const served = urls.some(u => u.includes(`@idsh/${wanted}/client.js`))
    if (!served) {
      failed = true
    }
    process.stdout.write(`bundle for ${wanted}: ${served ? 'yes' : 'NO'}\n`)
  }
  for (const u of urls) {
    const separator = u.startsWith('/') ? '' : '/'
    const target = u.startsWith('http') ? u : origin + separator + u
    const res = await fetch(target)
    if (res.status >= HTTP_BAD_REQUEST) {
      failed = true
    }
    process.stdout.write(`  ${res.status} ${res.headers.get('content-type') ?? ''} ${u}\n`)
  }
  if (KEEP) {
    process.stdout.write(`kept: ${HOME} (pid ${child?.pid})\n`)
  } else {
    child?.kill('SIGTERM')
  }
  await forget()
  process.exit(failed ? 1 : 0)
}

const browser = await chromium
  .launch({
    headless: true,
    // Chromium honours http_proxy from the environment on Linux, which turns a probe
    // against a LAN address into a proxy request (502). Blank the variables for the
    // browser process and tell it not to use a proxy at all.
    env: {
      ...process.env,
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
    },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
  })
  // Expected to fail wherever the browser libraries are absent — the published image, say. The
  // process exits on the unhandled rejection either way; this way the directory goes with it.
  .catch(async error => {
    await forget()
    throw error
  })
// A phone, when that is the point: `hasTouch` is what makes `(pointer: coarse)` match, which is
// the condition every touch behaviour here hangs off. `isMobile` is deliberately not set: in the
// headless shell that emulation path dies in Skia asking fontconfig for fonts the dev image does
// not carry, and the coarse pointer is what the plugins key off either way.
const PHONE = { hasTouch: true, viewport: { width: 390, height: 844 } }
const page = await browser.newPage(
  SCENARIO === 'mobile' ? PHONE : { viewport: { width: 1280, height: 900 } },
)
// A scenario assertion, as opposed to a problem worth reading: the run has to fail on it.
const failures: string[] = []

/** The marker's last stage is the icon: a run that stopped short is a failure, not a value. */
function checkMobileMarker(probe: { marker?: string; appleTouchIcon: boolean }): void {
  const marker = probe.marker
  if (!marker?.includes('icon:')) {
    failures.push(`the mobile marker never reached its icon stage: ${marker ?? '(absent)'}`)
  } else if (!marker.endsWith('icon:ok')) {
    failures.push(`the mobile marker stopped at ${marker}`)
  }
  if (!probe.appleTouchIcon) {
    failures.push('no apple-touch-icon was injected')
  }
}

const problems: string[] = []
let completed = false
// Everything, not just errors: cordis reports an unmet `inject` as a warning the
// boot audit later summarizes as a bare "failed".
const console_all: string[] = []
page.on('console', m => {
  console_all.push(`[${m.type()}] ${m.text()}`)
  if (m.type() === 'error') {
    problems.push(`console: ${m.text()}`)
  }
})
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
// Name the failing URL: a bare "502" in the console says nothing about who answered.
page.on(
  'response',
  r => r.status() >= HTTP_BAD_REQUEST && problems.push(`http ${r.status()} ${r.url()}`),
)
page.on('requestfailed', r => problems.push(`failed ${r.url()} — ${r.failure()?.errorText ?? ''}`))

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // The shell renders before the mux socket finishes its token exchange; give it a
  // moment, then describe what we actually got instead of asserting a selector we
  // guessed.
  await page.waitForTimeout(WAIT_AFTER_LOAD_MS)

  // `mark()` writes the marker twice: the CSS half first, the icon once the artwork is ready, which
  // is a fetch and a canvas encode later. An absent marker is not a settled one either — the plugin
  // writes after activation, which can be later than this point — so this waits for the icon either
  // way and only the timeout ends it; --scenario mobile is what fails the run when it never comes.
  try {
    await page.waitForFunction(
      (stage: string) => document.body.dataset.idshMobile?.includes(stage) ?? false,
      'icon:',
      { timeout: WAIT_FOR_SETTLE_MS },
    )
  } catch {
    // It never settled: a plugin that could not reach its last stage. The snapshot below reports
    // what is there, and --scenario mobile is where that becomes an assertion.
  }

  // Scenarios exist because "the flag flipped" is not the same answer as "the
  // privileged surface behaves". Discovery first: click the entry and report the
  // controls, so the real assertions are written against the actual DOM.
  if (SCENARIO === 'discover-settings') {
    const clicked = await page.evaluate(() => {
      const all = [
        ...document.querySelectorAll('button, a, [role="button"], [role="tab"], li, span, div'),
      ]
      const el = all.findLast(e => e.textContent.trim() === 'Settings')
      if (!el) {
        return false
      }
      if (el instanceof HTMLElement) {
        el.click()
      }
      return true
    })
    await page.waitForTimeout(WAIT_AFTER_CLICK_MS)
    const controls = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'button, [role="button"], [role="radio"], [role="tab"], [role="switch"], label',
        ),
      ]
        .map(e => ({
          t: e.textContent
            .replaceAll(/\s+/g, ' ')
            .trim()
            // Runs inside the page, so it cannot see this module's constants.
            .slice(0, 50),
          r: e.getAttribute('role') ?? e.tagName,
        }))
        .filter(x => x.t),
    )
    const controlLines = controls.map(c => `  ${c.r} — ${c.t}`).join('\n')
    process.stdout.write(`clicked settings: ${clicked}\ncontrols:\n${controlLines}\n`)
    await page.screenshot({ path: path.join(SHOTS, `${SHOT}-settings.png`) })
  }

  // Does a settings change survive a reload? That is what "host" vs "memory"
  // persistence means to a user, and it is the half the flag decides.
  if (SCENARIO === 'settings-persistence') {
    const clickText = (text: string): Promise<boolean> =>
      page.evaluate(t => {
        const all = [
          ...document.querySelectorAll('button, a, [role="button"], [role="tab"], li, span, div'),
        ]

        const el = all.findLast(e => e.textContent.trim() === t)
        if (!el) {
          return false
        }
        if (el instanceof HTMLElement) {
          el.click()
        }
        return true
      }, text)
    const themeState = () =>
      page.evaluate(() => ({
        cls: document.documentElement.className,
        theme: document.documentElement.dataset.theme,
        scheme: getComputedStyle(document.documentElement).colorScheme,
        bg: getComputedStyle(document.body).backgroundColor,
        buttons: [...document.querySelectorAll('button')]
          .filter(b => ['Light', 'Dark', 'System'].includes(b.textContent.trim()))
          .map(
            b =>
              `${b.textContent.trim()}:${b.getAttribute('aria-pressed') ?? b.getAttribute('aria-checked') ?? b.className.slice(0, 24)}`,
          ),
      }))

    process.stdout.write(`open settings: ${await clickText('Settings')}\n`)
    await page.waitForTimeout(WAIT_FOR_RENDER_MS)
    process.stdout.write(`before       : ${JSON.stringify(await themeState())}\n`)
    process.stdout.write(`click DARK   : ${await clickText('Dark')}\n`)
    await page.waitForTimeout(WAIT_AFTER_CLICK_MS)
    process.stdout.write(`after click  : ${JSON.stringify(await themeState())}\n`)
    await page.screenshot({ path: path.join(SHOTS, `${SHOT}-after-dark.png`) })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(WAIT_FOR_SETTLE_MS)
    process.stdout.write(`after reload : ${JSON.stringify(await themeState())}\n`)
    await page.screenshot({
      path: path.join(SHOTS, `${SHOT}-after-reload.png`),
    })
  }

  // Touch behaviours: coarse-pointer CSS, and Enter meaning "line break" rather than
  // "send". Both are asserted where they act — computed styles and dispatched events in
  // the real page — not by reading the plugin's own source back.
  if (SCENARIO === 'discover-composer') {
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('[contenteditable="true"], textarea, input')].map(el => ({
        tag: el.tagName,
        inXterm: !!el.closest('.xterm'),
        attrs: [...el.attributes]
          .map(
            a =>
              // Runs inside the page, so it cannot see this module's constants.
              `${a.name}=${JSON.stringify(a.value.slice(0, 60))}`,
          )
          .join(' '),
      })),
    )
    const editableLines = found.map(f => `  ${JSON.stringify(f)}`).join('\n')
    process.stdout.write(`editables:\n${editableLines}\n`)
  }

  if (SCENARIO === 'mobile') {
    const probe = await page.evaluate(() => {
      const input = document.createElement('input')
      document.body.append(input)
      const css = {
        touchAction: getComputedStyle(document.documentElement).touchAction,
        inputFontSize: getComputedStyle(input).fontSize,
      }
      input.remove()

      // A plain Enter inside an editable must be stopped, and the plugin must then drive the
      // editor's line break the way the editor accepts it: a `beforeinput` with
      // `inputType: insertLineBreak`, which is what Lexical's insertLineBreak command runs from.
      // A dispatched keyboard event cannot do this — untrusted events have no default behaviour —
      // so the recorder watches for that instead of for a rewritten keydown.
      const enterEvents: string[] = []
      const record = (e: KeyboardEvent): void => {
        enterEvents.push(`${e.key}${e.shiftKey ? '+shift' : ''}`)
      }
      document.addEventListener('keydown', record)
      // The composer writes `contenteditable=""`; the `"true"` spelling is what other clients use,
      // so the composedPath lookup has to cover both.
      const insertedBreaks: string[] = []
      const editables = ['', 'true'].map(value => {
        const editable = document.createElement('div')
        editable.setAttribute('contenteditable', value)
        editable.style.cssText = 'position:fixed;left:-9999px;top:0'
        editable.addEventListener('beforeinput', e => insertedBreaks.push(e.inputType))
        document.body.append(editable)
        editable.focus()
        editable.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        )
        return editable
      })
      document.removeEventListener('keydown', record)
      for (const editable of editables) {
        editable.remove()
      }

      // And the other way round: a plain input (the session search) keeps its own Enter.
      const inputSeen: string[] = []
      const recordInput = (e: KeyboardEvent): void => {
        inputSeen.push(`${e.key}${e.shiftKey ? '+shift' : ''}`)
      }
      document.addEventListener('keydown', recordInput)
      const search = document.createElement('input')
      search.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.append(search)
      search.focus()
      search.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      )
      document.removeEventListener('keydown', recordInput)
      search.remove()

      return {
        coarse: matchMedia('(pointer: coarse)').matches,
        css,
        enterEvents,
        insertedBreaks,
        inputEvents: inputSeen,
        composerEditables: document.querySelectorAll('[contenteditable]').length,
        marker: document.body.dataset.idshMobile,
        appleTouchIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
      }
    })
    // The rewrite is the point of this scenario, so it has to fail the run when it stops working.
    if (probe.enterEvents.length > 0) {
      failures.push(`the plain Enter reached the document: ${JSON.stringify(probe.enterEvents)}`)
    }
    if (
      probe.insertedBreaks.length !== 2 ||
      !probe.insertedBreaks.every(inputType => inputType === 'insertLineBreak')
    ) {
      failures.push(
        `the composer was not sent insertLineBreak twice: ${JSON.stringify(probe.insertedBreaks)}`,
      )
    }
    if (probe.inputEvents.length !== 1 || probe.inputEvents[0] !== 'Enter') {
      failures.push(
        `the session-search input lost its own Enter: ${JSON.stringify(probe.inputEvents)}`,
      )
    }
    checkMobileMarker(probe)
    process.stdout.write(`mobile probe : ${JSON.stringify(probe)}\n`)
    await page.screenshot({ path: path.join(SHOTS, `${SHOT}-mobile.png`) })
  }

  const facts = await page.evaluate(() => ({
    title: document.title,
    bodyLength: document.body.innerHTML.length,
    // Plugins under test report through body.dataset (see packages/privileged-ui).
    dataset: { ...document.body.dataset },
    text: document.body.textContent
      .replaceAll(/\s+/g, ' ')
      // Runs inside the page, so it cannot see this module's constants.
      .slice(0, 365),
  }))
  const shot = path.join(SHOTS, `${SHOT}.png`)
  await page.screenshot({ path: shot, fullPage: false })
  process.stdout.write(
    [
      `title       : ${facts.title}`,
      `body length : ${facts.bodyLength}`,
      `dataset     : ${JSON.stringify(facts.dataset)}`,
      `visible text: ${facts.text}`,
      `screenshot  : ${shot}`,
      `problems    : ${problems.length > 0 ? '\n  ' + problems.join('\n  ') : 'none'}`,
      `failures    : ${failures.length > 0 ? '\n  ' + failures.join('\n  ') : 'none'}`,
      `console log : ${console_all.length > 0 ? '\n  ' + console_all.slice(-LOG_TAIL_LINES).join('\n  ') : 'none'}`,
    ].join('\n') + '\n',
  )
  completed = true
} finally {
  await browser.close()
  // Set before the branch: without --keep the process simply ends, and the exit code has to
  // say the same thing it says when the instance is left behind.
  process.exitCode = completed && failures.length === 0 ? 0 : 1
  if (KEEP) {
    // Printing and returning leaves the piped server attached to this process, so the probe would
    // never give the shell back: unref the child and end on purpose, leaving it running. `else`, not
    // an early return — a return in a finally would discard a thrown scenario's stack trace.
    process.stdout.write(`kept: ${HOME} (pid ${child?.pid})\n${out.slice(-OUTPUT_TAIL_CHARS)}\n`)
    child?.unref()
  } else {
    child?.kill('SIGTERM')
  }
  await forget()
}
