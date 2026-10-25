// 专门锁死这次的真根因：凭证在 Set-Cookie 里，不在 data.url 的 query 里。
//
// 以前的实现从 data.url 里 parse_qs 找 SESSDATA —— B站 成功时那条 url
// 根本没有 SESSDATA（那是别的域的游戏票），于是永远拿到空凭证：
// 手机上明明确认成功，插件这边永远不算登录。
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')

let ok = 0, bad = 0
const check = (n, c, extra = '') => {
  if (c) { ok++; console.log('  OK   ' + n) } else { bad++; console.log('  FAIL ' + n + '  ' + extra) }
}

// 关掉测试接缝，让真正的 loginPoll 跑起来
delete globalThis.__BILI_LOGIN_STUB__

const realFetch = globalThis.fetch

function fakeResponse({ code, cookies = [], url = '' }) {
  const headers = new Headers()
  for (const c of cookies) headers.append('set-cookie', c)
  const body = JSON.stringify({ code: 0, message: '0', data: { code, url, message: '' } })
  return new Response(body, { status: 200, headers })
}

const { loginPoll, pickCookies } = await import(
  'file:///' + join(ROOT, 'lib', 'login.mjs').replace(/\\/g, '/')
)

console.log('== 1) 成功时从 Set-Cookie 抠出凭证（关键）==')
globalThis.fetch = async () =>
  fakeResponse({
    code: 0,
    // 故意让 url 里没有 SESSDATA —— 复现真实情况
    url: 'https://passport.biligame.com/crossDomain?DedeUserID=999',
    cookies: [
      'SESSDATA=abc%2C123%2Cxyz; Path=/; Domain=.bilibili.com; HttpOnly',
      'bili_jct=JCT123; Path=/; Domain=.bilibili.com',
      'DedeUserID=999; Path=/; Domain=.bilibili.com',
      'buvid3=BUVID123; Path=/',
      'sid=whatever; Path=/',
    ],
  })

let r = await loginPoll('somekey')
check('state=ok', r.state === 'ok', JSON.stringify(r))
check('拿到 sessdata', r.credential?.sessdata === 'abc%2C123%2Cxyz', r.credential?.sessdata)
check('拿到 bili_jct', r.credential?.bili_jct === 'JCT123', r.credential?.bili_jct)
check('拿到 dedeuserid', r.credential?.dedeuserid === '999', r.credential?.dedeuserid)
check('拿到 buvid3', r.credential?.buvid3 === 'BUVID123', r.credential?.buvid3)
check('不认识的 cookie 不会混进来', !('sid' in (r.credential || {})), JSON.stringify(r.credential))

console.log('== 2) 各种状态码映射正确 ==')
for (const [code, want] of [[86101, 'waiting'], [86090, 'scanned'], [86038, 'expired']]) {
  globalThis.fetch = async () => fakeResponse({ code })
  const x = await loginPoll('k')
  check(`code=${code} -> ${want}`, x.state === want, x.state)
}

console.log('== 3) 成功但没有 SESSDATA 要明确报错，不能假装成功 ==')
globalThis.fetch = async () => fakeResponse({ code: 0, url: 'https://x/y', cookies: ['bili_jct=only; Path=/'] })
r = await loginPoll('k')
check('state 不是 ok', r.state !== 'ok', r.state)
check('说明原因', /SESSDATA/.test(r.message || ''), r.message)

console.log('== 4) 不跟随重定向（Set-Cookie 在 3xx 上）==')
let sawRedirectManual = false
globalThis.fetch = async (_u, init) => {
  sawRedirectManual = init?.redirect === 'manual'
  return fakeResponse({ code: 86101 })
}
await loginPoll('k')
check('fetch 用 redirect: manual', sawRedirectManual)

console.log('== 5) pickCookies 单测 ==')
const jar = pickCookies(['SESSDATA=a%2Cb; Path=/; HttpOnly', 'bili_jct=c; Path=/', 'garbage', '=bad'])
check('sessdata 正确', jar.sessdata === 'a%2Cb', jar.sessdata)
check('bili_jct 正确', jar.bili_jct === 'c', jar.bili_jct)
check('null 输入不炸', Object.keys(pickCookies(null)).length === 0)

globalThis.fetch = realFetch
console.log('\nPASS ' + ok + ' / FAIL ' + bad)
process.exit(bad === 0 ? 0 : 1)
