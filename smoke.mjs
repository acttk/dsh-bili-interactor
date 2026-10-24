// 冒烟测试：不启动 DSH，只验证 client.js 的骨架对不对。
// 1) __ModuleLoader__.load 被调用，id 对
// 2) factory 返回 { inject:['slots'], apply }
// 3) apply 会注册 settings.section / bili-interactor
// 4) 首屏（无数据）和带数据两帧都能渲染，四个 tab 都在
import { pathToFileURL } from 'node:url'

const registrations = []
const effects = []
let loaded = null

globalThis.window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild() {} },
}

const baseReact = {
  createElement: (tag, props, ...children) => ({ tag, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const FILE = 'C:\\Users\\user\\Desktop\\DSH\\dsh-bili-interactor\\client.js'
await import(pathToFileURL(FILE).href)

if (!loaded) throw new Error('没有调用 __ModuleLoader__.load')
if (loaded.id !== 'dsh-bili-interactor') throw new Error('id 不对：' + loaded.id)

const api = loaded.factory((n) => {
  if (n === 'react') return baseReact
  throw new Error('意外的 require: ' + n)
})
if (!api || typeof api.apply !== 'function') throw new Error('factory 没返回 apply')
if (!Array.isArray(api.inject) || !api.inject.includes('slots')) throw new Error('inject 不含 slots')

const ctx = {
  slots: {
    inject: (slot, cb) => cb(),
    register: (opts, comp) => { registrations.push({ opts, comp }); return { dispose() {} } },
  },
  effect: (fn, label) => { effects.push(label); return fn() },
}

api.apply(ctx)

if (registrations.length !== 1) throw new Error('注册数量不对：' + registrations.length)
const r = registrations[0]
if (r.opts.name !== 'settings.section') throw new Error('槽位错了：' + r.opts.name)
if (r.opts.id !== 'bili-interactor') throw new Error('id 错了：' + r.opts.id)
if (r.opts.label !== 'B站互动') throw new Error('label 错了：' + r.opts.label)

console.log('OK  id=' + loaded.id)
console.log('OK  slot=' + r.opts.name + ' id=' + r.opts.id + ' order=' + r.opts.order + ' label=' + r.opts.label)
console.log('OK  effect=' + effects.join('|'))

/* ── 带数据渲染：喂真实 buildState 的输出 ── */
const { buildState } = await import(pathToFileURL(
  'C:\\Users\\user\\Desktop\\DSH\\dsh-bili-interactor\\lib\\state.js').href)

const home = process.env.USERPROFILE + '\\.dsh\\bili-interactor'
const state = buildState(home, { version: '0.1.0' })
state.run = { running: false, phase: '', progress: { index: 0, total: 0 }, error: '', startedAt: 0 }

globalThis.fetch = async () => ({ ok: true, json: async () => state })

// 换一个会记状态的 React，好让第二帧读到 load 的结果
const store = new Map()
let slot = 0
const liveReact = {
  ...baseReact,
  useState: (init) => {
    const k = slot++
    if (!store.has(k)) store.set(k, typeof init === 'function' ? init() : init)
    return [store.get(k), (v) => store.set(k, typeof v === 'function' ? v(store.get(k)) : v)]
  },
  useCallback: (fn) => fn,
  useEffect: (fn) => { try { return fn() } catch { return undefined } },
}

let loaded2 = null
globalThis.window = { __ModuleLoader__: { load: (def) => { loaded2 = def } } }
await import(pathToFileURL(FILE).href + '?v=2')

const api2 = loaded2.factory((n) => (n === 'react' ? liveReact : (() => { throw new Error('require ' + n) })()))
api2.apply(ctx)
const comp = registrations[registrations.length - 1].comp()
const ViewFn = comp.type ?? comp.tag

slot = 0
ViewFn()                                   // 首屏，st=null
await new Promise((res) => setTimeout(res, 40))   // 等 load() 落定
slot = 0
const tree = ViewFn()                      // 这次有数据

const collect = (t) => {
  const out = []
  const walk = (n) => {
    if (n == null) return
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n === 'string' || typeof n === 'number') return out.push(String(n))
    if (typeof n.tag === 'function') {
      try { walk(n.tag(n.props || {})) } catch { /* 展开不了就算了 */ }
      return
    }
    if (n.props) for (const v of Object.values(n.props)) if (typeof v === 'string') out.push(v)
    if (n.children) n.children.forEach(walk)
  }
  walk(t)
  return out
}

/* ——— 未登录：必须看得见登录入口 ——— */
state.loggedIn = false
store.clear(); slot = 0
ViewFn()                                   // 第一帧 st=null，触发 load()
await new Promise((res) => setTimeout(res, 40))
slot = 0
const t1 = collect(ViewFn())                // 第二帧才有数据
for (const want of ['先登录 B站', '扫码登录', '凭证只存在这台电脑']) {
  if (!t1.some((x) => x.includes(want))) throw new Error('未登录时看不到「' + want + '」，实际渲染出 ' + t1.length + ' 个文本节点：' + t1.slice(0, 12).join(' | '))
}
if (t1.some((x) => x.includes('退出登录'))) throw new Error('没登录却显示了「退出登录」')
console.log('OK  未登录：登录卡正常（' + t1.length + ' 个文本节点）')

/* ——— 已登录：显示退出，不再要求扫码 ——— */
state.loggedIn = true
store.clear(); slot = 0
ViewFn()
await new Promise((res) => setTimeout(res, 40))
slot = 0
const t2 = collect(ViewFn())
if (!t2.some((x) => x.includes('退出登录'))) throw new Error('已登录时看不到「退出登录」')
if (t2.some((x) => x.includes('扫码登录'))) throw new Error('已登录却还让扫码')
console.log('OK  已登录：显示退出登录、不再显示扫码')

const texts = t2
for (const want of ['B站互动', '总览', '互动', '过程', '设置', '今天动了几次', '还剩额度']) {
  if (!texts.some((x) => x.includes(want))) throw new Error('渲染结果里没有「' + want + '」')
}

console.log('OK  带数据渲染通过：' + texts.length + ' 个文本节点')
console.log('OK  quota=' + JSON.stringify(state.quota))
console.log('OK  live 行数=' + state.live.lines.length + ' / ledger 条数=' + state.recent.length)

// 组件里的 setInterval 会让进程赖着不退，测完直接收工
process.exit(0)
