// 把设置面板渲染成静态 HTML（给截图用）。
// 关键点：用**假数据**喂真实的 buildState，所以截图里不会出现用户的真实评论。
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const OUT = join(process.env.TEMP, 'bi-shots')
const HOME = join(process.env.TEMP, 'bi-shot-home')

rmSync(OUT, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
mkdirSync(HOME, { recursive: true })

/* ───────── 1) 造一份假家目录 ───────── */
const nowSec = Math.floor(Date.now() / 1000)
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const ledger = [
  { ts: iso(186), kind: 'like', ok: true, bvid: 'BV1Demo000001', title: '【整活】把 AI 塞进我家鱼缸之后', up: '夜雨制作组' },
  { ts: iso(184), kind: 'coin', ok: true, bvid: 'BV1Demo000001', n: 1, title: '【整活】把 AI 塞进我家鱼缸之后', up: '夜雨制作组' },
  { ts: iso(181), kind: 'danmaku', ok: true, bvid: 'BV1Demo000001', text: '这鱼比我会说话', title: '【整活】把 AI 塞进我家鱼缸之后', up: '夜雨制作组' },
  { ts: iso(176), kind: 'comment', ok: true, bvid: 'BV1Demo000001', text: '@示例用户 鱼缸里那位今天状态不错', rpid: '318140000101', title: '【整活】把 AI 塞进我家鱼缸之后', up: '夜雨制作组' },
  { ts: iso(174), kind: 'reply', ok: true, bvid: 'BV1Demo000001', text: '这标题确实省事，等于什么都没说', toName: '路过的键盘侠', rpid: '318140000201', root: '318140000199', title: '【整活】把 AI 塞进我家鱼缸之后', up: '夜雨制作组' },
  { ts: iso(150), kind: 'replyback', ok: true, bvid: 'BV1Demo000001', text: '屑就屑呗，碍你事了？', toName: '某个网友', rpid: '318140000301', root: '318140000199', parent: '318140000299', title: '【整活】把 AI 塞进我家鱼缸之后', up: '夜雨制作组' },
  { ts: iso(96), kind: 'like', ok: true, bvid: 'BV1Demo000002', title: '用一千块钱配了台能跑本地模型的机器', up: '硬件小白鼠' },
  { ts: iso(94), kind: 'comment', ok: true, bvid: 'BV1Demo000002', text: '一千块配这个，风扇转起来像拖拉机', rpid: '318140000401', title: '用一千块钱配了台能跑本地模型的机器', up: '硬件小白鼠' },
  { ts: iso(91), kind: 'reply', ok: false, bvid: 'BV1Demo000002', text: '散热是够的，就是声音感人', code: 12014, error: '发送失败，已达到当前评论发送上限', toName: '动手能力为零', title: '用一千块钱配了台能跑本地模型的机器', up: '硬件小白鼠' },
  { ts: iso(40), kind: 'danmaku', ok: true, bvid: 'BV1Demo000003', text: '这个剪辑节奏舒服', title: '三分钟看完今年最离谱的十个施工现场', up: '施工观察员' },
  { ts: iso(38), kind: 'like', ok: true, bvid: 'BV1Demo000003', title: '三分钟看完今年最离谱的十个施工现场', up: '施工观察员' },
  { ts: iso(12), kind: 'comment', ok: true, bvid: 'BV1Demo000003', text: '第七个那个塔吊，我看着腿软', rpid: '318140000501', title: '三分钟看完今年最离谱的十个施工现场', up: '施工观察员' },
]
writeFileSync(join(HOME, 'ledger.jsonl'), ledger.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const learned = [
  { text: '把模型跑在本地不等于省钱，电费和硬件折旧也是成本。', why: '具体的成本视角', from: '评论区', score: 9, bvid: 'BV1Demo000002', rpid: '318140000401' },
  { text: '散热是够的，就是声音感人。', why: '说人话的取舍描述', from: '某个网友', score: 8, bvid: 'BV1Demo000002', rpid: '318140000401' },
  { text: '真正的分歧点不是能不能用，是用了之后还记不记得自己本来是干嘛的。', why: '有一定深度', from: '评论区', score: 9, bvid: 'BV1Demo000001', rpid: '318140000101' },
  { text: '剪辑节奏舒服，说明剪辑师知道观众什么时候想快进。', why: '讲清了手法', from: '手动', score: 7 },
]
writeFileSync(join(HOME, 'learned.jsonl'), learned.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const today = new Date()
const dayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
writeFileSync(join(HOME, 'daily.json'), JSON.stringify({
  day: dayKey, actions: 47, coins: 1,
  byType: { like: 3, coin: 1, danmaku: 2, comment: 3, reply: 2, replyback: 1 },
}, null, 2), 'utf8')

writeFileSync(join(HOME, 'live.md'), [
  '【阶段】开跑（手动）：点赞、投币、弹幕、评论',
  '【思考】「恐怖游戏」拿到 30 条，粗筛后剩 11 条',
  '【候选】BV1Demo000001 · 今天 8 万播放',
  '【挑中】BV1Demo000001《【整活】把 AI 塞进我家鱼缸之后》',
  '【思考】弹幕写好了（模型）：这鱼比我会说话',
  '【动作】点赞 / 投币 1 / 弹幕「这鱼比我会说话」',
  '【思考】评论写好了（模型）：@示例用户 鱼缸里那位今天状态不错',
  '【动作】评论已发：@示例用户 鱼缸里那位今天状态不错',
  '【思考】评论区 42 条，值得接话的有 2 条：路过的键盘侠（会接梗）、某个网友（有信息）',
  '【动作】回了 路过的键盘侠：「这标题确实省事，等于什么都没说」',
  '【跳过】评论「1」太短，不值得接',
  '【跳过】这条楼今天回过了，不重复回',
  '【失败】回复 动手能力为零 没发出去：发送失败，已达到当前评论发送上限',
  '【小结】这轮动了 6 次，2 条失败',
].join('\n') + '\n', 'utf8')

/* ───────── 2) 拿到真实形状的 state ───────── */
const { buildState } = await import(new URL('../lib/state.js', import.meta.url).href)
const base = buildState(HOME, { version: '0.2.0' })

const state = {
  ...base,
  llm: true,
  loggedIn: true,
  ownLogin: true,
  loginName: '示例小鱼',
  login: { state: 'done', name: '示例小鱼', img: '', pending: false, leftSec: 0 },
  learnedCount: 4,
  run: { running: false, phase: '', progress: { index: 0, total: 0 }, error: '', startedAt: 0 },
  listener: {
    enabled: true, everyMin: 1, running: false, armed: true,
    lastAt: iso(3), todayDone: 14, perDay: 0, totalThreads: 26,
    last: { at: iso(3), trigger: 'timer', checked: 15, sent: 1, skipped: 2, threads: 26 },
  },
  me: { name: '示例小鱼', level: 5, coins: 6 },
}

const learnedPayload = { ok: true, total: learned.length, items: learned.map((x) => ({ ...x, at: iso(30) })) }
const fresh = { at: iso(1), map: {} }

globalThis.fetch = async (url) => {
  const u = String(url)
  const body = u.includes('/learned') ? learnedPayload : (u.includes('/visibility') ? fresh : state)
  return { ok: true, json: async () => body }
}

/* ───────── 3) 加载 client.js，拿到 Panel ───────── */
const registrations = []
let loaded = null
globalThis.window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '', style: {} }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
}

const store = new Map()
let slot = 0
const ReactStub = {
  createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity) }),
  useState: (init) => {
    const k = slot++
    if (!store.has(k)) store.set(k, typeof init === 'function' ? init() : init)
    return [store.get(k), (v) => store.set(k, typeof v === 'function' ? v(store.get(k)) : v)]
  },
  useCallback: (fn) => fn,
  useEffect: (fn) => { try { return fn() } catch { return undefined } },
}

const FILE = join(ROOT, 'client.js')
await import(pathToFileURL(FILE).href)
const api = loaded.factory((n) => {
  if (n === 'react') return ReactStub
  throw new Error('unexpected require: ' + n)
})
api.apply({
  slots: { inject: (_s, cb) => cb(), register: (opts, comp) => { registrations.push({ opts, comp }); return { dispose() {} } } },
  effect: (fn) => { try { return fn() } catch { return undefined } },
})

const comp = registrations[registrations.length - 1].comp()
const ViewFn = comp.type ?? comp.tag

slot = 0
ViewFn()
await new Promise((r) => setTimeout(r, 60))
slot = 0
const firstTree = ViewFn()

/* ───────── 4) vnode -> HTML ───────── */
const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link'])
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const kebab = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())

function styleToCss(style) {
  if (!style) return ''
  if (typeof style === 'string') return style
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => kebab(k) + ':' + (typeof v === 'number' && !['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink'].includes(k) ? v + 'px' : v))
    .join(';')
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node !== 'object') return ''
  if (typeof node.tag === 'function') {
    try { return render(node.tag({ ...node.props, children: node.children })) } catch { return '' }
  }
  const tag = node.tag || 'div'
  const attrs = []
  for (const [k, v] of Object.entries(node.props || {})) {
    if (k === 'key' || k === 'children' || k === 'ref' || k.startsWith('on')) continue
    if (v === undefined || v === null || v === false) continue
    if (k === 'style') { const css = styleToCss(v); if (css) attrs.push('style="' + esc(css) + '"'); continue }
    if (k === 'value' || k === 'defaultValue') { attrs.push('value="' + esc(v) + '"'); continue }
    if (v === true) { attrs.push(k); continue }
    if (typeof v === 'object') continue
    attrs.push(k + '="' + esc(v) + '"')
  }
  const inner = (node.children || []).map(render).join('')
  if (VOID.has(tag)) return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>'
  return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + inner + '</' + tag + '>'
}

/* ───────── 5) 抽出 client.js 里的 CSS ───────── */
const src = readFileSync(FILE, 'utf8')
const cssStart = src.indexOf('const CSS = `') + 'const CSS = `'.length
const cssEnd = src.indexOf('\n`', cssStart)
const CSS = src.slice(cssStart, cssEnd)

/* ───────── 6) 每个页签出一张 ───────── */
const TABS = [
  ['overview', '总览'],
  ['talk', '它说了什么'],
  ['interact', '碰过的视频'],
  ['memory', '记忆'],
  ['process', '过程'],
  ['settings', '设置'],
]

const page = (body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#0b1220;}
  body{padding:26px 30px;box-sizing:border-box;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
</style>
<style>${CSS}</style>
</head><body><div data-bi-root>${body}</div></body></html>`

mkdirSync(join(OUT, 'html'), { recursive: true })
for (const [key, label] of TABS) {
  // 找到保存当前页签的那个 hook，直接改它的值
  for (const [k, v] of store.entries()) if (v === 'overview' || TABS.some(([t]) => t === v)) store.set(k, key)
  slot = 0
  ViewFn()                                   // 第一帧：切过去，触发该页签的 useEffect
  await new Promise((r) => setTimeout(r, 80)) // 等异步数据回来（记忆是单独拉的）
  slot = 0
  const tree = ViewFn()                      // 第二帧：这时候才有数据
  const html = page(render(tree))
  writeFileSync(join(OUT, 'html', key + '.html'), html, 'utf8')
  console.log('wrote ' + key + '.html (' + label + ') ' + html.length + ' bytes')
}
writeFileSync(join(OUT, 'tabs.json'), JSON.stringify(TABS), 'utf8')
console.log('\n输出目录: ' + OUT)
// 面板里有 2 秒轮询的 setInterval，不清掉进程退不出去
process.exit(0)
