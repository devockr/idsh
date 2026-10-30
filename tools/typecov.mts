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
    [path.join(root, 'node_modules/type-coverage/bin/type-coverage'), '-p', project],
    { cwd: root, stdio: 'inherit' },
  )
  if (result.status !== 0) {
    failed = true
  }
}
process.exit(failed ? 1 : 0)
