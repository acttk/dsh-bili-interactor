// 可见性批量扫描：分组、时间过滤、结果结构
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

// 复刻宿主的分组逻辑，验证它对不对
function groupMine(rows, hours) {
  const since = hours > 0 ? Date.now() - hours * 3600_000 : 0
  const groups = new Map()
  let total = 0
  for (const r of rows) {
    if (!r || r.ok !== true) continue
    if (!['comment', 'reply', 'replyback'].includes(r.kind)) continue
    if (!r.bvid || !r.rpid) continue
    const when = Date.parse(r.ts || r.at || '') || 0
    if (since && when && when < since) continue
    const root = String(r.root || r.rpid)
    const key = r.bvid + '#' + root
    if (!groups.has(key)) groups.set(key, { bvid: r.bvid, root, rows: [] })
    groups.get(key).rows.push(r)
    total++
  }
  return { groups, total }
}

const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()
const H = 3600_000

const rows = [
  // 同一楼里 3 条（应该合成 1 个组）
  { ok: true, kind: 'comment', bvid: 'BV1a', rpid: '100', root: '', ts: iso(0.5 * H) },
  { ok: true, kind: 'reply', bvid: 'BV1a', rpid: '101', root: '100', ts: iso(2 * H) },
  { ok: true, kind: 'replyback', bvid: 'BV1a', rpid: '102', root: '100', ts: iso(3 * H) },
  // 另一个楼
  { ok: true, kind: 'comment', bvid: 'BV1a', rpid: '200', ts: iso(5 * H) },
  // 太老（30 小时前），24 小时窗应该排除
  { ok: true, kind: 'comment', bvid: 'BV1b', rpid: '300', ts: iso(30 * H) },
  // 失败的记录不该算
  { ok: false, kind: 'comment', bvid: 'BV1c', rpid: '400', ts: iso(1 * H) },
  // 没 rpid 的跳过
  { ok: true, kind: 'comment', bvid: 'BV1d', rpid: '', ts: iso(1 * H) },
  // 不该算的类型
  { ok: true, kind: 'like', bvid: 'BV1e', rpid: '500', ts: iso(1 * H) },
]

console.log('== 1) 24 小时窗 ==')
const r24 = groupMine(rows, 24)
check('合成 2 个楼', r24.groups.size === 2, String(r24.groups.size))
check('算进 4 条', r24.total === 4, String(r24.total))
check('同一楼 3 条合并', r24.groups.get('BV1a#100')?.rows.length === 3, String(r24.groups.get('BV1a#100')?.rows.length))
check('30 小时前的被排除', !r24.groups.has('BV1b#300'))
check('失败的记录不算', ![...r24.groups.values()].some((g) => g.rows.some((x) => x.rpid === '400')))
check('like 类型不算', ![...r24.groups.values()].some((g) => g.rows.some((x) => x.rpid === '500')))

console.log('== 2) 全部历史（hours=0）==')
const rAll = groupMine(rows, 0)
check('合成 3 个楼', rAll.groups.size === 3, String(rAll.groups.size))
check('30 小时前的这次算进来', rAll.groups.has('BV1b#300'))
check('算进 5 条', rAll.total === 5, String(rAll.total))

console.log('== 3) 1 小时窗 ==')
const r1 = groupMine(rows, 1)
check('只剩 1 个楼', r1.groups.size === 1, String(r1.groups.size))
  check('这个楼是 BV1a#100', r1.groups.has('BV1a#100'))

console.log('== 4) 判定逻辑：hidden / public 分得清 ==')
const decide = (hiddenList, publicList, rpids) => {
  const hiddenSet = new Set(hiddenList.map(String))
  const publicSet = new Set(publicList.map(String))
  const out = { hidden: [], public: [], unknown: [] }
  for (const rp of rpids) {
    if (hiddenSet.has(rp)) out.hidden.push(rp)
    else if (publicSet.has(rp)) out.public.push(rp)
    else out.unknown.push(rp)
  }
  return out
}
const d = decide(['101'], ['102'], ['100', '101', '102'])
check('101 判为隐藏', d.hidden.join() === '101', d.hidden.join())
check('102 判为公开', d.public.join() === '102', d.public.join())
check('100 查不到', d.unknown.join() === '100', d.unknown.join())

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
