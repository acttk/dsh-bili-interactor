// /state 必须永远能序列化。
// 这个测试盯的是那个让整个面板卡死的 bug：
//   rt 里塞了 setInterval 返回的 Timer（内部 _idlePrev/_idleNext 循环引用），
//   而 stateNow() 返回 run: { ...rt } → JSON.stringify 抛
//   "Converting circular structure to JSON" → /state 挂住 → 面板空白。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const host = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

console.log('== 1) rt 里不能出现 Timer / 函数这类不可序列化的东西 ==')
// 找所有 rt.xxx = setInterval / setTimeout
const badAssign = [...host.matchAll(/rt\.([a-zA-Z0-9_]+)\s*=\s*(setInterval|setTimeout)\s*\(/g)]
check('没有把 Timer 存进 rt', badAssign.length === 0,
  badAssign.map((m) => 'rt.' + m[1]).join(','))

console.log('== 2) Timer 必须放在模块级变量里 ==')
check('有模块级 runQueueTimer', /let runQueueTimer = null/.test(host))
check('watcher 用模块级变量', /runQueueTimer = setInterval\(/.test(host))
check('热重载会清掉遗留的 Timer', /delete rt\[k\]/.test(host) || /delete rt\.runQueueTimer/.test(host))

console.log('== 3) /state 不能整个展开 rt ==')
// 先去掉注释行，别把注释里举反例的写法当成真代码
const hostCode = host.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
check('不再用 run: { ...rt }', !/run:\s*\{\s*\.\.\.rt\s*\}/.test(hostCode), '整展开会把任何脏东西带出去')
check('改成了白名单 runView', /const runView = \{/.test(host))
check('返回用 runView', /run:\s*runView/.test(host))

console.log('== 4) 白名单要包含前端真正读的字段 ==')
const need = ['running', 'phase', 'error', 'runQueued', 'stopRequested']
for (const k of need) {
  check('runView 有 ' + k, new RegExp(k + '\\s*:').test(host.slice(host.indexOf('const runView'), host.indexOf('const runView') + 500)))
}

console.log('== 5) 模拟：带 Timer 的对象确实不能 stringify（证明这个测试有意义）==')
const t = setInterval(() => {}, 99999)
let threw = false
try { JSON.stringify({ timer: t }) } catch { threw = true }
clearInterval(t)
check('Timer 确实无法 JSON 序列化', threw, '如果不抛错说明这个测试防的东西不存在')

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
