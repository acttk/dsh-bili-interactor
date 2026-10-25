// 集成测试：证明「扫码 → 后台自动收尾 → 写入凭证 → 界面变已登录」这条链真的通。
//
// 登录现在走 Node（lib/login.mjs），凭证从 **Set-Cookie** 里取。
// 这里用 globalThis.__BILI_LOGIN_STUB__ 打桩：不碰网络、不碰真实凭证、
// 也不去改动 py/interact.py（上一版改它，结果把假凭证写进了真实目录）。
import { join } from 'node:path'
import { rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'

const ROOT = 'C:\\Users\\user\\Desktop\\DSH\\dsh-bili-interactor'
const HOME = join(process.env.TEMP, 'bi-integ')
process.env.BILI_INTERACTOR_HOME = HOME
process.env.DSH_HOME = join(process.env.TEMP, 'bi-integ-dsh')
// 共享凭证（「刷B站」用的那份）也指到临时目录，别覆盖真实的
process.env.BILI_INTERACTOR_SHARED_DIR = join(process.env.TEMP, 'bi-integ-shared')
try { rmSync(HOME, { recursive: true, force: true }) } catch {}
mkdirSync(HOME, { recursive: true })

// ── 桩：前一次 waiting，之后 done + 凭证 ──
let polls = 0
globalThis.__BILI_LOGIN_STUB__ = {
  async loginStart() {
    return { key: 'STUBKEY_INTEG', url: 'https://example.invalid/qr' }
  },
  async loginPoll() {
    polls++
    if (polls < 2) return { state: 'waiting', code: 86101 }
    return {
      state: 'ok',
      code: 0,
      credential: { sessdata: 'STUB_SESS', bili_jct: 'STUB_JCT', buvid3: 'STUB_BUVID', dedeuserid: '999' },
    }
  },
  renderQrDataUrl() {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  },
}

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
    code: 0,
    writeHead(c) { this.code = c },
    end(s) { resolve({ code: this.code, json: JSON.parse(s) }) },
  }
  handler(req, res)
})

console.log('== 1) 点「扫码登录」应拿到码 ==')
const qr = await call('POST', '/api/bili-itx/login/qr?force=1')
check('返回 ok', qr.json.ok === true, JSON.stringify(qr.json).slice(0, 120))
check('有二维码图片', String(qr.json.image || '').startsWith('data:image/png;base64,'))
check('有 qrcodeKey', qr.json.qrcodeKey === 'STUBKEY_INTEG', qr.json.qrcodeKey)

console.log('== 2) 磁盘上是原子快照（key + 图同一份）==')
const loginFile = join(HOME, 'login.json')
check('login.json 存在', existsSync(loginFile))
const snap = JSON.parse(readFileSync(loginFile, 'utf8'))
check('同时含 key 和 image', !!snap.qrcodeKey && !!snap.image, Object.keys(snap).join(','))

console.log('== 3) 后台轮询器自动完成登录（不靠前端）==')
const credFile = join(HOME, 'credential.json')
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 400))
  if (existsSync(credFile)) break
}
check('credential.json 被自动写入', existsSync(credFile))
if (existsSync(credFile)) {
  const c = JSON.parse(readFileSync(credFile, 'utf8'))
  check('凭证内容正确', c.sessdata === 'STUB_SESS' && c.bili_jct === 'STUB_JCT')
}

console.log('== 4) 界面立刻变「已登录」==')
const st = await call('GET', '/api/bili-itx/state')
check('state.loggedIn=true', st.json.loggedIn === true)
check('state.ownLogin=true', st.json.ownLogin === true)
const view = await call('GET', '/api/bili-itx/login/view')
check('/login/view 报已登录', view.json.loggedIn === true)
check('/login/view 不再给二维码', view.json.pending === false && !view.json.image)

console.log('== 5) 登录后清掉 login.json ==')
check('login.json 已删除', !existsSync(loginFile))

// 确认真实目录没被污染
const realCred = join(process.env.USERPROFILE + '', '.dsh', 'bili-interactor', 'credential.json')
if (existsSync(realCred)) {
  const c = JSON.parse(readFileSync(realCred, 'utf8'))
  check('真实目录没有桩凭证', !String(c.sessdata || '').startsWith('STUB'), c.sessdata)
} else {
  check('真实目录没有桩凭证', true)
}

// 真实共享凭证（刷B站 读的那份）不能被测试写成桩数据
try {
  const sharedReal = join(process.env.USERPROFILE + '', '.dsh', 'bili-duty', 'bili_credential.json')
  if (existsSync(sharedReal)) {
    const c = JSON.parse(readFileSync(sharedReal, 'utf8'))
    check('真实共享凭证没被测试污染', !String(c.sessdata || '').startsWith('STUB'), c.sessdata)
  } else {
    check('真实共享凭证没被测试污染', true)
  }
} catch {
  check('真实共享凭证没被测试污染', true)
}

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
