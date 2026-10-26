// 挑评论回复：兜底排序必须按「信息量」，不能只看字数
import { fallbackTargets } from '../lib/danmaku.js'

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

const list = [
  { rpid: '1', uname: '甲', content: '我笑死哈哈哈哈哈哈哈哈' },
  { rpid: '2', uname: '乙', content: '8080 改成 6199' },
  { rpid: '3', uname: '丙', content: 'cy' },
  { rpid: '4', uname: '丁', content: '这个版本装了之后一直报错9009，有人遇到过吗？' },
  { rpid: '5', uname: '戊', content: '哈哈哈哈' },
  { rpid: '6', uname: '己', content: '@某某 你看这个' },
  { rpid: '7', uname: '庚', content: '谢谢up，学到了，但是API Key放在哪一步？' },
  { rpid: '8', uname: '辛', content: '1' },
  { rpid: '9', uname: '壬', content: '这' },
]

console.log('== 1) 纯情绪 / 复读必须被排除 ==')
const picked = fallbackTargets(list, 3)
const ids = picked.map((x) => x.rpid)
check('挑出 3 条', picked.length === 3, String(picked.length))
for (const [id, label] of [['1', '我笑死哈哈哈哈'], ['3', 'cy'], ['5', '哈哈哈'], ['8', '1'], ['9', '这']]) {
  check('排除「' + label + '」', !ids.includes(id), ids.join(','))
}

console.log('== 2) 有信息 / 在提问的优先 ==')
check('挑中带参数的', ids.includes('2'), ids.join(','))
check('挑中带报错的提问', ids.includes('4'), ids.join(','))
check('挑中带 API Key 的提问', ids.includes('7'), ids.join(','))

console.log('== 3) 排序说明写明是退路 ==')
check('why 提到「退路」', picked.every((x) => /退路/.test(x.why)), JSON.stringify(picked.map((x) => x.why)))

console.log('== 4) 全是废话时返回空，不硬凑 ==')
const junk = fallbackTargets([
  { rpid: 'a', content: '哈哈哈' },
  { rpid: 'b', content: 'cy' },
  { rpid: 'c', content: '1' },
], 3)
check('一条都不挑', junk.length === 0, JSON.stringify(junk))

console.log('== 5) 全是干货时按信息量取前 N ==')
const good = fallbackTargets([
  { rpid: 'x', content: '这个参数建议改成 300，默认值太小' },
  { rpid: 'y', content: '报错 9009 是因为没装 VC++ 运行库' },
  { rpid: 'z', content: '有人知道 API 版本怎么查吗？' },
], 2)
check('正好 2 条', good.length === 2, String(good.length))

console.log('== 6) want=0 / 空列表 ==')
check('want=0 返回空', fallbackTargets(list, 0).length === 0)
check('空列表返回空', fallbackTargets([], 3).length === 0)

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
