// UI 里的数字必须是「算出来的」，不能是写死的常量。
// 这个测试盯的是用户抓到的那类问题：
//   · 「3 分钟轮完一圈」→ 把轮数当分钟数
//   · 「每分钟 50 次请求」→ 实际是 50 个请求摊在几分钟里
//   · 「由后台监听每分钟检查」→ 写死了「每分钟」，用户设的是 3 分钟
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const client = readFileSync(join(here, '..', 'client.js'), 'utf8')
const host = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

// 去掉注释行，只看真代码
const codeOnly = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const c = codeOnly(client)

console.log('== 1) 不能把「轮数」当「分钟数」用 ==')
// 错法：`${rounds} 分钟` —— rounds 是轮数不是分钟
const badRounds = [...c.matchAll(/\$\{(\w*rounds\w*)\}\s*分钟/g)]
check('没有 ${rounds} 分钟 这种写法', badRounds.length === 0,
  badRounds.map((m) => m[0]).join(','))

console.log('== 2) 一圈时长必须同时算「每轮耗时」和「间隔」==')
check('算了每轮耗时（costMin 或 costSec）', /costMin|costSec/.test(c))
check('算了间隔（every 或 listenIntervalMin）', /listenIntervalMin/.test(c))
check('一圈 = 轮数 × (每轮 + 间隔)', /\*\s*\(\s*costMin\s*\+\s*every\s*\)/.test(c),
  '只乘间隔会漏掉每轮本身的耗时')

console.log('== 3) 请求速率不能写成「每分钟 = per 次」==')
// 错法：`每分钟最多 ${listenMaxThreadsPerTick} 次`
const badRate = [...c.matchAll(/每分钟[^`'"]{0,12}\$\{[^}]*listenMaxThreadsPerTick[^}]*\}/g)]
check('没有「每分钟 = listenMaxThreadsPerTick」这种写法', badRate.length === 0,
  badRate.map((m) => m[0]).join(','))
check('速率是按 per / (每轮+间隔) 算的', /perMin/.test(c))

console.log('== 4) 「每分钟检查」不能写死 ==')
// 错法：字面量「每分钟检查」/「每分钟一次」
check('没有写死「每分钟检查」', !/每分钟检查/.test(c))
check('有读 listenIntervalMin 的地方', /listenIntervalMin/.test(c))

console.log('== 5) 宿主必须上报每轮实测耗时 ==')
check('rt.backLast 有 costMs', /costMs\s*:/.test(host))
check('costMs 是真的量出来的', /Date\.now\(\)\s*-\s*tickStartAt/.test(host))

console.log('== 6) 措辞：说「楼」不说「条」==')
check('解释里提到「按楼算」', /按「楼」算/.test(c))
check('没有「你发过的每条评论算一条」这种错说法', !/每条评论算一条/.test(c))

console.log('== 7) 数字格式：小数要有位数控制 ==')
// 不做硬要求，只确认关键的都用 toFixed
check('分钟数用了 toFixed', /toFixed\(/.test(c))

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
