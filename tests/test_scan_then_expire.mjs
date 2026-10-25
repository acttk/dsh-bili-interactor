// 复现并验证用户报的那个场景：
//   扫码 -> 界面显示「扫到了，去手机确认」 -> 用户还没点确认，码过期
// 期望：界面必须明确告诉他「你刚扫的那张废了，重新扫」，而不是悄悄换一张新的。
//
// 登录已改为 Node 实现（lib/login.mjs），用 globalThis.__BILI_LOGIN_STUB__ 打桩。
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const HOME = join(process.env.TEMP, 'bi-seq')
process.env.BILI_INTERACTOR_HOME = HOME
process.env.DSH_HOME = join(process.env.TEMP, 'bi-seq-dsh')
try { rmSync(HOME, { recursive: true, force: true }) } catch {}
mkdirSync(HOME, { recursive: true })

// 桩：先 waiting，再 scanned（用户扫了），然后 expired（还没确认就死了）
let polls = 0
let gen = 0
globalThis.__BILI_LOGIN_STUB__ = {
  async loginStart() {
    gen++
    return { key: 'SEQKEY_' + gen, url: 'https://example.invalid/qr' }
  },
  async loginPoll() {
    polls++
    if (polls === 1) return { state: 'waiting', code: 86101 }
    if (polls === 2) return { state: 'scanned', code: 86090 }
    return { state: 'expired', code: 86038 }
  },
  renderQrDataUrl() {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  },
}

let ok = 0, bad = 0
const check = (n, c, extra = '') => {
  if (c) { ok++; console.log('  OK   ' + n) } else { bad++; console.log('  FAIL ' + n + '  ' + extra) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const routes = []
const ctx = {
  effect(fn) { return fn() },
  webServer: { register(o) { routes.push(o); return { dispose() {} } } },
}
const mod = await import('file:///' + join(ROOT, 'lib', 'index.js').replace(/\\/g, '/'))
mod.apply(ctx, {})

const handler = routes[0].handler
const call = (method, path, body) => new Promise((resolve) => {
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
    code: 0,
    writeHead(c) { this.code = c },
    end(s) { resolve({ code: this.code, json: JSON.parse(s) }) },
  }
  handler(req, res)
})

console.log('== 生成码 ==')
const qr = await call('POST', '/api/bili-itx/login/qr?force=1')
check('拿到码', !!qr.json.qrcodeKey, qr.json.qrcodeKey)

console.log('== 等后台轮询走到 conf（模拟用户扫了码）==')
let sawConf = false
for (let i = 0; i < 20; i++) {
  await sleep(300)
  const v = await call('GET', '/api/bili-itx/login/view')
  if (v.json.state === 'conf') { sawConf = true; break }
}
check('界面进入了 conf（扫到了）', sawConf)

console.log('== 再等：桩返回 expired，模拟「还没点确认就过期」==')
let sawExpired = false
for (let i = 0; i < 30; i++) {
  await sleep(300)
  const v = await call('GET', '/api/bili-itx/login/view')
  if (v.json.expiredAfterScan === true) { sawExpired = true; break }
}
check('标记了 expiredAfterScan（用户要知道自己扫的那张废了）', sawExpired)

const v2 = await call('GET', '/api/bili-itx/login/view')
check('仍然给出一张新码让他重扫', v2.json.pending === true)
check('新码有充足剩余时间', v2.json.leftSec > 100, 'leftSec=' + v2.json.leftSec)

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
