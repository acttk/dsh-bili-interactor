// README 和代码必须一致：文档里写的默认值不能和 DEFAULT_CONFIG 对不上。
// 这类文档腐化很隐蔽 —— 用户照着 README 调参数，结果发现行为不一样。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG } from '../lib/state.js'

const here = dirname(fileURLToPath(import.meta.url))
const readme = readFileSync(join(here, '..', 'README.md'), 'utf8')

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

// 从 README 的表格行里抠 `key` | `默认值`
const rows = [...readme.matchAll(/^\|\s*`([a-zA-Z][a-zA-Z0-9]*)`(?:\s*\/\s*`[a-zA-Z0-9]+`)?\s*\|\s*`([^`]*)`\s*\|/gm)]

console.log('== 1) README 里每个配置项的默认值都要和代码一致 ==')
let compared = 0
for (const [, key, docVal] of rows) {
  if (!(key in DEFAULT_CONFIG)) {
    bad++
    console.log('  FAIL README 写了代码里不存在的配置项: ' + key)
    continue
  }
  const real = DEFAULT_CONFIG[key]
  const realStr = Array.isArray(real) ? JSON.stringify(real) : String(real)
  const docStr = String(docVal).trim()
  // README 里允许用「见默认值」这种模糊说法
  if (docStr === '见默认值') { compared++; continue }
  // 数组只比对前两项，README 可能简写
  const norm = (s) => s.replace(/["'\s]/g, '').replace(/，/g, ',')
  if (norm(docStr) === norm(realStr)) { compared++; continue }
  // 数字类型宽松比对
  if (Number(docStr) === Number(real) && !Number.isNaN(Number(docStr))) { compared++; continue }
  bad++
  console.log('  FAIL ' + key + '：README 写 ' + docStr + '，代码是 ' + realStr)
}
check('比对完成（' + compared + ' 项一致）', bad === 0)

console.log('== 2) 新加的功能必须在 README 里有名字 ==')
const mustMention = [
  ['跳过刷过的', 'skipSeenVideos'],
  ['不再回复', 'deepTalkLimit'],
  ['审查', 'deepTalkLimit'],
  ['可见性', 'visibility'],
  ['立刻生效', '不用重启'],
]
for (const [kw, why] of mustMention) {
  check('README 提到「' + kw + '」', readme.includes(kw), '对应 ' + why)
}

console.log('== 3) README 不能出现已废弃的说法 ==')
const stale = [
  ['从评论区里挑有信息量的内容存下来', '学习已改成总结规律'],
  ['检查这些是不是真的公开了', '按钮名已改'],
  ['六个页签', '现在是七个'],
]
for (const [kw, why] of stale) {
  check('没有过时说法「' + kw + '」', !readme.includes(kw), why)
}

console.log('== 4) README 提到的文件都得真的存在 ==')
const files = [...readme.matchAll(/^(lib\/[a-zA-Z0-9_.]+|py\/[a-zA-Z0-9_.]+|client\.js|smoke[a-z-]*\.mjs)\s/gm)].map((m) => m[1])
for (const f of [...new Set(files)]) {
  let exists = true
  try { readFileSync(join(here, '..', f)) } catch { exists = false }
  check('存在 ' + f, exists)
}

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
