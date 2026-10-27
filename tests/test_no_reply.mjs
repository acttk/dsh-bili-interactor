// 「聊太多就不再回复」的核心逻辑
// 关键：这不是拉黑，只是本地记一笔「以后不回复他」
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isIgnored, addIgnored, removeIgnored, clearIgnored, readIgnored, countRounds } from '../lib/ignore.js'

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

const home = join(tmpdir(), 'bi-ign-unit')
rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true })

console.log('== 1) 初始状态：没有不想回复的人 ==')
check('空', Object.keys(readIgnored(home)).length === 0)
check('查不到', isIgnored(home, 'BV1a', '111') === null)

console.log('== 2) 记下来之后，只有这个视频+这个人被跳过 ==')
addIgnored(home, { bvid: 'BV1a', uid: '111', uname: '某个AI', rounds: 12, reason: '两边都是AI在互捧' })
const rec = isIgnored(home, 'BV1a', '111')
check('命中', !!rec)
check('记了轮数', rec.rounds === 12, String(rec.rounds))
check('记了原因', rec.reason === '两边都是AI在互捧', rec.reason)
check('同一视频别人不受影响', isIgnored(home, 'BV1a', '222') === null)
check('换个视频不受影响', isIgnored(home, 'BV1b', '111') === null)

console.log('== 3) 轮数统计 ==')
const led = [
  { ok: true, kind: 'replyback', bvid: 'BV1a', toUid: '111' },
  { ok: true, kind: 'replyback', bvid: 'BV1a', toUid: '111' },
  { ok: true, kind: 'reply', bvid: 'BV1a', toUid: '111' },
  { ok: false, kind: 'replyback', bvid: 'BV1a', toUid: '111' },   // 失败的不算
  { ok: true, kind: 'replyback', bvid: 'BV1b', toUid: '111' },    // 别的视频不算
  { ok: true, kind: 'replyback', bvid: 'BV1a', toUid: '222' },    // 别人不算
  { ok: true, kind: 'like', bvid: 'BV1a', toUid: '111' },         // 点赞不算
]
check('只数这个视频+这个人+成功的 = 3', countRounds(led, 'BV1a', '111') === 3, String(countRounds(led, 'BV1a', '111')))
check('没聊过 = 0', countRounds(led, 'BV1c', '111') === 0)
check('空账本 = 0', countRounds([], 'BV1a', '111') === 0)
check('缺参数 = 0', countRounds(led, '', '') === 0)

console.log('== 4) 撤销 ==')
removeIgnored(home, 'BV1a', '111')
check('撤销后查不到', isIgnored(home, 'BV1a', '111') === null)

console.log('== 5) 全部清空 ==')
addIgnored(home, { bvid: 'BV1a', uid: '111', uname: 'A', rounds: 10, reason: 'x' })
addIgnored(home, { bvid: 'BV1b', uid: '222', uname: 'B', rounds: 11, reason: 'y' })
check('有 2 条', Object.keys(readIgnored(home)).length === 2)
clearIgnored(home)
check('清空后 0 条', Object.keys(readIgnored(home)).length === 0)

console.log('== 6) 重复记录同一个人：覆盖不新增 ==')
addIgnored(home, { bvid: 'BV1a', uid: '111', uname: 'A', rounds: 10, reason: '第一次' })
addIgnored(home, { bvid: 'BV1a', uid: '111', uname: 'A', rounds: 15, reason: '第二次' })
const all = Object.keys(readIgnored(home))
check('仍然 1 条', all.length === 1, String(all.length))
check('轮数被更新', readIgnored(home)['BV1a#111'].rounds === 15)

rmSync(home, { recursive: true, force: true })
console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
