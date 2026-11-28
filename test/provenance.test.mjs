import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { captureSnapshot, sameSnapshot, findingCounts } from '../lib/provenance.js'

function cleanupFixture(entry, { io = fs, report = console.warn } = {}) {
  function isLink(target, stat) {
    if (stat.isSymbolicLink()) return true
    if (process.platform !== 'win32' || !stat.isDirectory()) return false

    // Some Windows junctions are reported as directories by lstat. Compare against the physical parent.
    const expected = path.join(io.realpathSync.native(path.dirname(target)), path.basename(target))
    try {
      return path.relative(expected, io.realpathSync.native(target)) !== ''
    } catch (error) {
      // lstat found an entry. Treat an unresolvable target as a dangling link.
      if (error.code === 'ENOENT') return true
      throw error
    }
  }

  function unlinkLink(target) {
    try {
      io.unlinkSync(target)
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'ENOENT'].includes(error.code)) throw error
      // Windows may report a missing target for a dangling junction. Remove only the entry.
      io.rmdirSync(target)
    }
  }

  function remove(target, listed = false) {
    try {
      let stat
      try {
        stat = io.lstatSync(target)
      } catch (error) {
        if (process.platform !== 'win32' || !listed || error.code !== 'ENOENT') throw error
        // A listed entry can still be present as a dangling Windows junction.
        unlinkLink(target)
        return true
      }
      if (isLink(target, stat)) {
        unlinkLink(target)
      } else if (stat.isDirectory()) {
        let empty = true
        for (const child of io.readdirSync(target)) {
          if (!remove(path.join(target, child), true)) empty = false
        }
        if (!empty) return false
        io.rmdirSync(target)
      } else {
        io.unlinkSync(target)
      }
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return true
      report(`Fixture cleanup failed for ${target}: ${error.code ?? 'UNKNOWN'}: ${error.message}`)
      return false
    }
  }

  remove(entry)
}

function fixture(run, cleanupOptions) {
  // Cleanup is confined to this one directory created by this invocation.
  const home = fs.mkdtempSync(path.join(tmpdir(), 'flowgate-provenance-'))
  const cwd = path.join(home, 'workspace')
  const put = (name, content) => {
    const target = path.join(cwd, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    return target
  }
  const flow = {
    cwd,
    scope: { data: {
      version: 1,
      frozen_at: '2026-01-01T00:00:00Z',
      in_scope: { files_expected_to_change: ['src/main.js'], commands: ['node test.mjs'] },
      acceptance_criteria: [{ id: 'AC-1', when: 'input', then: 'correct result' }],
    } },
    devChanges: { files: [], untracked: [] },
    // 这一轮的 scope 作业状态（G21）：手工夹具也要带全，否则读草稿的地方拿到 undefined。
    scopeCycle: { epoch: 1, draft: null, dropped: [], risks: [], riskLast: [], strikes: null, requests: [], pendingCommands: [], declinedCommands: [] },
  }
  try {
    fs.mkdirSync(cwd)
    put('src/main.js', 'first')
    return run({ home, cwd, put, flow })
  } finally {
    cleanupFixture(home, cleanupOptions)
  }
}

test('fixture cleanup reports a deletion failure without changing the test outcome', () => {
  const assertionFailure = new assert.AssertionError({ message: 'original assertion failure' })
  const result = Symbol('fixture result')
  for (const throwAssertion of [false, true]) {
    const diagnostics = []
    let home, blocked, sibling
    const io = {
      ...fs,
      unlinkSync(target) {
        if (target === blocked) {
          throw Object.assign(new Error('simulated deletion failure'), { code: 'EIO' })
        }
        fs.unlinkSync(target)
      },
    }
    const run = () => fixture((fixtureData) => {
      home = fixtureData.home
      blocked = fixtureData.put('blocked.txt', 'blocked')
      sibling = fixtureData.put('sibling.txt', 'sibling')
      if (throwAssertion) throw assertionFailure
      return result
    }, { io, report: (message) => diagnostics.push(message) })
    try {
      if (throwAssertion) assert.throws(run, (error) => error === assertionFailure)
      else assert.equal(run(), result)
      assert.deepEqual(diagnostics, [`Fixture cleanup failed for ${blocked}: EIO: simulated deletion failure`])
      assert.equal(fs.readFileSync(blocked, 'utf8'), 'blocked')
      assert.equal(fs.existsSync(sibling), false)
    } finally {
      if (home) cleanupFixture(home)
    }
  }
})

test('fixture cleanup removes a real directory link and preserves the external target', () => fixture(({ cwd: outside, put }) => {
  const sentinel = put('nested/sentinel.txt', 'outside fixture')
  const home = fixture(({ home, cwd }) => {
    const link = path.join(cwd, 'external')
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(fs.realpathSync.native(link), fs.realpathSync.native(outside))
    assert.equal(fs.readFileSync(path.join(link, 'nested', 'sentinel.txt'), 'utf8'), 'outside fixture')
    return home
  })
  assert.throws(() => fs.lstatSync(home), { code: 'ENOENT' })
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside fixture')
  assert.deepEqual(fs.readdirSync(path.dirname(sentinel)), ['sentinel.txt'])
}))

const rules = { pluginVersion: '0.1.0', config: { cap: 30, strict: true } }
const hash = (value) => createHash('sha256').update(value).digest('hex')

test('hashes full file bytes and returns the persisted snapshot contract', () => fixture(({ flow }) => {
  const snapshot = captureSnapshot(flow, rules)
  assert.equal(snapshot.complete, true, snapshot.errors.join('; '))
  assert.match(snapshot.id, /^[a-f0-9]{64}$/)
  assert.deepEqual(snapshot.files, [{ path: 'src/main.js', hash: hash('first'), state: 'present' }])
  assert.deepEqual(snapshot.errors, [])
  assert.ok(Number.isFinite(Date.parse(snapshot.at)))
  assert.deepEqual(Object.keys(snapshot).sort(), ['at', 'complete', 'errors', 'files', 'id'])
  assert.equal(sameSnapshot(snapshot, captureSnapshot(flow, rules)), true)
}))

test('same path, same size and restored mtime still invalidate changed content', () => fixture(({ flow, cwd, put }) => {
  const before = captureSnapshot(flow, rules)
  const file = path.join(cwd, 'src/main.js')
  const stat = fs.statSync(file)
  put('src/main.js', 'other')
  fs.utimesSync(file, stat.atime, stat.mtime)
  const after = captureSnapshot(flow, rules)
  assert.equal(after.complete, true)
  assert.notEqual(after.id, before.id)
  assert.equal(sameSnapshot(before, after), false)
}))

test('reads binary content beyond a short prefix, without text decoding loss', () => fixture(({ flow, put }) => {
  const bytes = Buffer.alloc(128 * 1024, 0xff)
  put('src/main.js', bytes)
  const first = captureSnapshot(flow)
  bytes[bytes.length - 1] = 0xfe
  put('src/main.js', bytes)
  const second = captureSnapshot(flow)
  assert.equal(second.files[0].hash, hash(bytes))
  assert.notEqual(first.id, second.id)
}))

test('unions scope, changed and untracked paths with stable portable ordering', () => fixture(({ flow, put, cwd }) => {
  put('路径/有 空格.txt', '你好🌏')
  put('z.txt', '')
  flow.devChanges = { files: ['src\\main.js', './z.txt'], untracked: ['路径\\有 空格.txt', 'z.txt'] }
  const before = captureSnapshot(flow, rules)
  assert.equal(before.complete, true, before.errors.join('; '))
  assert.deepEqual(before.files.map((entry) => entry.path), ['src/main.js', 'z.txt', '路径/有 空格.txt'])
  assert.equal(before.files[2].hash, hash('你好🌏'))
  flow.devChanges = { files: [{ path: path.join(cwd, 'z.txt') }, '路径/有 空格.txt'], untracked: ['src/main.js'] }
  const after = captureSnapshot(flow, { config: { strict: true, cap: 30 }, pluginVersion: '0.1.0' })
  assert.equal(after.id, before.id)
  assert.equal(after.complete, true, after.errors.join('; '))
}))

test('scope file declaration ordering, duplicates and Windows slashes are stable', () => fixture(({ flow, put }) => {
  put('src/extra.js', 'extra')
  flow.scope.data.in_scope.files_expected_to_change = ['src/main.js', 'src/extra.js']
  const before = captureSnapshot(flow)
  flow.scope.data.in_scope.files_expected_to_change = ['src\\extra.js', './src/main.js', 'src/main.js']
  assert.equal(captureSnapshot(flow).id, before.id)
}))

test('new, removed and untracked file membership all invalidate the whole snapshot', () => fixture(({ flow, put }) => {
  const base = captureSnapshot(flow)
  put('new.js', 'new')
  flow.devChanges.untracked = ['new.js']
  const added = captureSnapshot(flow)
  assert.notEqual(added.id, base.id)
  put('new.js', 'NEW')
  assert.notEqual(captureSnapshot(flow).id, added.id)
  flow.devChanges.untracked = []
  assert.equal(captureSnapshot(flow).id, base.id)
  flow.scope.data.in_scope.files_expected_to_change.push('new.js')
  assert.notEqual(captureSnapshot(flow).id, base.id)
}))

test('deletion and creation of a missing declared file are complete but different states', () => fixture(({ flow, cwd, put }) => {
  const present = captureSnapshot(flow)
  fs.unlinkSync(path.join(cwd, 'src/main.js'))
  const deleted = captureSnapshot(flow)
  assert.equal(deleted.complete, true)
  assert.deepEqual(deleted.files, [{ path: 'src/main.js', hash: null, state: 'missing' }])
  assert.notEqual(deleted.id, present.id)
  assert.equal(sameSnapshot(deleted, captureSnapshot(flow)), true)
  put('src/main.js', '')
  assert.notEqual(captureSnapshot(flow).id, deleted.id)
}))

test('pendingScope fallback includes its file list and acceptance criteria', () => fixture(({ flow }) => {
  flow.scopeCycle.draft = { files_expected_to_change: ['src/main.js'], acceptance_criteria: [{ id: 'AC-1', then: 'ok' }] }
  delete flow.scope
  const before = captureSnapshot(flow)
  assert.equal(before.complete, true)
  assert.equal(before.files[0].hash, hash('first'))
  flow.scopeCycle.draft.acceptance_criteria[0].then = 'new behavior'
  assert.notEqual(captureSnapshot(flow).id, before.id)
}))

test('AC, shared contracts, commands, parsed rules and plugin version affect provenance', () => fixture(({ flow }) => {
  const base = captureSnapshot(flow, rules)
  for (const update of [
    (next) => { next.scope.data.acceptance_criteria[0].then = 'changed' },
    (next) => { next.scope.data.in_scope.commands.push('node another.mjs') },
    (next) => { next.scope.data.in_scope.shared_contracts = ['changed API contract'] },
  ]) {
    const next = structuredClone(flow)
    update(next)
    assert.notEqual(captureSnapshot(next, rules).id, base.id)
  }
  assert.notEqual(captureSnapshot(flow, { ...rules, pluginVersion: '0.2.0' }).id, base.id)
  assert.notEqual(captureSnapshot(flow, { ...rules, config: { ...rules.config, cap: 31 } }).id, base.id)
}))

test('report contents, capture time and scope timestamp metadata do not affect content id', () => fixture(({ flow }) => {
  const before = captureSnapshot(flow, rules)
  flow.scope.data.frozen_at = '2030-01-01T00:00:00Z'
  flow.scope.data.updatedAt = '2031-01-01T00:00:00Z'
  flow.at = 'later'
  flow.review = { angles: [{ findings: [{ severity: 'CRITICAL', summary: 'different report' }] }] }
  flow.test = { directions: [{ points: [{ result: 'fail' }] }] }
  flow.devChanges.at = 'later'
  const after = captureSnapshot(flow, rules)
  assert.equal(after.id, before.id)
  assert.equal(sameSnapshot({ ...before, at: 'old' }, { ...after, at: 'new' }), true)
}))

test('directory and non-directory intermediate paths fail closed', () => fixture(({ flow }) => {
  for (const name of ['src', 'src/main.js/child.js']) {
    flow.scope.data.in_scope.files_expected_to_change = [name]
    const result = captureSnapshot(flow)
    assert.equal(result.complete, false)
    assert.equal(result.files[0].state, 'error')
    assert.ok(result.errors.length)
    assert.equal(sameSnapshot(result, captureSnapshot(flow)), false)
  }
}))

test('read failure on an opened real file retains errors and never authorizes reuse', () => fixture(({ flow }) => {
  const originalRead = fs.readFileSync
  let attempted = false
  fs.readFileSync = function (descriptor, ...args) {
    if (typeof descriptor === 'number') {
      attempted = true
      const error = new Error('simulated storage read failure')
      error.code = 'EIO'
      throw error
    }
    return originalRead.call(this, descriptor, ...args)
  }
  try {
    const failed = captureSnapshot(flow)
    assert.equal(attempted, true)
    assert.equal(failed.complete, false)
    assert.equal(failed.files[0].hash, null)
    assert.equal(failed.files[0].state, 'error')
    assert.ok(failed.errors.some((error) => error.includes('EIO')))
    assert.equal(sameSnapshot(failed, failed), false)
  } finally { fs.readFileSync = originalRead }
  assert.equal(captureSnapshot(flow).complete, true)
}))

test('unsafe relative, absolute, drive-relative, UNC, device and alternate-stream paths fail closed', () => fixture(({ flow, home }) => {
  const outside = path.join(home, 'outside.txt')
  fs.writeFileSync(outside, 'never read this')
  const originalRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (...args) { reads += 1; return originalRead.apply(this, args) }
  try {
    for (const entry of ['../outside.txt', outside, 'C:outside.txt', '\\\\server\\share\\file', 'NUL', 'file:stream', '', 'bad\0name', 'src/main.js.']) {
      flow.scope.data.in_scope.files_expected_to_change = [entry]
      const result = captureSnapshot(flow)
      assert.equal(result.complete, false, JSON.stringify(entry))
      assert.ok(result.errors.length)
      assert.equal(sameSnapshot(result, result), false)
    }
    assert.equal(reads, 0)
  } finally { fs.readFileSync = originalRead }
}))

test('external directory junction is rejected before reading its target', () => fixture(({ flow, cwd, home }) => {
  const outside = path.join(home, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.js'), 'outside')
  fs.symlinkSync(outside, path.join(cwd, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  flow.scope.data.in_scope.files_expected_to_change = ['external/secret.js', 'external/absent.js']
  const originalRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (...args) { reads += 1; return originalRead.apply(this, args) }
  try {
    const result = captureSnapshot(flow)
    assert.equal(result.complete, false, JSON.stringify(result))
    assert.equal(result.files.length, 2)
    assert.ok(result.files.every((entry) => entry.hash === null && entry.state === 'error'))
    assert.equal(reads, 0)
    assert.ok(result.errors.every((entry) => entry.includes('unsafe link outside workspace')))
  } finally { fs.readFileSync = originalRead }
}))

test('internal directory junction reads an ordinary file inside the same workspace', () => fixture(({ flow, cwd }) => {
  fs.symlinkSync(path.join(cwd, 'src'), path.join(cwd, 'internal'), process.platform === 'win32' ? 'junction' : 'dir')
  flow.scope.data.in_scope.files_expected_to_change = ['internal/main.js']
  const result = captureSnapshot(flow)
  assert.equal(result.complete, true, result.errors.join('; '))
  assert.equal(result.files[0].hash, hash('first'))
}))

test('invalid cwd, malformed lists, invalid rules and failed change collection fail closed', () => fixture(({ flow }) => {
  for (const next of [
    { ...flow, cwd: '' },
    { ...flow, cwd: 'relative' },
    { ...flow, devChanges: { files: 'src/main.js' } },
    { ...flow, devChanges: { files: [], error: 'git status failed' } },
  ]) {
    const result = captureSnapshot(next)
    assert.equal(result.complete, false)
    assert.equal(sameSnapshot(result, result), false)
  }
  const circular = {}; circular.self = circular
  const invalid = captureSnapshot(flow, circular)
  assert.equal(invalid.complete, false)
  assert.ok(invalid.errors.some((error) => error.startsWith('rules:')))
}))

test('sameSnapshot rejects old, partial, malformed and missing snapshots', () => {
  const good = { complete: true, id: 'a'.repeat(64) }
  assert.equal(sameSnapshot(good, { ...good }), true)
  for (const bad of [undefined, null, {}, { id: good.id }, { ...good, complete: false }, { ...good, id: '' }, { ...good, id: 'old-version' }]) {
    assert.equal(sameSnapshot(good, bad), false)
    assert.equal(sameSnapshot(bad, good), false)
    assert.equal(sameSnapshot(bad, bad), false)
  }
})

test('findingCounts counts all severities and all nonblocking findings, including MINOR', () => {
  const counts = findingCounts([{ findings: [
    { severity: 'CRITICAL', blocking: true, acMatched: true, fileInScope: true },
    { severity: 'MAJOR', blocking: true, acMatched: true, fileInScope: true },
    { severity: 'MINOR', blocking: false, acMatched: true, fileInScope: true },
    { severity: 'CRITICAL', blocking: false, acMatched: false, fileInScope: true },
  ] }, { findings: [
    { severity: 'MAJOR', blocking: false, acMatched: true, fileInScope: false },
    { severity: 'MINOR', acMatched: false, fileInScope: false },
    { severity: 'UNKNOWN' },
  ] }])
  // 未核实与严重度正交：这批发现没有 unverified 标记，两个新计数必须为 0。
  assert.deepEqual(counts, { total: 7, critical: 2, major: 2, minor: 2, blocking: 2, advisories: 5, unscoped: 3, unverified: 0, unverifiedSevere: 0 })
})

test('findingCounts separates unverified from blocking without changing severity', () => {
  const counts = findingCounts([{ findings: [
    // 未核实的严重项：严重度不动，但不能当阻塞项。
    { severity: 'CRITICAL', blocking: false, acMatched: true, fileInScope: true, unverified: true },
    // 未核实的轻微项：只进 unverified，不进 unverifiedSevere。
    { severity: 'MINOR', blocking: false, acMatched: true, fileInScope: true, unverified: true },
    { severity: 'MAJOR', blocking: true, acMatched: true, fileInScope: true },
  ] }])
  // 两类未核实都落进 advisories（blocking 判据已排除它们），只有一条已核实项算阻塞。
  assert.deepEqual(counts, { total: 3, critical: 1, major: 1, minor: 1, blocking: 1, advisories: 2, unscoped: 0, unverified: 2, unverifiedSevere: 1 })
})

test('findingCounts includes trusted omittedCounts beyond the report hard cap', () => {
  const counts = findingCounts([{ findings: [{ severity: 'MINOR', blocking: false }], omittedCounts: {
    total: 205, critical: 20, major: 80, minor: 105, blocking: 90, advisories: 115, unscoped: 7,
  } }, { findings: [], omittedCounts: { total: -1, minor: 1.5, critical: '2', major: NaN, blocking: Infinity } }])
  // omittedCounts 里没有未核实键，叠加后仍为 0：超上限的省略项不做内容校验。
  assert.deepEqual(counts, { total: 206, critical: 20, major: 80, minor: 106, blocking: 90, advisories: 116, unscoped: 7, unverified: 0, unverifiedSevere: 0 })
})

test('findingCounts tolerates missing angle lists and counts every supplied finding once', () => {
  const zero = { total: 0, critical: 0, major: 0, minor: 0, blocking: 0, advisories: 0, unscoped: 0, unverified: 0, unverifiedSevere: 0 }
  for (const input of [undefined, null, {}, [null, {}, { findings: 'invalid' }]]) assert.deepEqual(findingCounts(input), zero)
  assert.deepEqual(findingCounts([{ findings: [null, {}, { blocking: false }] }]), { ...zero, total: 3, advisories: 3 })
})
