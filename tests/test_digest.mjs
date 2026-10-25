// 内容理解：digestBlock 必须把字幕/弹幕真的拼进提示词，否则又退回「只看标题」
import { digestBlock } from '../lib/danmaku.js'

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) }
  else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

console.log('== 1) 有字幕时优先用字幕 ==')
const withSub = digestBlock({
  title: '标题甲', up: 'UP甲', desc: '简介甲',
  subtitle: '这是视频里真正说的一段话，讲了具体操作。',
  danmaku: ['弹幕一', '弹幕二'],
})
const joined = withSub.join('\n')
check('带上了标题', joined.includes('标题甲'))
check('带上了字幕', joined.includes('视频里真正说的一段话'))
check('有字幕时不再塞弹幕', !joined.includes('弹幕一'))

console.log('== 2) 没字幕时用弹幕池 ==')
const withDm = digestBlock({
  title: '标题乙', up: 'UP乙', desc: '',
  subtitle: '',
  danmaku: ['关掉一键加速', '换个 PyPI 镜像源', '第三个才通'],
})
const j2 = withDm.join('\n')
check('说明这是观众弹幕', j2.includes('弹幕'))
check('弹幕内容都在', j2.includes('关掉一键加速') && j2.includes('第三个才通'))

console.log('== 3) 什么都没有时不能编 ==')
const empty = digestBlock({ title: '只有标题', up: '', desc: '', subtitle: '', danmaku: [] })
const j3 = empty.join('\n')
check('只保留标题', j3.includes('只有标题'))
check('不出现空的弹幕段', !j3.includes('弹幕'))

console.log('== 4) 坏数据不能崩 ==')
for (const badVal of [null, undefined, {}, { danmaku: 'not-array' }, { subtitle: 123 }]) {
  try { digestBlock(badVal) } catch (e) { bad++; console.log('  FAIL 抛异常: ' + e.message) }
}
console.log('  OK   各种坏输入都不抛异常')

console.log('== 5) 字幕和弹幕过长要截断（别把 token 撑爆）==')
const long = digestBlock({ title: 't', subtitle: 'x'.repeat(5000), danmaku: Array(100).fill('y'.repeat(50)) })
const totalLen = long.join('\n').length
check('总长度受控（<4000 字符）', totalLen < 4000, '实际 ' + totalLen)

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
