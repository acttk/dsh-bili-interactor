// 验证「主动续期」：码快到期但还没人扫时，后台自己提前换一张，
// 用户屏幕上永远不会出现一张只剩几秒的死码。
//
// 用 BILI_QR_TTL_MS 把 180 秒缩短到 6 秒，几秒内就能验完。
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const HOME = join(process.env.TEMP, 'bi-refresh')
process.env.BILI_INTERACTOR_HOME = HOME
process.env.DSH_HOME = join(process.env.TEMP, 'bi-refresh-dsh')
process.env.BILI_INTERACTOR_SCRIPT = join(ROOT, 'tests', '_stub_scan_only.py')
process.env.BILI_QR_TTL_MS = '6000'

try { rmSync(HOME, { recursive: true, force: true }) } catch {}
mkdirSync(HOME, { recursive: true })

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

console.log('== 生成一张码（TTL 只有 6 秒用于测试）==')
const qr = await call('POST', '/api/bili-itx/login/qr?force=1')
const key0 = qr.json.qrcodeKey
check('拿到码', !!key0, key0)

console.log('== 持续模拟「页面开着」，观察后台是否提前换码 ==')
let keyNow = key0
let refreshed = false
for (let i = 0; i < 20; i++) {
  await sleep(300)
  const v = await call('GET', '/api/bili-itx/login/view')
  // 任何时候展示给用户的码，剩余时间都不该少得离谱
  if (v.json.pending && v.json.leftSec !== undefined && v.json.leftSec < 1) {
    bad++
    console.log('  FAIL 展示了一张没有剩余时间的码: leftSec=' + v.json.leftSec)
  }
  if (v.json.gen > 1) { refreshed = true; keyNow = 'gen' + v.json.gen; break }
}
check('后台自动换过码（gen 递增）', refreshed)

const vEnd = await call('GET', '/api/bili-itx/login/view')
check('换过之后仍有可用码', vEnd.json.pending === true, JSON.stringify({ p: vEnd.json.pending, left: vEnd.json.leftSec }))
check('剩余时间充足（不是死的）', vEnd.json.leftSec > 2, 'leftSec=' + vEnd.json.leftSec)

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
