import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_MODULES, moduleSourceRevision } from '../lib/runtime.js'

const args = process.argv.slice(2)
let check = false
let root = fileURLToPath(new URL('../', import.meta.url))
let rootSet = false
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--check' && !check) check = true
  else if (args[index] === '--root' && !rootSet && args[index + 1] && !args[index + 1].startsWith('--')) {
    root = resolve(args[++index])
    rootSet = true
  } else {
    console.error('Usage: node scripts/stamp-revisions.mjs [--check] [--root path]')
    process.exit(2)
  }
}

// Prepare every edit first: malformed/missing markers never cause partial writes.
const prepared = HOST_MODULES.map((name) => {
  const path = resolve(root, 'lib', name)
  const source = readFileSync(path, 'utf8')
  const revision = moduleSourceRevision(source)
  if (!revision) throw new Error('Expected exactly one revision literal in ' + path)
  const stamped = source.replace(/^export const FLOWGATE_MODULE_REVISION = '[a-f0-9]{64}'$/gm,
    "export const FLOWGATE_MODULE_REVISION = '" + revision + "'")
  return { path, name, source, stamped, dirty: source !== stamped }
})
const stale = prepared.filter((file) => file.dirty)
if (check) {
  if (stale.length) {
    console.error('Stale module revisions: ' + stale.map((file) => file.name).join(', '))
    process.exitCode = 1
  } else console.log('Module revisions verified (' + prepared.length + ' modules).')
} else {
  for (const file of stale) {
    // Refuse to overwrite a concurrent editor rather than restoring a stale read.
    if (readFileSync(file.path, 'utf8') !== file.source) throw new Error('Source changed during stamping: ' + file.path)
    writeFileSync(file.path, file.stamped, 'utf8')
  }
  console.log('Updated module revisions: ' + stale.length + '/' + prepared.length + '.')
}
