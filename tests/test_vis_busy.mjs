// 可见性扫描的「忙」判断：必须看 running，不能只看对象存不存在
import { visScanBusy } from '../lib/index.js'

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

console.log('== 1) 从来没跑过 ==')
check('null 不算忙', visScanBusy(null) === false)
check('undefined 不算忙', visScanBusy(undefined) === false)

console.log('== 2) 正在跑 ==')
check('running=true 算忙', visScanBusy({ running: true }) === true)

console.log('== 3) 跑完了（这是那个 bug 的关键）==')
// 扫描完成后 rt.visScan 仍是非空对象，running=false。
// 以前写成 if (rt.visScan) 就会永远判定忙 → 查过一次后再也点不动。
check('running=false 不算忙', visScanBusy({ running: false }) === false)
check('跑完带结果也不算忙', visScanBusy({
  running: false, done: 118, total: 118, hidden: 15,
  items: [{ rpid: '1' }], message: '查了 118 个楼',
}) === false)

console.log('== 4) 只有 running 明确为 true 才算忙 ==')
check('缺 running 字段不算忙', visScanBusy({ done: 5 }) === false)
check('running="true" 字符串不算忙', visScanBusy({ running: 'true' }) === false)

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
