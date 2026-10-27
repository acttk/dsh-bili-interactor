// 宿主不能引用未声明的变量 —— 我改动搜索循环时漏了 maxPages 的声明，
// 结果运行到「搜第一个关键词」就报 maxPages is not defined，整轮空手。
// 这类错误 node --check 查不出来（语法合法），只有真跑才暴露。
// 这里做一个粗暴但有效的静态检查：把 lib/*.js 里像变量又找不到声明的名字列出来。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

// 只查最近改动过风险高的那些名字（真做全量作用域分析很复杂，收益不大）
const files = ['lib/index.js', 'lib/state.js', 'lib/danmaku.js', 'lib/targets.js', 'lib/learn.js', 'lib/ignore.js', 'lib/seen.js']
const WATCH = [
  'maxPages', 'wantFreshPerKw', 'kwCount', 'searchLimit', 'freshAll', 'gotAny', 'lastErr', 'whyAll',
  'tickStartAt', 'costMs', 'runQueueTimer', 'visScanBusy', 'runPreflight', 'checkBeforeReply',
  'pre', 'gate', 'farewell', 'hiddenSet', 'publicSet', 'oneItem', 'doneList', 'runView',
]

const all = files.map((f) => {
  try { return { f, src: readFileSync(join(root, f), 'utf8') } } catch { return null }
}).filter(Boolean)

console.log('== 检查高风险标识符是否都有声明 ==')
for (const name of WATCH) {
  let usedSomewhere = false
  let declaredSomewhere = false
  for (const { src } of all) {
    if (new RegExp('\\b' + name + '\\b').test(src)) usedSomewhere = true
    // 声明形式：const/let/var name、function name(、name: 作为对象键或参数、解构
    if (new RegExp('(const|let|var)\\s+' + name + '\\b').test(src)) declaredSomewhere = true
    if (new RegExp('function\\s+' + name + '\\b').test(src)) declaredSomewhere = true
    if (new RegExp('(^|[,({\\s])' + name + '\\s*[,:)]').test(src)) declaredSomewhere = true
  }
  if (!usedSomewhere) continue  // 这个文件里没用到，跳过
  check(name + ' 有声明', declaredSomewhere, '用了但可能是隐式全局')
}

console.log('== 搜索翻页的关键变量必须都在 runOnce 作用域里声明 ==')
const idx = all.find((x) => x.f === 'lib/index.js').src
for (const n of ['maxPages', 'wantFreshPerKw', 'searchLimit']) {
  const usedAt = idx.indexOf(n + ' =') >= 0 || idx.indexOf('<= ' + n) >= 0 || idx.indexOf(n + ') break') >= 0
  const decl = new RegExp('(const|let)\\s+' + n + '\\b').test(idx)
  check(n + (decl ? ' 已声明' : ' 缺声明'), decl, usedAt ? '（代码里确实在用）' : '')
}

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
