// 学习机制：必须产出「规律」而不是「原句」
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readLearned, addLearned, pickLearned, pruneLearned, pickRules } from '../lib/learn.js'

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}
const home = join(tmpdir(), 'bi-learn-unit')
rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true })

console.log('== 1) 旧数据（没有 kind）自动当成例句 ==')
writeFileSync(join(home, 'learned.jsonl'), JSON.stringify({ at: '2026-10-01T00:00:00Z', text: '术士顺转是没盛饭的空盆', score: 8 }) + '\n', 'utf8')
const old = readLearned(home)
check('读出来 1 条', old.length === 1)
check('kind 是 quote', old[0].kind === 'quote', old[0].kind)

console.log('== 2) 新记的规律 kind=rule ==')
addLearned(home, { kind: 'rule', text: '先甩结论再补理由，别铺垫', why: '真人先给反应', score: 9 })
const all = readLearned(home)
check('现在 2 条', all.length === 2, String(all.length))
check('新的是 rule', all.find((e) => e.text.includes('先甩结论'))?.kind === 'rule')

console.log('== 3) 同一条规律重复记 → 不新增，加分 ==')
addLearned(home, { kind: 'rule', text: '先甩结论再补理由，别铺垫', score: 9 })
const rules = readLearned(home).filter((e) => e.kind === 'rule')
check('仍然只有 1 条规律', rules.length === 1, String(rules.length))
check('分数被加上去', rules[0].score === 10, String(rules[0].score))

console.log('== 4) 注入时规律排前面、例句最多 2 条 ==')
for (let i = 0; i < 5; i++) addLearned(home, { kind: 'quote', text: '例句' + i, score: 5 })
const picked = pickLearned(home, 8)
const kinds = picked.map((e) => e.kind)
check('第一条是 rule', kinds[0] === 'rule', kinds.join(','))
check('例句不超过 2 条', kinds.filter((k) => k !== 'rule').length <= 2, kinds.join(','))

console.log('== 5) 空内容不记 ==')
check('空 rule 返回 false', addLearned(home, { kind: 'rule', text: '   ' }) === false)
const before = readLearned(home).length
addLearned(home, { kind: 'rule', text: '' })
check('条数没变', readLearned(home).length === before)

console.log('== 6) prune 不能把规律挤掉 ==')
const home2 = join(tmpdir(), 'bi-learn-prune')
rmSync(home2, { recursive: true, force: true }); mkdirSync(home2, { recursive: true })
for (let i = 0; i < 20; i++) addLearned(home2, { kind: 'rule', text: '规律' + i, score: 9 })
for (let i = 0; i < 500; i++) addLearned(home2, { kind: 'quote', text: '例句' + i, score: 5 })
const pruned = pruneLearned(home2, 100)
const left = readLearned(home2)
check('确实删了一些', pruned > 0, String(pruned))
check('剩 100 条', left.length === 100, String(left.length))
check('规律全部保住', left.filter((e) => e.kind === 'rule').length === 20, String(left.filter((e) => e.kind === 'rule').length))

console.log('== 7) pickRules 只取规律 ==')
check('只有规律', pickRules(home2, 50).every((e) => e.kind === 'rule'))

rmSync(home, { recursive: true, force: true }); rmSync(home2, { recursive: true, force: true })
console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
