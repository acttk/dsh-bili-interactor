// 冒烟测试：不启动 DSH，只验证 client.js 的骨架对不对。
// 1) __ModuleLoader__.load 被调用，id 对
// 2) factory 返回 { inject:['slots'], apply }
// 3) apply 会注册 settings.section / bili-interactor
// 4) 首屏（无数据）和带数据两帧都能渲染，四个 tab 都在
import { pathToFileURL, fileURLToPath } from 'node:url'

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

const FILE = fileURLToPath(new URL('./client.js', import.meta.url))
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
const { buildState } = await import(new URL('./lib/state.js', import.meta.url).href)

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
state.ownLogin = true          // 自己登录的，才该有「退出登录」
store.clear(); slot = 0
ViewFn()
await new Promise((res) => setTimeout(res, 40))
slot = 0
const t2 = collect(ViewFn())
if (!t2.some((x) => x.includes('退出登录'))) throw new Error('已登录时看不到「退出登录」')
if (t2.some((x) => x.includes('扫码登录'))) throw new Error('已登录却还让扫码')

/* ——— 每个页签都要能渲染（新加的「它说了什么」「记忆」不能白屏） ——— */
{
  const render = () => { slot = 0; return ViewFn() }

  const findTabs = (t) => {
    const out = []
    const walk = (n) => {
      if (n == null) return
      if (Array.isArray(n)) return n.forEach(walk)
      if (typeof n !== 'object') return
      if (typeof n.tag === 'function') { try { walk(n.tag(n.props || {})) } catch { /* ignore */ } ; return }
      if (n.props && n.props['data-bi-tab'] !== undefined) out.push(n)
      if (n.children) n.children.forEach(walk)
    }
    walk(t)
    return out
  }

  state.loggedIn = true
  store.clear(); slot = 0
  ViewFn()
  await new Promise((res) => setTimeout(res, 40))

  let tabs = findTabs(render())
  if (tabs.length < 5) throw new Error('页签数量不对：' + tabs.length)

  const labels = []
  for (let i = 0; i < tabs.length; i++) {
    tabs = findTabs(render())
    const t = tabs[i]
    const label = String((t.children && t.children[0]) || ('#' + i))
    labels.push(label)
    if (t.props && typeof t.props.onClick === 'function') t.props.onClick()
    const text = collect(render())
    if (!text.length) throw new Error('页签「' + label + '」渲染出 0 个节点')
  }
  console.log('OK  ' + labels.length + ' 个页签都能渲染：' + labels.join(' / '))

  // 「它说了什么」必须能看到正文
  tabs = findTabs(render())
  const talkTab = tabs.find((t) => String((t.children && t.children[0]) || '') === '它说了什么')
  if (!talkTab) throw new Error('找不到「它说了什么」页签')
  talkTab.props.onClick()
  const talkText = collect(render())
  if (!talkText.some((x) => x.includes('它说了什么'))) throw new Error('「它说了什么」页签内容没出来')
  if (!talkText.some((x) => x.includes('评论') || x.includes('回评论') || x.includes('回我'))) {
    throw new Error('「它说了什么」里没有任何说话记录')
  }
  console.log('OK  「它说了什么」能看到正文（' + talkText.length + ' 个节点）')

  // 跳转必须能直达评论：href 里要有 #reply<rpid>，不能只到视频页
  const hrefs = []
  const grabHref = (n) => {
    if (n == null) return
    if (Array.isArray(n)) return n.forEach(grabHref)
    if (typeof n !== 'object') return
    if (typeof n.tag === 'function') { try { grabHref(n.tag(n.props || {})) } catch { /* ignore */ } ; return }
    if (n.props && typeof n.props.href === 'string') hrefs.push(n.props.href)
    if (n.children) n.children.forEach(grabHref)
  }
  grabHref(render())
  const jump = hrefs.filter((h) => /#reply\d+/.test(h))
  if (!jump.length) throw new Error('「它说了什么」里没有 #reply<rpid> 的直达链接，只有视频页')
  if (!jump.every((h) => h.startsWith('https://www.bilibili.com/video/BV'))) {
    throw new Error('直达链接格式不对：' + jump[0])
  }
  console.log('OK  能直接跳到对应评论（' + jump.length + ' 个 #reply 链接，例：' + jump[0] + '）')

  // 「碰过的视频」：要有用 —— 能看到每条视频我说了什么，且不能是横着排的
  tabs = findTabs(render())
  const vidTab = tabs.find((t) => String((t.children && t.children[0]) || '') === '碰过的视频')
  if (!vidTab) throw new Error('找不到「碰过的视频」页签')
  vidTab.props.onClick()
  const vidText = collect(render())
  if (!vidText.some((x) => x.includes('今天碰过的视频'))) throw new Error('碰过的视频页签没渲染')
  if (!vidText.some((x) => x.includes('我说过话的'))) throw new Error('没有「我说过话的」筛选')
  if (!vidText.some((x) => x.includes('我在下面说过'))) {
    throw new Error('碰过的视频里看不到「我说了什么」——这一页还是没用')
  }
  if (!vidText.some((x) => x.includes('次动作'))) throw new Error('没有动作总数概览')
  // 布局必须是竖排卡片，不能再用不换行的 flex 行
  const hasOldItem = (() => {
    let found = false
    const walk = (n) => {
      if (n == null || found) return
      if (Array.isArray(n)) return n.forEach(walk)
      if (typeof n !== 'object') return
      if (typeof n.tag === 'function') { try { walk(n.tag(n.props || {})) } catch { /* ignore */ } ; return }
      if (n.props && n.props['data-bi-item'] !== undefined) { found = true; return }
      if (n.children) n.children.forEach(walk)
    }
    walk(render())
    return found
  })()
  if (hasOldItem) throw new Error('「碰过的视频」还在用旧的 data-bi-item 横排布局（会横向溢出）')
  console.log('OK  「碰过的视频」能看出说了什么（' + vidText.length + ' 个节点，竖排卡片）')

  // 「记忆」页签
  tabs = findTabs(render())
  const memTab = tabs.find((t) => String((t.children && t.children[0]) || '') === '记忆')
  if (!memTab) throw new Error('找不到「记忆」页签')
  memTab.props.onClick()
  const memText = collect(render())
  if (!memText.some((x) => x.includes('它记住的东西'))) throw new Error('「记忆」页签内容没出来')
  console.log('OK  「记忆」页签能渲染（' + memText.length + ' 个节点）')

  // 回总览
  tabs = findTabs(render())
  tabs[0].props.onClick()
  render()
}

/* ——— 借用「刷B站」的登录：不该给一个点不动的「退出登录」 ——— */
state.loggedIn = true
state.ownLogin = false
store.clear(); slot = 0
ViewFn()
await new Promise((res) => setTimeout(res, 40))
slot = 0
const tBorrow = collect(ViewFn())
if (!tBorrow.some((x) => x.includes('借用'))) throw new Error('借用登录时没说明是借用的')
if (!tBorrow.some((x) => x.includes('用本插件单独登录'))) throw new Error('借用登录时没给「单独登录」入口')
if (tBorrow.some((x) => x.includes('退出登录'))) throw new Error('借用登录时还给了「退出登录」——点了没用')
console.log('OK  借用登录：给的是「用本插件单独登录」，不是点不动的退出')
state.ownLogin = true

console.log('OK  已登录：显示退出登录、不再显示扫码')

const texts = t2
for (const want of ['B站互动', '总览', '互动', '过程', '设置', '今天动了几次', '还剩额度']) {
  if (!texts.some((x) => x.includes(want))) throw new Error('渲染结果里没有「' + want + '」')
}

// 模板里直接拼对象会渲染成 [object Object]（副标题曾经就是这样坏的）
if (texts.some((x) => String(x).includes('[object Object]'))) {
  throw new Error('[object Object] 漏到界面上了 —— 模板里拼了对象而不是它的某个字段')
}

// 环境状态必须在总览上可见（全绿一行 / 有问题展开 / 还没探测完 三种之一）
if (!texts.some((x) => x.includes('环境就绪') || x.includes('环境还没好') || x.includes('正在检查环境'))) {
  throw new Error('总览里看不到环境状态')
}
console.log('OK  带数据渲染通过：' + texts.length + ' 个文本节点')
console.log('OK  quota=' + JSON.stringify(state.quota))
console.log('OK  live 行数=' + state.live.lines.length + ' / ledger 条数=' + state.recent.length)

// 组件里的 setInterval 会让进程赖着不退，测完直接收工
process.exit(0)
