// 「立刻检查一次」的返回契约：宿主必须给 ok，前端不能靠猜
// 这个测试盯的是那个「跑成功了却显示检查失败」的 bug。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const host = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const client = readFileSync(join(here, '..', 'client.js'), 'utf8')

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

console.log('== 1) 宿主 /reply-back/now 必须带 ok 字段 ==')
const nowBlock = host.slice(host.indexOf("p === '/reply-back/now'"), host.indexOf("p === '/reply-back/now'") + 2600)
check('找到端点', nowBlock.length > 100)
check('同步模式返回带 ok', /ok:\s*r\?\.started === true/.test(nowBlock), '没补 ok 的话前端永远判失败')
check('async 模式返回带 ok', /ok:\s*true,\s*started:\s*true,\s*async:\s*true/.test(nowBlock))

console.log('== 2) 必须有进度接口 ==')
check('有 /reply-back/now/status', host.includes("p === '/reply-back/now/status'"))
check('进度写在 rt.backLive', host.includes('rt.backLive'))

console.log('== 3) 前端不能再用 j.ok 判断这个按钮 ==')
// 取出这个按钮的 onClick 片段
const i = client.indexOf("post('/reply-back/now'")
const seg = client.slice(Math.max(0, i - 800), i + 2200)
check('找到了按钮逻辑', i > 0)
check('改成了 async 模式', /async:\s*true/.test(seg))
check('会轮询进度', seg.includes('/reply-back/now/status'))
check('按 busy 单独判断', seg.includes('j && j.busy'))
check('按 error 单独判断', seg.includes('j && j.error'))

console.log('== 4) 运算符优先级那个坑不能回来 ==')
// 错误写法：j?.error || j?.busy ? 'a' : 'b'   （实际是 (a||b) ? ...）
const badPattern = /\w+\?\.\w+\s*\|\|\s*\w+\?\.\w+\s*\?/
check('没有 a||b ? x : y 这种写法', !badPattern.test(client), '有的话会把真实原因吞掉')

console.log('== 5) 防连点 ==')
check('有 backLock', client.includes('backLock'))
check('按钮 disabled 用了 backLock', /disabled:\s*busy === 'backnow' \|\| backLock/.test(client))

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
