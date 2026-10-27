// 真 React 的 hooks 规则：每次渲染必须按相同顺序、相同数量调用。
// smoke 用的假 React 里 useEffect 是空函数，不校验顺序 —— 所以
// 「把 useEffect 放在提前 return 之后」这种会让面板整块崩掉的 bug，
// smoke 永远发现不了。这个测试专门补上。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client.js'), 'utf8')

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

const lines = src.split('\n')

// 找组件里第一处提前 return（组件内的 `if (...) return h(...)`）
const earlyReturnIdx = lines.findIndex((l) => /^\s+if \(!st\) return h\(/.test(l))
check('找得到提前 return', earlyReturnIdx >= 0, String(earlyReturnIdx))

// 找所有 hooks 调用
const hookRe = /React\.(useState|useEffect|useMemo|useCallback|useRef)\s*\(/
const hookLines = []
for (let i = 0; i < lines.length; i++) {
  if (hookRe.test(lines[i])) hookLines.push(i)
}
check('组件里有 hooks', hookLines.length > 0, String(hookLines.length))

// 所有 hooks 都必须在提前 return 之前
if (earlyReturnIdx >= 0) {
  const after = hookLines.filter((i) => i > earlyReturnIdx)
  check('没有 hook 在提前 return 之后', after.length === 0,
    after.length ? '行号 ' + after.map((i) => i + 1).join(',') : '')
}

// 再粗查一遍：hooks 不能出现在任何 `if (` 块里面（条件调用）
// 做法：往上找最近的、缩进更小的行，如果它是 if/for/while 且没有配对的 }
const suspicious = []
for (const i of hookLines) {
  const indent = lines[i].match(/^\s*/)[0].length
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j]
    if (!l.trim()) continue
    const ind = l.match(/^\s*/)[0].length
    if (ind < indent) {
      if (/^\s*(if|for|while|switch)\s*\(/.test(l) && !/\}\s*$/.test(l)) {
        suspicious.push(i + 1)
      }
      break
    }
  }
}
check('hooks 不在条件分支里', suspicious.length === 0, suspicious.join(','))

// 顺序稳定：同一批 hooks 的相对顺序不应依赖运行时分支
check('useState 数量合理', hookLines.filter((i) => /React\.useState/.test(lines[i])).length >= 5)

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
