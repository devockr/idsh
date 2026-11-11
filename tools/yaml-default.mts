#!/usr/bin/env node
// Set one key in a YAML config file as a lower-priority default, with the YAML parser that ships
// in dsh's own dependency tree (currently reached through @deepseek-ai/dsh-plugin-manager). That
// is the parser this dsh image is guaranteed to carry while dsh keeps it; if a dsh release drops
// it, the setting is left untouched and the boot log says why. The file is parsed and rewritten as
// a document, so flow mappings, document markers and comments survive.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const DSH_PACKAGE = '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'

interface YamlDocument {
  has(key: string): boolean
  set(key: string, value: string): void
  toString(): string
}

interface YamlModule {
  parseDocument(source: string): YamlDocument
}

const [file, key, value] = process.argv.slice(2)
if (!file || !key || value === undefined) {
  console.error('usage: yaml-default.mts <file> <key> <value>')
  process.exit(2)
}

try {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    console.error(`entrypoint: ${file} is a symlink; leaving it to the deployment`)
    process.exit(0)
  }
  const { parseDocument } = createRequire(DSH_PACKAGE)('yaml') as YamlModule
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
  process.exitCode = 1
}
