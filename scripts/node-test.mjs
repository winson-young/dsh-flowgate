// 受限沙箱拒绝的是「用管道 stdio 派生进程」，而 `node --test` 恰恰为每个测试文件派生
// 一个子进程并用管道收输出——于是在沙箱里整套测试只剩 `spawn EPERM`，看起来像测试坏了。
// `--experimental-test-isolation=none` 让运行器在当前进程里跑，不再派生，问题就消失了。
// 这个选项 Node 22.8+ 才有，所以先探测：不支持就退回原来的行为，别让老版本直接报错。
//
// 别用它跑「顶层 await test(...)」的套件：Node 26.13 下隔离关掉 + 顶层 await 会挂死
// （三行最小复现即可复现，超时退出 124）。那种套件直跑就行。
import { spawnSync } from 'node:child_process'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node scripts/node-test.mjs <测试文件...>')
  process.exit(2)
}

const probe = spawnSync(process.execPath, ['--experimental-test-isolation=none', '-e', ''], {
  stdio: 'ignore',
  windowsHide: true,
  timeout: 60_000,
})
const isolation = probe.status === 0 ? ['--experimental-test-isolation=none'] : []

// stdio: 'inherit' 不是管道，沙箱不拦；被聚合器调用时，父进程已经把这条通道接进文件了。
const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...isolation, ...files], {
  stdio: 'inherit',
  windowsHide: true,
  timeout: 300_000,
  killSignal: 'SIGKILL',
})
if (child.error && ['EPERM', 'EACCES'].includes(child.error.code)) {
  // 进程根本没起来，不是测试失败：显式记 SKIP，退出 0，由聚合器汇总成 SKIP。
  // 边界只限「起不来」：真跑过但失败的 child.status 仍按原样传出去。
  console.log('FLOWGATE_TEST_SKIP ' + JSON.stringify({
    reason: '宿主禁止子进程，本套未执行（' + child.error.code + '）',
  }))
  process.exitCode = 0
} else {
  process.exitCode = typeof child.status === 'number' ? child.status : 1
}
