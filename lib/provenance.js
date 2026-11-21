import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { registerModuleRevision } from './revisions.js'

export const FLOWGATE_MODULE_REVISION = '65165307da23db1a75fa384126c94b20e76638880fbc0c168a035e5355ea8866'
registerModuleRevision(import.meta.url, FLOWGATE_MODULE_REVISION)

const TIMESTAMPS = new Set(['at', 'frozen_at', 'frozenAt', 'created_at', 'createdAt', 'updated_at', 'updatedAt'])
const HEX_ID = /^[a-f0-9]{64}$/
const digest = (value) => createHash('sha256').update(value).digest('hex')
const inside = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

// Sort object keys without dropping meaningful scope/rule fields. Reject values
// that cannot be represented faithfully in the persisted JSON snapshot contract.
function stable(value, omitTimestamps = false, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('non-JSON or circular metadata')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('non-JSON metadata object')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry) => stable(entry, omitTimestamps, ancestors))
    const result = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      if (omitTimestamps && TIMESTAMPS.has(key)) continue
      if (value[key] === undefined) continue
      result[key] = stable(value[key], omitTimestamps, ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

function targetOf(root, entry) {
  if (typeof entry !== 'string' || !entry || entry.includes('\0')) throw new Error('invalid file path')
  const portable = entry.replace(/\\/g, '/')
  // Drive-relative paths and Windows device/alternate-stream paths are never
  // ordinary workspace files, including when a snapshot is inspected on Unix.
  const drive = /^[a-z]:\//i.test(portable)
  if (/^[a-z]:/i.test(portable) && !drive) throw new Error('drive-relative path')
  if (drive && process.platform !== 'win32') throw new Error('foreign absolute path')
  const withoutDrive = drive ? portable.slice(2) : portable
  if (withoutDrive.includes(':') || withoutDrive.split('/').some((part) =>
    /[. ]$/.test(part) && part !== '.' && part !== '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('unsafe Windows file path')
  }
  const absolute = path.resolve(root, portable)
  if (!inside(root, absolute) || absolute === root) throw new Error('path outside workspace or workspace directory')
  return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') }
}

// Check every existing prefix, rather than just the final realpath: a link that
// exits the workspace and later links back into it is unsafe as well.
function resolveFile(root, realRoot, absolute) {
  const parts = path.relative(root, absolute).split(path.sep)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    try {
      fs.lstatSync(current)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    const real = fs.realpathSync.native(current)
    if (!inside(realRoot, real)) throw new Error('unsafe link outside workspace')
    if (index < parts.length - 1 && !fs.statSync(real).isDirectory()) throw new Error('non-directory path component')
    if (index === parts.length - 1) {
      if (!fs.statSync(real).isFile()) throw new Error('not a regular file')
      // A dangling link throws above; it is not equivalent to a deleted file.
      return { real }
    }
  }
  throw new Error('not a regular file')
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

function readEntry(root, realRoot, target) {
  const resolved = resolveFile(root, realRoot, target.absolute)
  if (!resolved) return { path: target.relative, hash: null, state: 'missing' }
  const before = fs.statSync(resolved.real, { bigint: true })
  let descriptor
  try {
    descriptor = fs.openSync(resolved.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || identity(before) !== identity(opened)) throw new Error('file changed while opening snapshot')
    const checked = resolveFile(root, realRoot, target.absolute)
    if (!checked || checked.real !== resolved.real) throw new Error('file path changed while opening snapshot')
    const bytes = fs.readFileSync(descriptor)
    if (identity(opened) !== identity(fs.fstatSync(descriptor, { bigint: true }))) throw new Error('file changed while reading snapshot')
    const after = resolveFile(root, realRoot, target.absolute)
    if (!after || after.real !== resolved.real || identity(opened) !== identity(fs.statSync(after.real, { bigint: true }))) {
      throw new Error('file path changed while reading snapshot')
    }
    return { path: target.relative, hash: digest(bytes), state: 'present' }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

/** Capture the entire declared/changed file set. Any incomplete capture forbids reuse. */
export function captureSnapshot(flow, rules = {}) {
  const errors = []
  const files = []
  const scope = flow?.scope?.data ?? flow?.pendingScope ?? {}
  const expected = scope?.in_scope?.files_expected_to_change ?? scope?.files_expected_to_change ?? []
  const sources = [expected, flow?.devChanges?.files ?? [], flow?.devChanges?.untracked ?? []]
  const entries = []
  if (flow?.devChanges?.error) errors.push('changes: ' + String(flow.devChanges.error))
  for (const [index, source] of sources.entries()) {
    if (!Array.isArray(source)) errors.push('files: expected an array')
    else entries.push(...source.map((entry) => index > 0 && typeof entry?.path === 'string' ? entry.path : entry))
  }
  let root
  let realRoot
  try {
    if (typeof flow?.cwd !== 'string' || !flow.cwd || !path.isAbsolute(flow.cwd)) throw new Error('absolute cwd required')
    root = path.resolve(flow.cwd)
    realRoot = fs.realpathSync.native(root)
    if (!fs.statSync(realRoot).isDirectory()) throw new Error('cwd is not a directory')
  } catch (error) {
    errors.push('cwd: ' + String(error?.code ?? error?.message ?? error))
  }

  const targets = new Map()
  for (const entry of entries) {
    try {
      if (!realRoot) throw new Error('workspace unavailable')
      const target = targetOf(root, entry)
      targets.set(target.relative, target)
    } catch (error) {
      const label = typeof entry === 'string' ? entry : String(entry)
      errors.push(label + ': ' + String(error?.code ?? error?.message ?? error))
      files.push({ path: label, hash: null, state: 'unsafe' })
    }
  }
  for (const target of [...targets.values()].sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)) {
    try {
      files.push(readEntry(root, realRoot, target))
    } catch (error) {
      errors.push(target.relative + ': ' + String(error?.code ?? error?.message ?? error))
      files.push({ path: target.relative, hash: null, state: 'error' })
    }
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  let scopeData = null
  let ruleData = null
  try {
    scopeData = stable(scope, true)
    // File declaration order and slash spelling do not change its meaning.
    const owner = scopeData?.in_scope ?? scopeData
    if (owner && Array.isArray(owner.files_expected_to_change) && realRoot) {
      owner.files_expected_to_change = [...new Set(owner.files_expected_to_change.map((entry) => targetOf(root, entry).relative))].sort()
    }
  } catch (error) {
    errors.push('scope: ' + String(error?.message ?? error))
  }
  try {
    ruleData = stable(rules)
  } catch (error) {
    errors.push('rules: ' + String(error?.message ?? error))
  }
  return {
    id: digest(JSON.stringify({ version: 2, scope: scopeData, rules: ruleData, files })),
    complete: errors.length === 0,
    files,
    errors: errors.sort(),
    at: new Date().toISOString(),
  }
}

/** Old reports without a complete, valid snapshot never qualify for reuse. */
export function sameSnapshot(left, right) {
  return left?.complete === true && right?.complete === true &&
    typeof left.id === 'string' && HEX_ID.test(left.id) && left.id === right.id
}

/** Count already classified findings; severity and gate membership are independent. */
export function findingCounts(angles) {
  const counts = { total: 0, critical: 0, major: 0, minor: 0, blocking: 0, advisories: 0, unscoped: 0 }
  for (const angle of Array.isArray(angles) ? angles : []) {
    for (const finding of Array.isArray(angle?.findings) ? angle.findings : []) {
      counts.total += 1
      if (finding?.severity === 'CRITICAL') counts.critical += 1
      if (finding?.severity === 'MAJOR') counts.major += 1
      if (finding?.severity === 'MINOR') counts.minor += 1
      if (finding?.blocking === true) counts.blocking += 1
      else counts.advisories += 1
      if (finding?.acMatched === false || finding?.fileInScope === false) counts.unscoped += 1
    }
    // Internal normalization preserves counts for findings beyond its hard cap.
    for (const key of Object.keys(counts)) {
      const omitted = angle?.omittedCounts?.[key]
      if (Number.isSafeInteger(omitted) && omitted >= 0) counts[key] += omitted
    }
  }
  return counts
}
