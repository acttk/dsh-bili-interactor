// 「跳过刷过的视频」的行为测试：存储 + 过滤逻辑
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSeen, markSeen, markSeenMany, clearSeen, hasSeen } from '../lib/seen.js'

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) }
  else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

const home = join(tmpdir(), 'bi-seen-unit')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })

console.log('== 1) 初始为空 ==')
check('没有记录', readSeen(home).size === 0)

console.log('== 2) 记一条 ==')
markSeen(home, 'BV1aaa')
check('记上了', hasSeen(home, 'BV1aaa'))
check('没记的查不到', !hasSeen(home, 'BV1zzz'))

console.log('== 3) 重复记不会变多 ==')
markSeen(home, 'BV1aaa')
markSeen(home, 'BV1aaa')
check('还是 1 条', readSeen(home).size === 1, String(readSeen(home).size))

console.log('== 4) 批量记 ==')
markSeenMany(home, ['BV1bbb', 'BV1ccc', '', null, 'BV1bbb'])
check('加了 2 条（空值和重复被忽略）', readSeen(home).size === 3, String(readSeen(home).size))

console.log('== 5) 过滤逻辑：刷过的应该被剔掉 ==')
const seenSet = readSeen(home)
const candidates = [
  { bvid: 'BV1aaa', title: '刷过的' },
  { bvid: 'BV1new', title: '新的' },
  { bvid: 'BV1bbb', title: '刷过的' },
]
const fresh = candidates.filter((v) => !seenSet.has(String(v.bvid || '')))
check('只剩新视频', fresh.length === 1 && fresh[0].bvid === 'BV1new', JSON.stringify(fresh.map((x) => x.bvid)))

console.log('== 6) 清空 ==')
clearSeen(home)
check('清空后为 0', readSeen(home).size === 0)
check('清空后又能刷到', !hasSeen(home, 'BV1aaa'))

console.log('== 7) 上限：超过 3000 条砍最老的 ==')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
const many = Array.from({ length: 3100 }, (_, i) => 'BV' + String(i).padStart(6, '0'))
markSeenMany(home, many)
const size = readSeen(home).size
check('总数被限制在 3000 以内', size <= 3000 && size > 0, String(size))

console.log('== 8) 坏数据不崩 ==')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
try {
  check('空 bvid 不写', markSeen(home, '') === false)
  check('读不崩', readSeen(home).size === 0)
} catch (e) {
  bad++; console.log('  FAIL 抛异常: ' + e.message)
}

rmSync(home, { recursive: true, force: true })
console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
