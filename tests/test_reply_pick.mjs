// 验证「挑值得接话的」：纯复读/纯情绪/广告不能被选中
import { join } from 'node:path'

const ROOT = 'C:\\Users\\user\\Desktop\\DSH\\dsh-bili-interactor'

let ok = 0, bad = 0
const check = (n, c, extra = '') => {
  if (c) { ok++; console.log('  OK   ' + n) } else { bad++; console.log('  FAIL ' + n + '  ' + extra) }
}

const m = await import('file:///' + join(ROOT, 'lib', 'danmaku.js').replace(/\\/g, '/'))

const comments = [
  { rpid: '1', uname: '甲', content: '1' },
  { rpid: '2', uname: '乙', content: 'cy' },
  { rpid: '3', uname: '丙', content: '哈哈哈哈哈' },
  { rpid: '4', uname: '丁', content: '加群 微信 abc123 领福利' },
  { rpid: '5', uname: '戊', content: '其实这里说的不是 AI 多强，是推荐系统把人锁在信息茧房里了' },
  { rpid: '6', uname: '己', content: '我划走枯燥的，多半是因为它没字幕' },
]

console.log('== 1) 只挑有内容的，纯复读/纯情绪/广告不选 ==')
const out = await m.pickReplyTargets({ title: '测试' }, comments, { persona: '大肥鱼' }, { max: 3 })
const ids = out.map((x) => x.rpid)
console.log('   挑中: ' + JSON.stringify(out))
check('不选「1」', !ids.includes('1'))
check('不选「cy」', !ids.includes('2'))
check('不选「哈哈哈哈哈」', !ids.includes('3'))
check('选了至少一条有内容的', ids.length >= 1, ids.join(','))
check('每条都带 why', out.every((x) => typeof x.why === 'string'))

console.log('== 2) max=0 时一条都不挑 ==')
const none = await m.pickReplyTargets({ title: 't' }, comments, { persona: '' }, { max: 0 })
check('返回空', none.length === 0, none.length)

console.log('== 3) 空列表不炸 ==')
const empty = await m.pickReplyTargets({ title: 't' }, [], { persona: '' }, { max: 2 })
check('返回空', Array.isArray(empty) && empty.length === 0)

console.log('== 4) 全是垃圾评论时，理想是挑不出（不能凑数）==')
const junk = [
  { rpid: 'a', uname: 'x', content: '1' },
  { rpid: 'b', uname: 'y', content: 'cy' },
  { rpid: 'c', uname: 'z', content: '666' },
]
const junkOut = await m.pickReplyTargets({ title: 't' }, junk, { persona: '大肥鱼' }, { max: 2 })
check('一条都不挑', junkOut.length === 0, JSON.stringify(junkOut))

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
