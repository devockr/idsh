#!/usr/bin/env node
// Set one key in a YAML config file as a lower-priority default, with the YAML parser that ships
// inside dsh itself. The image is a dsh service, so dsh's dependency is the one parser guaranteed
// to be present; if a dsh update moves it, this script moves with it. The file is parsed and
// rewritten as a document, so flow mappings, document markers and comments survive.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const DSH_PACKAGE = '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'

const [file, key, value] = process.argv.slice(2)
if (!file || !key || value === undefined) {
  console.error('usage: yaml-default.mjs <file> <key> <value>')
  process.exit(2)
}

try {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    console.error(`entrypoint: ${file} is a symlink; leaving it to the deployment`)
    process.exit(0)
  }
  const { parseDocument } = createRequire(DSH_PACKAGE)('yaml')
  const doc = parseDocument(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  if (doc.has(key)) {
    process.exit(0)
  }
  doc.set(key, value)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, doc.toString())
} catch (error) {
  console.error(
    `entrypoint: could not set ${key} in ${file}: ${error instanceof Error ? error.message : error}`,
  )
}
