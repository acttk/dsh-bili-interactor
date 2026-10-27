// 可见性统计：三类拆分必须对，且「累计查过」不能写成「上次」
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildState, localIso } from '../lib/state.js'

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

const home = join(tmpdir(), 'bi-visstats')
const mk = (pub, hint) => ({ public: pub, hint, at: localIso() })

console.log('== 1) 三类拆分：公开 / 被折叠 / 已删 ==')
rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true })
const map = {}
for (let i = 0; i < 356; i++) map['p' + i] = mk(true, '公开可见')
for (let i = 0; i < 66; i++) map['f' + i] = mk(false, '只有你自己能看到 —— 审核中或被折叠，别人刷不到')
for (let i = 0; i < 8; i++) map['g' + i] = mk(false, '你自己也看不到 —— 可能已被删除，或者根本不在这个楼里')
writeFileSync(join(home, 'visibility.json'), JSON.stringify({ at: localIso(), map }), 'utf8')
writeFileSync(join(home, 'ledger.jsonl'),
  JSON.stringify({ ts: localIso(), kind: 'like', ok: true, bvid: 'BV1x', title: 't' }) + '\n', 'utf8')

const vs = buildState(home, { version: 't' }).visStats
check('checked = 430（累计）', vs.checked === 430, String(vs.checked))
check('publicCnt = 356', vs.publicCnt === 356, String(vs.publicCnt))
check('folded = 66（被折叠）', vs.folded === 66, String(vs.folded))
check('gone = 8（已看不到）', vs.gone === 8, String(vs.gone))
check('hidden = 74（66 + 8）', vs.hidden === 74, String(vs.hidden))
check('hidden 等于两类之和', vs.hidden === vs.folded + vs.gone)
check('selfOnly 兼容字段 = folded', vs.selfOnly === vs.folded)
check('三类加起来等于总数', vs.publicCnt + vs.folded + vs.gone === vs.checked,
  String(vs.publicCnt) + '+' + String(vs.folded) + '+' + String(vs.gone) + ' vs ' + String(vs.checked))

console.log('== 2) 全公开的情况 ==')
const home2 = join(tmpdir(), 'bi-visstats2')
rmSync(home2, { recursive: true, force: true }); mkdirSync(home2, { recursive: true })
const m2 = {}
for (let i = 0; i < 10; i++) m2['a' + i] = mk(true, '公开可见')
writeFileSync(join(home2, 'visibility.json'), JSON.stringify({ at: localIso(), map: m2 }), 'utf8')
const vs2 = buildState(home2, { version: 't' }).visStats
check('hidden = 0', vs2.hidden === 0)
check('folded = 0', vs2.folded === 0)
check('gone = 0', vs2.gone === 0)

console.log('== 3) 没查过的情况（文件不存在）==')
const home3 = join(tmpdir(), 'bi-visstats3')
rmSync(home3, { recursive: true, force: true }); mkdirSync(home3, { recursive: true })
const vs3 = buildState(home3, { version: 't' }).visStats
check('checked = 0', vs3.checked === 0)
check('不崩', typeof vs3.hidden === 'number')

console.log('== 4) 坏文件不崩 ==')
const home4 = join(tmpdir(), 'bi-visstats4')
rmSync(home4, { recursive: true, force: true }); mkdirSync(home4, { recursive: true })
writeFileSync(join(home4, 'visibility.json'), '{这不是合法json', 'utf8')
const vs4 = buildState(home4, { version: 't' }).visStats
check('坏文件返回 0 而不是抛错', vs4.checked === 0)

for (const h of [home, home2, home3, home4]) rmSync(h, { recursive: true, force: true })
console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
