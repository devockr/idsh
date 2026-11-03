#!/usr/bin/env node
/**
 * Type coverage over every TypeScript project in the workspace: the root one (tools and the tool
 * configs), the docs site, and each package's own. `type-coverage` measures one project per run,
 * and the packages do not share one — their browser halves compile against different module
 * settings — so the runs are separate and the exit status is the worst of them.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const projects = ['tsconfig.json', 'docs/tsconfig.json']
for (const entry of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
  const project = path.join('packages', entry.name, 'tsconfig.json')
  if (entry.isDirectory() && existsSync(path.join(root, project))) {
    projects.push(project)
  }
}

// The packages typecheck through their own declarations, so a missing build is a refusal, not a
// lower number: type-coverage would resolve nothing and call the gap "any".
for (const project of projects.filter(entry => entry.startsWith('packages/'))) {
  const built = path.join(path.dirname(project), 'lib/index.d.ts')
  if (!existsSync(path.join(root, built))) {
    console.error(`typecov: ${built} is missing — run pnpm build first`)
    process.exit(1)
  }
}

let failed = false
for (const project of projects) {
  process.stdout.write(`\n# ${project}\n`)
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules/type-coverage/bin/type-coverage'),
      // An absolute project path: a relative one is resolved against the `type-coverage` process's
      // own directory, and every project but the root then measures nothing — "0 / 0" with a zero
      // exit, which is a gate that cannot fail.
      '-p',
      path.join(root, project),
    ],
    { cwd: root, encoding: 'utf8' },
  )
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) {
    failed = true
  }
  // A run that measured nothing is not a pass: it is the failure mode above, and the one a version
  // that cannot read this TypeScript produces. Refuse it rather than reporting green.
  const measured = [...(result.stdout ?? '').matchAll(/\((\d+) \/ (\d+)\)/gu)].at(-1)
  if (measured === undefined || measured[2] === '0') {
    process.stderr.write(
      `typecov: ${project} was not measured — type-coverage answered "${(result.stdout ?? '').trim() || '(no output)'}"\n`,
    )
    failed = true
  }
}
// `exitCode`, not `process.exit`: a piped stdout write is asynchronous, and exiting straight after
// the last `write` can truncate the very summary this gate is read for.
process.exitCode = failed ? 1 : 0
