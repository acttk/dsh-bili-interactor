// 严格 hooks 校验：模拟真 React 的规则 —— 每次渲染 hook 数量必须一致。
// 这是「面板打不开」那个 bug 的直接复现方式：
//   第一次渲染 st=null → 提前 return，只调了 N 个 hook
//   第二次渲染 st=有数据 → 多调一个 useEffect
//   → 真 React 抛 "Rendered more hooks than during the previous render"
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const FILE = fileURLToPath(new URL('../client.js', import.meta.url))

let ok = 0, bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) } else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

// 造数据
const home = join(tmpdir(), 'bi-hooks')
rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true })
const { buildState, localIso } = await import(new URL('../lib/state.js', import.meta.url).href)
const nowIso = localIso()
const mk = (o) => JSON.stringify({ ts: nowIso, ...o })
writeFileSync(join(home, 'ledger.jsonl'), [
  mk({ kind: 'like', ok: true, bvid: 'BV1hA', title: '甲', up: 'UP' }),
  mk({ kind: 'comment', ok: true, bvid: 'BV1hA', title: '甲', up: 'UP', text: '说一句', rpid: '9001' }),
].join('\n') + '\n', 'utf8')
const state = buildState(home, { version: '0.1.0' })

// 严格 React：统计每次渲染的 hook 调用数，超过上一次就报错
let renderHookCount = 0
let hookOrder = []
const store = new Map()
let slot = 0
const strictReact = {
  createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c }),
  Fragment: 'Fragment',
  useState: (init) => {
    renderHookCount++
    hookOrder.push('useState')
    const k = slot++
    if (!store.has(k)) store.set(k, typeof init === 'function' ? init() : init)
    return [store.get(k), (v) => store.set(k, typeof v === 'function' ? v(store.get(k)) : v)]
  },
  useEffect: (fn) => {
    renderHookCount++
    hookOrder.push('useEffect')
    try { return fn() } catch { return undefined }
  },
  useMemo: (fn) => { renderHookCount++; hookOrder.push('useMemo'); return fn() },
  useCallback: (fn) => { renderHookCount++; hookOrder.push('useCallback'); return fn },
  useRef: (v) => { renderHookCount++; hookOrder.push('useRef'); return { current: v } },
}

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '', appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
}
await import(pathToFileURL(FILE).href + '?hooks=1')
const api = loaded.factory((n) => {
  if (n === 'react') return strictReact
  throw new Error('意外的 require: ' + n)
})
let Comp = null
api.apply({
  slots: { inject: (s, cb) => cb(), register: (o, c) => { Comp = c; return { dispose() {} } } },
  effect: (fn) => fn(),
})

// 第一次渲染：接口还没回，st=null → 会走到提前 return
let phase = 0
globalThis.fetch = async () => {
  if (phase === 0) return { ok: true, json: async () => null }
  return { ok: true, json: async () => state }
}

const resetCounters = () => { renderHookCount = 0; hookOrder = []; slot = 0 }

console.log('== 1) 第一次渲染（没数据，提前 return）==')
resetCounters()
const wrapper = Comp()   // 这是 h(Panel) 的结果
const RealComp = (wrapper && (wrapper.type || (wrapper.props && wrapper.props.type))) || wrapper
const first = typeof RealComp === 'function' ? RealComp() : null
const count1 = renderHookCount
const order1 = hookOrder.join(',')
check('渲染出来了', !!first)
check('调了 hook', count1 > 0, String(count1))

console.log('== 2) 第二次渲染（有数据，完整渲染）==')
phase = 1
resetCounters()
// 模拟 setSt(state) 生效：slot 0 就是 st
store.set(0, state)
store.set(1, { items: [], total: 0, used: [] })
const w2 = Comp()
const RealComp2 = (w2 && (w2.type || (w2.props && w2.props.type))) || w2
const second = typeof RealComp2 === 'function' ? RealComp2() : null
const count2 = renderHookCount
const order2 = hookOrder.join(',')

console.log('== 3) 关键：两次渲染的 hook 数量必须一致 ==')
check('数量相同', count1 === count2, '第一次 ' + count1 + ' 个，第二次 ' + count2 + ' 个（多出来的会崩）')
check('顺序相同', order1 === order2, '第一次 ' + order1 + ' ｜ 第二次 ' + order2)

if (count1 !== count2 || order1 !== order2) {
  console.log('\n  ⚠️ 这就是真 React 会报的错：')
  console.log('     Rendered more hooks than during the previous render')
}

rmSync(home, { recursive: true, force: true })
console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
