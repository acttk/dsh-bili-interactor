// 验证二维码「时间预算」逻辑：绝不把一张快过期的码递给用户。
// 用伪造的 login.json 快照来模拟不同年龄的码，不需要真的等 3 分钟。
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
process.env.BILI_INTERACTOR_HOME = join(process.env.TEMP, 'bi-ttl')
process.env.DSH_HOME = join(process.env.TEMP, 'bi-ttl-dsh')
process.env.BILI_INTERACTOR_SCRIPT = join(ROOT, 'tests', '_stub_interact.py')
try { rmSync(process.env.BILI_INTERACTOR_HOME, { recursive: true, force: true }) } catch {}
mkdirSync(process.env.BILI_INTERACTOR_HOME, { recursive: true })

let ok = 0, bad = 0
const check = (n, c, extra = '') => {
  if (c) { ok++; console.log('  OK   ' + n) } else { bad++; console.log('  FAIL ' + n + '  ' + extra) }
}

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
    code: 0, body: '',
    writeHead(c) { this.code = c },
    end(s) { this.body = s; resolve({ code: this.code, json: JSON.parse(s) }) },
  }
  handler(req, res)
})

const loginFile = join(process.env.BILI_INTERACTOR_HOME, 'login.json')
const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const put = (ageMs) => writeFileSync(loginFile, JSON.stringify({
  qrcodeKey: 'K_' + ageMs, at: Date.now() - ageMs, gen: 1, image: pngB64,
}), 'utf8')

console.log('== 刚生成的码（0 秒）==')
put(0)
let v = await call('GET', '/api/bili-itx/login/view')
check('pending=true', v.json.pending === true)
check('leftSec 接近 180', v.json.leftSec >= 175 && v.json.leftSec <= 180, 'leftSec=' + v.json.leftSec)

console.log('== 已过 100 秒（还剩 80）==')
put(100_000)
v = await call('GET', '/api/bili-itx/login/view')
check('仍然可用', v.json.pending === true)
check('leftSec 约 80', v.json.leftSec >= 75 && v.json.leftSec <= 85, 'leftSec=' + v.json.leftSec)

console.log('== 已过 140 秒（还剩 40，不够用户操作）==')
put(140_000)
v = await call('GET', '/api/bili-itx/login/view')
check('不再展示（pending=false）', v.json.pending === false, JSON.stringify({ p: v.json.pending, left: v.json.leftSec }))
check('不返回图片', !v.json.image)

const qr = await call('POST', '/api/bili-itx/login/qr')
check('点扫码登录时会生成新的，不复用快过期的', qr.json.qrcodeKey !== 'K_140000', qr.json.qrcodeKey)

console.log('== 已过 175 秒（快死透了）==')
put(175_000)
v = await call('GET', '/api/bili-itx/login/view')
check('pending=false', v.json.pending === false)

console.log('== force=1 必须真的换 ==')
put(0)
const before = JSON.parse(readFileSync(loginFile, 'utf8')).qrcodeKey
const forced = await call('POST', '/api/bili-itx/login/qr?force=1')
check('换了一张新的', forced.json.qrcodeKey !== before, before + ' -> ' + forced.json.qrcodeKey)

console.log('== 不带 force 且码还新鲜时要复用 ==')
const again = await call('POST', '/api/bili-itx/login/qr')
check('复用同一张', again.json.qrcodeKey === forced.json.qrcodeKey, again.json.qrcodeKey)
check('标了 reused', again.json.reused === true)

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
