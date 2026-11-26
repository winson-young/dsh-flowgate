// 受限沙箱拒绝的是「用管道 stdio 派生进程」，不是派生本身：同一个子进程用
// stdio: 'pipe' 直接报 EPERM，把 stdout/stderr 指向真实文件描述符却能正常退出并写满输出。
// 捕获因此走文件——开临时文件、派生、读回、删掉；临时文件打不开才回落到管道，
// 普通环境照旧走管道，受限环境恢复「一条命令跑全量」。
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_CAPTURE = 16 * 1024 * 1024

function readCapped(file) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.length > MAX_CAPTURE ? text.slice(0, MAX_CAPTURE) : text
  } catch {
    return ''
  }
}

/**
 * 与 spawnSync 同形的捕获：stdout / stderr 一律是字符串，error 原样带出。
 * options 支持 spawnSync 的 cwd / env / timeout / killSignal / shell / maxBuffer。
 * 需要 stdin 的调用（input）只能走管道——那条路在受限沙箱里本来就跑不通，
 * 回落比假装支持更诚实。
 */
export function captureSync(command, args = [], options = {}) {
  const { input, maxBuffer = MAX_CAPTURE, cwd, env, ...rest } = options
  const base = { cwd, env, windowsHide: true, ...rest }
  if (input !== undefined) {
    const child = spawnSync(command, args, { ...base, input, encoding: 'utf8', maxBuffer })
    return { ...child, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
  }
  const stamp = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dirs = cwd ? [tmpdir(), cwd] : [tmpdir()]
  for (const dir of dirs) {
    const outPath = join(dir, `.tmp-capture-${stamp}.out.log`)
    const errPath = join(dir, `.tmp-capture-${stamp}.err.log`)
    let outFd
    let errFd
    try {
      outFd = openSync(outPath, 'w')
      errFd = openSync(errPath, 'w')
    } catch {
      for (const fd of [outFd, errFd]) {
        try {
          if (typeof fd === 'number') closeSync(fd)
        } catch {}
      }
      continue
    }
    try {
      const child = spawnSync(command, args, { ...base, stdio: ['ignore', outFd, errFd] })
      return { ...child, stdout: readCapped(outPath), stderr: readCapped(errPath) }
    } finally {
      // Windows 上删不掉还开着的文件，先关再删。
      for (const fd of [outFd, errFd]) {
        try {
          closeSync(fd)
        } catch {}
      }
      for (const file of [outPath, errPath]) {
        try {
          rmSync(file, { force: true })
        } catch {}
      }
    }
  }
  const child = spawnSync(command, args, { ...base, encoding: 'utf8', maxBuffer })
  return { ...child, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
}

/** 异步版本，用于「同时跑两个子进程」这类需要真并发的用例。 */
export function capture(command, args = [], options = {}) {
  const { input, maxBuffer = MAX_CAPTURE, cwd, env, ...rest } = options
  const base = { cwd, env, windowsHide: true, ...rest }
  const stamp = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dirs = cwd ? [tmpdir(), cwd] : [tmpdir()]
  for (const dir of dirs) {
    const outPath = join(dir, `.tmp-capture-${stamp}.out.log`)
    const errPath = join(dir, `.tmp-capture-${stamp}.err.log`)
    let outFd
    let errFd
    try {
      outFd = openSync(outPath, 'w')
      errFd = openSync(errPath, 'w')
    } catch {
      for (const fd of [outFd, errFd]) {
        try {
          if (typeof fd === 'number') closeSync(fd)
        } catch {}
      }
      continue
    }
    const cleanup = () => {
      for (const fd of [outFd, errFd]) {
        try {
          closeSync(fd)
        } catch {}
      }
      for (const file of [outPath, errPath]) {
        try {
          rmSync(file, { force: true })
        } catch {}
      }
    }
    return new Promise((resolve) => {
      const child = spawn(command, args, { ...base, stdio: ['ignore', outFd, errFd] })
      // 先把文件读回来再清理：cleanup 会删掉这两个文件，先删后读只会拿到空串。
      child.on('error', (error) => {
        const stdout = readCapped(outPath)
        const stderr = readCapped(errPath)
        cleanup()
        resolve({ status: null, signal: null, stdout, stderr, error })
      })
      child.on('close', (status, signal) => {
        const stdout = readCapped(outPath)
        const stderr = readCapped(errPath)
        cleanup()
        resolve({ status, signal, stdout, stderr })
      })
    })
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...base, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += String(chunk)
    })
    child.on('error', (error) => resolve({ status: null, signal: null, stdout, stderr, error }))
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
  })
}
