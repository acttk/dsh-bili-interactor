// 验证这次三件事：@ 只出现一次、学习记忆的存取、监听过滤逻辑。
import { join } from 'node:path'
import { rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'

const ROOT = 'C:\\Users\\user\\Desktop\\DSH\\dsh-bili-interactor'
const HOME = join(process.env.TEMP, 'bi-learn-test')
try { rmSync(HOME, { recursive: true, force: true }) } catch {}
mkdirSync(HOME, { recursive: true })

let ok = 0, bad = 0
const check = (n, c, extra = '') => {
  if (c) { ok++; console.log('  OK   ' + n) } else { bad++; console.log('  FAIL ' + n + '  ' + extra) }
}

const d = await import('file:///' + join(ROOT, 'lib', 'danmaku.js').replace(/\\/g, '/'))
const L = await import('file:///' + join(ROOT, 'lib', 'learn.js').replace(/\\/g, '/'))

console.log('== 1) @ 只留一个（宿主拼的那个），模型写的一律剥掉 ==')
const cases = [
  ['@测试网友 这鱼成精了 @测试网友', '这鱼成精了'],
  ['这鱼成精了 @测试网友', '这鱼成精了'],
  ['@测试网友 这鱼成精了', '这鱼成精了'],
  ['@测试网友 草，这也行  @测试网友  ', '草，这也行'],
  ['正常一句话', '正常一句话'],
]
for (const [inp, want] of cases) {
  const got = d.stripMentions(inp, '测试网友')
  check(JSON.stringify(inp) + ' -> ' + JSON.stringify(got), got === want, 'want=' + JSON.stringify(want))
}
check('不传名字也能剥开头结尾的 @', d.stripMentions('@某人 你好 @某人') === '你好', d.stripMentions('@某人 你好 @某人'))

console.log('== 2) 学习记忆：写 / 读 / 挑 / 淘汰 ==')
check('初始为空', L.readLearned(HOME).length === 0)
L.addLearned(HOME, { text: '推荐系统把人锁在信息茧房里', why: '反转视角', score: 9, from: '评论区' })
L.addLearned(HOME, { text: '真正的表达不是堆词', why: '有信息', score: 7, from: '评论区' })
L.addLearned(HOME, { text: '这句也挺好', score: 3, from: '评论区' })
check('写了 3 条', L.readLearned(HOME).length === 3, L.readLearned(HOME).length)
const picked = L.pickLearned(HOME, 2)
check('挑 2 条', picked.length === 2, picked.length)
check('高分优先', picked[0].score === 9, picked[0].score)
check('pickLearned(0) 返回空', L.pickLearned(HOME, 0).length === 0)

// 去重：同一条文本不重复挑
L.addLearned(HOME, { text: '推荐系统把人锁在信息茧房里', why: '重复', score: 10 })
const picked2 = L.pickLearned(HOME, 5)
const texts = picked2.map((x) => String(x.text).slice(0, 20))
check('同文本只挑一次', new Set(texts).size === texts.length, texts.join('|'))

// 淘汰
for (let i = 0; i < 30; i++) L.addLearned(HOME, { text: '批量 ' + i, score: i % 10 })
const before = L.readLearned(HOME).length
L.pruneLearned(HOME, 10)
const after = L.readLearned(HOME).length
check('超过上限会被裁剪', after <= 10, before + ' -> ' + after)

console.log('== 3) 坏行不能让整个文件读不出来 ==')
writeFileSync(join(HOME, 'learned.jsonl'), '{"text":"好的","score":5}\n坏掉的一行\n{"text":"也行","score":4}\n', 'utf8')
const robust = L.readLearned(HOME)
check('跳过坏行，保留好的', robust.length === 2, robust.length)

console.log('== 4) 提示词里要带笔记，且明确「别抄原句」==')
const src = (await import('node:fs')).readFileSync(join(ROOT, 'lib', 'danmaku.js'), 'utf8')
check('makeComment 接受 learned', /makeComment[\s\S]{0,200}opt\.learned/.test(src))
check('makeReply 接受 learned', /makeReply[\s\S]{0,200}opt\.learned/.test(src))
check('提示词说了别照抄', src.includes('别照抄'))

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
