// 真实 spawn 探针单独成一个入口。
//
// 为什么单独：这组用例要起真进程才能证明「纯解析真的不执行正文」。留在主套件里，
// 受限沙箱禁止派生进程时只有两种结局——静默消失，或把宿主限制记成用例失败。
// 单独成入口之后，跑不了就显式报 SKIP（FLOWGATE_TEST_SKIP），跑得了就报「全部通过：N 项」。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureSync } from '../scripts/capture-child.mjs'

const passed = []
function check(label, fn) {
  try {
    fn()
    passed.push(label)
  } catch (error) {
    console.error('FAIL ' + label)
    throw error
  }
}

const ws = mkdtempSync(join(tmpdir(), 'flowgate-node-check-'))
const marker = join(ws, 'preload-wrote.txt')
const bodyMarker = join(ws, 'body-wrote.txt')
const preload = join(ws, 'preload.cjs')
const source = join(ws, '语法 检查.cjs')

try {
  writeFileSync(preload, 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "preload")\n')
  writeFileSync(source, 'require("node:fs").writeFileSync(' + JSON.stringify(bodyMarker) + ', "body")\n')
  // 捕获走 captureSync：受限沙箱拒绝管道 stdio，文件描述符不拒绝。
  const nodeCheck = (args) => {
    const result = captureSync(process.execPath, ['--check', ...args], {
      cwd: ws,
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('node --check 失败：' + result.stderr)
    return result
  }

  let spawnable = true
  let blocked = ''
  try {
    nodeCheck([source])
  } catch (error) {
    // 只有「进程根本没起来」才算环境限制；--check 真跑了但退出非 0 仍要判失败。
    if (!['EPERM', 'EACCES', 'ENOENT'].includes(error?.code)) throw error
    spawnable = false
    blocked = error.code
  }

  if (!spawnable) {
    // 完成行与 SKIP 分开：聚合器先认完成行，再据 FLOWGATE_TEST_SKIP 判 SKIP。
    console.log('未执行：宿主禁止 spawn 子进程（' + blocked + '）')
    console.log('FLOWGATE_TEST_SKIP ' + JSON.stringify({
      reason: '真实 Node --check 真进程验证 2 条未执行：宿主禁止 spawn 子进程（' + blocked + '）',
    }))
  } else {
    check('真实 Node --check 单文件只解析，不执行正文', () => {
      assert.equal(existsSync(bodyMarker), false)
      assert.equal(existsSync(marker), false)
    })
    nodeCheck(['--require', preload, source])
    check('真实 Node --check --require 仍执行 preload 并写盘', () => {
      assert.equal(readFileSync(marker, 'utf8'), 'preload')
      assert.equal(existsSync(bodyMarker), false)
    })
    console.log('\n全部通过：' + passed.length + ' 项')
  }
} finally {
  rmSync(ws, { recursive: true, force: true })
}
