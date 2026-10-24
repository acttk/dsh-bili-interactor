// 宿主半边冒烟：用一个假 ctx 把 apply() 跑起来，确认
//   1) 路由被注册（/api/bili-interactor）
//   2) state 接口能出数
//   3) /run 在没有登录/没有额度时给出可读的拒绝理由，而不是崩
// 注意：这里不打真 B站 接口 —— 只测接线。
process.env.BILI_INTERACTOR_HOME = process.env.TEMP + '\\bi-smoke-home'

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
if (r.path !== '/api/bili-interactor') throw new Error('路由路径不对：' + r.path)
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

const st = await call('GET', '/api/bili-interactor/state')
if (st.code !== 200) throw new Error('state HTTP ' + st.code)
if (!st.json.ok) throw new Error('state 返回 ok=false')
console.log('OK  state: quota=' + JSON.stringify(st.json.quota) + '  version=' + st.json.version)

const cfg = await call('GET', '/api/bili-interactor/config')
if (!cfg.json.ok || !cfg.json.config) throw new Error('config 接口不对')
console.log('OK  config: enabled=' + cfg.json.config.enabled + ' keywords=' + JSON.stringify(cfg.json.config.keywords))

const patched = await call('POST', '/api/bili-interactor/config', { maxActionsPerRun: 7 })
if (!patched.json.ok || patched.json.config.maxActionsPerRun !== 7) throw new Error('配置写不进去')
console.log('OK  patch config: maxActionsPerRun=' + patched.json.config.maxActionsPerRun)

// 额度为 0 时 /run 应该给出可读理由（这里把每日上限改成 0 再调）
await call('POST', '/api/bili-interactor/config', { maxActionsPerDay: 0 })
const run0 = await call('POST', '/api/bili-interactor/run')
if (run0.json.started !== false) throw new Error('额度为 0 却返回 started=true（骗人）')
if (!run0.json.error || !run0.json.error.includes('上限')) throw new Error('拒绝理由不清楚：' + run0.json.error)
console.log('OK  run(quota=0) 正确拒绝: ' + run0.json.error)

// 关掉总开关，也该被拒
await call('POST', '/api/bili-interactor/config', { enabled: false, maxActionsPerDay: 120 })
const run1 = await call('POST', '/api/bili-interactor/run')
if (run1.json.started !== false) throw new Error('关着却跑起来了')
console.log('OK  run(disabled) 正确拒绝: ' + run1.json.error)
await call('POST', '/api/bili-interactor/config', { enabled: true })

const live = await call('GET', '/api/bili-interactor/live')
if (!live.json.ok) throw new Error('live 接口不对')
console.log('OK  live: exists=' + live.json.exists + ' lines=' + live.json.lines.length)

console.log('ALL PASS')
process.exit(0)
