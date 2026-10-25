// 宿主半边冒烟：用一个假 ctx 把 apply() 跑起来，确认
//   1) 路由被注册（/api/bili-itx）
//   2) state 接口能出数
//   3) /run 在没有登录/没有额度时给出可读的拒绝理由，而不是崩
// 注意：这里不打真 B站 接口 —— 只测接线。
process.env.BILI_INTERACTOR_HOME = process.env.TEMP + '\\bi-smoke-home'
// 把 DSH_HOME 也指到空目录，否则会退回真机那份 bili-duty 凭证，测不出「未登录」
process.env.DSH_HOME = process.env.TEMP + '\\bi-smoke-dsh'

const { rmSync } = await import('node:fs')
try { rmSync(process.env.BILI_INTERACTOR_HOME, { recursive: true, force: true }) } catch {}

const routes = []
const effects = []
const jobs = []

const ctx = {
  effect(fn, label) { effects.push(label); return fn() },
  webServer: {
    register(opts) {
      routes.push(opts)
      return { dispose() {} }
    },
  },
  jobs: {
    attachController() {},
    start(opts) { jobs.push(opts); return { dispose() {} } },
  },
}

const mod = await import('file:///C:/Users/user/Desktop/DSH/dsh-bili-interactor/lib/index.js')
if (!mod.apply) throw new Error('没有 export apply')
if (mod.name !== 'bili-interactor') throw new Error('name 不对：' + mod.name)
if (!Array.isArray(mod.inject) || !mod.inject.includes('webServer')) throw new Error('inject 不对')

mod.apply(ctx, {})

if (routes.length !== 1) throw new Error('路由没注册，数量=' + routes.length)
const r = routes[0]
if (r.path !== '/api/bili-itx') throw new Error('路由路径不对：' + r.path)
if (typeof r.handler !== 'function') throw new Error('handler 不是函数')

console.log('OK  name=' + mod.name + '  inject=' + mod.inject.join(','))
console.log('OK  route=' + r.path + ' (kind=' + r.kind + ')')
console.log('OK  effects=' + effects.length + '  jobs=' + jobs.length)

// 造一个假 req/res 调 handler
function call(method, path, body) {
  return new Promise((resolve) => {
    const req = {
      method, url: path, headers: { host: '127.0.0.1:1234' },
      on(ev, cb) {
        if (ev === 'data' && body) cb(JSON.stringify(body))
        if (ev === 'end') cb()
        return this
      },
      destroy() {},
    }
    const res = {
      code: 0, body: '',
      writeHead(c) { this.code = c },
      end(s) { this.body = s; resolve({ code: this.code, json: JSON.parse(s) }) },
    }
    r.handler(req, res)
  })
}

const st = await call('GET', '/api/bili-itx/state')
if (st.code !== 200) throw new Error('state HTTP ' + st.code)
if (!st.json.ok) throw new Error('state 返回 ok=false')
console.log('OK  state: quota=' + JSON.stringify(st.json.quota) + '  version=' + st.json.version)

const cfg = await call('GET', '/api/bili-itx/config')
if (!cfg.json.ok || !cfg.json.config) throw new Error('config 接口不对')
console.log('OK  config: enabled=' + cfg.json.config.enabled + ' keywords=' + JSON.stringify(cfg.json.config.keywords))

const patched = await call('POST', '/api/bili-itx/config', { maxActionsPerRun: 7 })
if (!patched.json.ok || patched.json.config.maxActionsPerRun !== 7) throw new Error('配置写不进去')
console.log('OK  patch config: maxActionsPerRun=' + patched.json.config.maxActionsPerRun)

/* ── 未登录时 /run 必须拦住并告诉前端去登录 ── */
const runNoLogin = await call('POST', '/api/bili-itx/run')
if (runNoLogin.json.started !== false) throw new Error('没登录却跑起来了')
if (!runNoLogin.json.needLogin) throw new Error('没登录时该给 needLogin 标记')
console.log('OK  run(未登录) 正确拦截: ' + runNoLogin.json.error)

const st2 = await call('GET', '/api/bili-itx/state')
if (typeof st2.json.loggedIn !== 'boolean') throw new Error('state 里没有 loggedIn')
if (st2.json.loggedIn !== false) throw new Error('临时 home 没凭证，loggedIn 该是 false')
console.log('OK  state.loggedIn=false（未登录态正确）')

const me0 = await call('GET', '/api/bili-itx/me')
if (me0.json.needLogin !== true) throw new Error('未登录时 /me 该给 needLogin')
console.log('OK  GET /me 未登录: ' + me0.json.error)

/* ── 造一份假凭证，好继续测额度/开关两条护栏（不会真发请求：后面都会先被拦） ── */
const { mkdirSync, writeFileSync } = await import('node:fs')
const credFile = process.env.BILI_INTERACTOR_HOME + '\\credential.json'
mkdirSync(process.env.BILI_INTERACTOR_HOME, { recursive: true })
writeFileSync(credFile, JSON.stringify({ sessdata: 'x', bili_jct: 'y', buvid3: 'z', dedeuserid: '1' }), 'utf8')
const st3 = await call('GET', '/api/bili-itx/state')
if (st3.json.loggedIn !== true) throw new Error('放了凭证却还说没登录')
console.log('OK  state.loggedIn=true（有凭证就认）')

// 每日上限 = 0 现在语义是「不限」，所以它不该再被当成 0 次拦下来。
// 真要用「额度耗尽」来测拦截，就把「一轮上限」设成 0 —— 那是真的一次都不许。
await call('POST', '/api/bili-itx/config', { maxActionsPerDay: 0, maxActionsPerRun: 0 })
const run0 = await call('POST', '/api/bili-itx/run')
if (run0.json.started !== false) throw new Error('一轮上限为 0 却返回 started=true（骗人）')
console.log('OK  run(maxActionsPerRun=0) 正确拒绝: ' + (run0.json.error || '(无理由)'))

// 每日上限 = 0 应该是「不限」，不该拦住
await call('POST', '/api/bili-itx/config', { maxActionsPerDay: 0, maxActionsPerRun: 5 })
const stUnlimited = await call('GET', '/api/bili-itx/state')
const left0 = stUnlimited.json.quota.left
if (left0 === 0) throw new Error('每日上限 0 被当成「禁止」了（应该是不限）')
console.log('OK  每日上限 0 = 不限（remaining=' + left0 + '）')

// 关掉总开关，也该被拒
await call('POST', '/api/bili-itx/config', { enabled: false, maxActionsPerDay: 120, maxActionsPerRun: 20 })
const run1 = await call('POST', '/api/bili-itx/run')
if (run1.json.started !== false) throw new Error('关着却跑起来了')
console.log('OK  run(disabled) 正确拒绝: ' + run1.json.error)
await call('POST', '/api/bili-itx/config', { enabled: true })

/* ── 登录视图：单一数据源，绝不能出现「图是旧的、key 是新的」 ── */
const { writeFileSync: wf, rmSync: rmf } = await import('node:fs')
const HOME_S = process.env.BILI_INTERACTOR_HOME
const loginFile = HOME_S + '\\login.json'
const qrFile = HOME_S + '\\qr.png'

// 1) 没有码、也没登录时：pending=false / loggedIn=false
try { rmf(HOME_S + '\\credential.json', { force: true }) } catch {}
try { rmf(loginFile, { force: true }) } catch {}
let view = await call('GET', '/api/bili-itx/login/view')
if (view.json.pending !== false) throw new Error('没有码却报 pending=true')
if (view.json.loggedIn !== false) throw new Error('不该显示已登录')
if (view.json.image) throw new Error('没码却返回了图片')
console.log('OK  /login/view 无码: pending=false loggedIn=false 无图')

// 2) 放一张 1 分钟内的码：pending=true 且带图
const pngTiny = Buffer.from('89504E470D0A1A0A0000000D4948445200000001000000010802000000907753DE', 'hex')
// 新结构：图和 key 存在同一个 login.json 里（原子快照）
wf(loginFile, JSON.stringify({ qrcodeKey: 'TESTKEY123', at: Date.now() - 30000, gen: 1, image: pngTiny.toString('base64') }), 'utf8')

view = await call('GET', '/api/bili-itx/login/view')
if (view.json.pending !== true) throw new Error('有码却报 pending=false')
if (!String(view.json.image || '').startsWith('data:image/png;base64,')) throw new Error('没返回图片')
if (!(view.json.leftSec > 100 && view.json.leftSec <= 165)) throw new Error('leftSec 不合理: ' + view.json.leftSec)
console.log('OK  /login/view 有码: pending=true leftSec=' + view.json.leftSec + ' 有图')

// 3) 过期的码：pending=false（避免展示一张死图）
wf(loginFile, JSON.stringify({ qrcodeKey: 'OLDKEY', at: Date.now() - 200000 }), 'utf8')
view = await call('GET', '/api/bili-itx/login/view')
if (view.json.pending !== false) throw new Error('过期码却报 pending=true')
if (view.json.image) throw new Error('过期码不该返回图片')
console.log('OK  /login/view 过期码: pending=false 且不返回图片')

// 4) 已登录时：loggedIn=true（即使还残留二维码也不能影响）
wf(HOME_S + '\\credential.json', JSON.stringify({ sessdata: 'x', bili_jct: 'y', buvid3: 'z', dedeuserid: '1' }), 'utf8')
wf(loginFile, JSON.stringify({ qrcodeKey: 'K2', at: Date.now() - 10000, gen: 2, image: pngTiny.toString('base64') }), 'utf8')
view = await call('GET', '/api/bili-itx/login/view')
if (view.json.loggedIn !== true) throw new Error('有凭证却报 loggedIn=false')
console.log('OK  /login/view 已登录: loggedIn=true（残留二维码不影响判定）')

try { rmf(qrFile, { force: true }); rmf(loginFile, { force: true }) } catch {}

const live = await call('GET', '/api/bili-itx/live')
if (!live.json.ok) throw new Error('live 接口不对')
console.log('OK  live: exists=' + live.json.exists + ' lines=' + live.json.lines.length)

console.log('ALL PASS')
process.exit(0)
