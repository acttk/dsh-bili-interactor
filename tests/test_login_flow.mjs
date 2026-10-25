// 集成测试：证明「扫码 → 后台自动收尾 → 写入凭证 → 界面变已登录」这条链真的通。
//
// ⚠️ 上一版这个测试干过一件蠢事：直接替换 py/interact.py 来打桩，
//    结果**运行中的插件后台轮询器也用了那个桩**，把假凭证写进了真实目录。
//    现在改用 BILI_INTERACTOR_SCRIPT 指向桩文件，真脚本一个字节都不碰。
import { join } from 'node:path'
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = 'C:\\Users\\user\\Desktop\\DSH\\dsh-bili-interactor'
const REAL = join(ROOT, 'py', 'interact.py')
const STUB = join(ROOT, 'tests', '_stub_interact.py')

/** 测试全程用独立目录，绝不碰真实 ~/.dsh/bili-interactor */
process.env.BILI_INTERACTOR_HOME = join(process.env.TEMP, 'bi-integ')
process.env.DSH_HOME = join(process.env.TEMP, 'bi-integ-dsh')
process.env.BILI_INTERACTOR_SCRIPT = STUB

try { rmSync(process.env.BILI_INTERACTOR_HOME, { recursive: true, force: true }) } catch {}
mkdirSync(process.env.BILI_INTERACTOR_HOME, { recursive: true })

const realHashBefore = createHash('sha256').update(readFileSync(REAL)).digest('hex').toUpperCase()

let ok = 0
let bad = 0
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  OK   ' + name) }
  else { bad++; console.log('  FAIL ' + name + '  ' + extra) }
}

try {
  const routes = []
  const ctx = {
    effect(fn) { return fn() },
    webServer: { register(o) { routes.push(o); return { dispose() {} } } },
    jobs: { attachController() {}, start() { return { dispose() {} } } },
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

  console.log('== 1) 点「扫码登录」应拿到码 ==')
  const qr = await call('POST', '/api/bili-itx/login/qr')
  check('返回 ok', qr.json.ok === true, JSON.stringify(qr.json).slice(0, 120))
  check('有二维码图片', String(qr.json.image || '').startsWith('data:image/png;base64,'))
  check('有 qrcodeKey', qr.json.qrcodeKey === 'FAKEKEY_TEST_ONLY', qr.json.qrcodeKey)

  console.log('== 2) 磁盘上是原子快照（key + 图同一份） ==')
  const loginFile = join(process.env.BILI_INTERACTOR_HOME, 'login.json')
  check('login.json 存在', existsSync(loginFile))
  const snap = JSON.parse(readFileSync(loginFile, 'utf8'))
  check('同时含 key 和 image', !!snap.qrcodeKey && !!snap.image, Object.keys(snap).join(','))

  console.log('== 3) 后台轮询器自动完成登录（不靠前端） ==')
  const credFile = join(process.env.BILI_INTERACTOR_HOME, 'credential.json')
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (existsSync(credFile)) break
  }
  check('credential.json 被自动写入', existsSync(credFile))
  if (existsSync(credFile)) {
    const c = JSON.parse(readFileSync(credFile, 'utf8'))
    check('凭证内容正确', c.sessdata === 'FAKE_SESSDATA' && c.bili_jct === 'FAKE_JCT')
  }

  console.log('== 4) 界面立刻变「已登录」 ==')
  const st = await call('GET', '/api/bili-itx/state')
  check('state.loggedIn=true', st.json.loggedIn === true)
  check('state.ownLogin=true', st.json.ownLogin === true)
  const view = await call('GET', '/api/bili-itx/login/view')
  check('/login/view 报已登录', view.json.loggedIn === true)
  check('/login/view 不再给二维码', view.json.pending === false && !view.json.image)

  console.log('== 5) 登录后清掉 login.json（避免下次误判） ==')
  check('login.json 已删除', !existsSync(loginFile))
} catch (e) {
  bad++
  console.log('  FAIL 异常: ' + (e && e.stack ? e.stack : e))
}

// 收尾：确认真脚本没被动过
const realHashAfter = createHash('sha256').update(readFileSync(REAL)).digest('hex').toUpperCase()
console.log('')
check('真脚本未被修改（这是上一版的教训）', realHashBefore === realHashAfter)

// 确认真实目录没被污染
const realHome = join(process.env.USERPROFILE + '', '.dsh', 'bili-interactor')
try {
  const rc = join(realHome, 'credential.json')
  if (existsSync(rc)) {
    const c = JSON.parse(readFileSync(rc, 'utf8'))
    check('真实目录没有假凭证', !String(c.sessdata || '').startsWith('FAKE'), c.sessdata)
  } else {
    check('真实目录没有假凭证', true)
  }
} catch {
  check('真实目录没有假凭证', true)
}

console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
