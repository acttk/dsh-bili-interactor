// 验证去重集合：拿真实账本算出「已回过的楼」，确认那几个重复的都被挡住
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOME = join(process.env.USERPROFILE, '.dsh', 'bili-interactor')
const rows = readFileSync(join(HOME, 'ledger.jsonl'), 'utf8')
  .trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const set = new Set()
for (const row of rows) {
  if (!row || row.ok !== true) continue
  if (row.kind !== 'reply' && row.kind !== 'replyback') continue
  if (!row.bvid) continue
  const root = row.root || row.parent || ''
  if (root) set.add(String(row.bvid) + '#' + String(root))
}

console.log('去重集合大小（已回过的楼）:', set.size)

// 账本里被重复回过的真实案例，必须都在集合里
const mustBlock = [
  'BV1T5nL6rEPb#321820808720',
  'BV1T5nL6rEPb#321802189712',
  'BV166nW6REyR#321830911008',
  'BV1x2Jq6NEbT#318133226897',
]
let bad = 0
for (const k of mustBlock) {
  const ok = set.has(k)
  console.log((ok ? '  ✅ 会挡住 ' : '  ❌ 没挡住 ') + k)
  if (!ok) bad++
}

// 新评论（没回过）必须能通过
const notBlocked = 'BV1T5nL6rEPb#999999999999'
console.log((set.has(notBlocked) ? '  ❌ 误挡新评论' : '  ✅ 新评论不会被挡') + ' ' + notBlocked)
if (set.has(notBlocked)) bad++

// 统计：账本里有 root 的回复行占比（老数据没 root，挡不住，但新数据可以）
const replyRows = rows.filter((r) => r.kind === 'reply' || r.kind === 'replyback')
const withRoot = replyRows.filter((r) => r.root)
console.log(`\n回复总数 ${replyRows.length}，其中有 root 的 ${withRoot.length}`)
console.log(bad === 0 ? '\nPASS' : '\nFAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
