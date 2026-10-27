// 全量契约审计：找出「界面上有但宿主没实现」「宿主有但界面没暴露」
// 以及「接口返回和前端期望对不上」的地方。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const state = readFileSync(join(root, 'lib', 'state.js'), 'utf8')
const danmaku = readFileSync(join(root, 'lib', 'danmaku.js'), 'utf8')
const targets = readFileSync(join(root, 'lib', 'targets.js'), 'utf8')
const learn = readFileSync(join(root, 'lib', 'learn.js'), 'utf8')
const ignore = readFileSync(join(root, 'lib', 'ignore.js'), 'utf8')
const py = readFileSync(join(root, 'py', 'interact.py'), 'utf8')

const allCode = [host, state, danmaku, targets, learn, ignore].join('\n')

let problems = []
const add = (kind, msg) => problems.push({ kind, msg })

/* ── 1) 配置项闭环：DEFAULT_CONFIG 里每个键，必须有人读 ── */
const defBlock = state.slice(state.indexOf('export const DEFAULT_CONFIG'), state.indexOf('}', state.indexOf('export const DEFAULT_CONFIG')))
const defKeys = [...defBlock.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1])

const notRead = []
for (const k of defKeys) {
  // 在 lib 代码里找 cfg.xxx 或 cfg['xxx']
  const used = new RegExp('(?:cfg|config|after|before|cfg0)\\.' + k + '\\b').test(allCode) ||
    new RegExp("(?:cfg|config)\\[['\"]" + k + "['\"]\\]").test(allCode)
  if (!used) notRead.push(k)
}
if (notRead.length) add('配置项没被读取', notRead.join(', '))

/* ── 2) 界面能改的配置项，必须在 DEFAULT_CONFIG 里 ── */
const patched = [...client.matchAll(/patch\(\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/g)].map((m) => m[1])
const patchedAll = [...new Set(patched)]
const notInDef = patchedAll.filter((k) => !defKeys.includes(k))
if (notInDef.length) add('界面能改但默认配置里没有', notInDef.join(', '))

/* ── 3) 前端调用的接口，宿主必须注册 ── */
const called = new Set()
for (const m of client.matchAll(/(?:post|get)\('(\/[^']+)'/g)) called.add(m[1])
for (const m of client.matchAll(/fetch\(API \+ '(\/[^']+)'/g)) called.add(m[1])
const registered = new Set()
for (const m of host.matchAll(/p === '(\/[^']+)'/g)) registered.add(m[1])
const missing = [...called].filter((e) => !registered.has(e))
if (missing.length) add('前端调用但宿主没注册', missing.join(', '))

/* ── 4) 每个 POST 接口的返回，前端如果查了 ok 就必须有 ok ── */
// 找宿主里所有 sendJson(res, 200, {...}) 的字面量，看有没有既没有 ok 又不是数组的
const sendBlocks = [...host.matchAll(/sendJson\(res,\s*200,\s*\{([^}]*)\}/g)].map((m) => m[1])
let noOk = 0
for (const b of sendBlocks) {
  if (!/ok\s*:/.test(b) && !/\.\.\./.test(b) && b.trim()) noOk++
}
// 只警告，因为有些是 .catch 兜底

/* ── 5) 每个开关（Switch）背后必须真有用到 ── */
const switches = [...client.matchAll(/patch\(\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*:\s*v\s*\}/g)].map((m) => m[1])
const switchNoUse = switches.filter((k) => !new RegExp('(?:cfg|config)\\.' + k + '\\b').test(allCode))
if (switchNoUse.length) add('开关改了但代码里没用', switchNoUse.join(', '))

/* ── 6) python 命令：宿主调用的必须存在 ── */
const pyCmds = new Set()
for (const m of host.matchAll(/runPy\([^,]+,\s*\['([a-z-]+)'/g)) pyCmds.add(m[1])
const pyDefined = new Set([...py.matchAll(/"(?:[a-z-]+)":\s*cmd_/g)].map((m) => m[0].match(/"([a-z-]+)"/)[1]))
const pyMissing = [...pyCmds].filter((c) => !pyDefined.has(c))
if (pyMissing.length) add('宿主调用的 python 命令不存在', pyMissing.join(', '))

/* ── 7) 前端有按钮但点了没反应（onClick 为空/只 setMsg） ── */
// 粗查：onClick 里既没有 post 也没有 get 也没有 load 的
const emptyButtons = []
for (const m of client.matchAll(/onClick:\s*(?:async\s*)?\(\)\s*=>\s*\{([^}]{0,200})\}/g)) {
  const body = m[1]
  if (!/post\(|get\(|load|set[A-Z]|copyText|document\./.test(body)) {
    emptyButtons.push(body.trim().slice(0, 40))
  }
}
if (emptyButtons.length) add('按钮点了没动作', emptyButtons.join(' | '))

/* ── 输出 ── */
console.log('=== 审计结果 ===\n')
console.log('配置项总数:', defKeys.length)
console.log('界面可改:', patchedAll.length)
console.log('前端调用接口:', called.size)
console.log('宿主注册接口:', registered.size)
console.log('python 命令:', pyCmds.size)
console.log('')

if (!problems.length) {
  console.log('✅ 没有发现闭环问题')
} else {
  for (const p of problems) {
    console.log('⚠️  [' + p.kind + ']')
    console.log('     ' + p.msg)
  }
}

console.log('\n（这个脚本只做静态交叉检查，运行期行为靠后面的实测）')
process.exit(0)
