/**
 * lib/login.mjs —— 扫码登录（直接在 Node 里走 B站 passport 接口）
 * ============================================================================
 * ⚠️ 这个文件是照着能跑通的实现（dsh-bili-scroll 的 lib/login.mjs）重写的。
 *    之前那版错在**取凭证的位置**：
 *
 *    ① GET  /x/passport-login/web/qrcode/generate?source=main-fe-header
 *         -> data.url（二维码内容）+ data.qrcode_key
 *    ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
 *         data.code：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
 *    ③ ⭐⭐ **凭证在轮询响应的 `Set-Cookie` 头里**。
 *         成功时那条 `data.url` 的 query 里**没有** SESSDATA ——
 *         那是别的域的游戏票，别在 url 里找。
 *         以前就是从 url 里 parse_qs，所以永远拿到空 sessdata，
 *         于是「手机上明明确认成功了，插件这边永远不算登录」。
 *    ④ 写成 MCP 认识的四个字段：sessdata / bili_jct / buvid3 / dedeuserid
 * ============================================================================
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key) =>
  'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' +
  encodeURIComponent(key) +
  '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

/** 从 Set-Cookie 列表里抠出需要的几个 */
export function pickCookies(list) {
  const jar = {}
  const want = {
    SESSDATA: 'sessdata',
    bili_jct: 'bili_jct',
    DedeUserID: 'dedeuserid',
    buvid3: 'buvid3',
  }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

/** 拿不到 buvid3 时补一张指纹（非致命） */
async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar
  try {
    const r = await fetch(SPI, { headers: { 'User-Agent': UA } })
    const j = await r.json()
    const v = j?.data?.b_3
    if (v) jar.buvid3 = v
  } catch {
    /* 拿不到就算了 */
  }
  return jar
}

// 测试接缝：设了 globalThis.__BILI_LOGIN_STUB__ 就走桩（生产环境是 undefined）
const stub = () => globalThis.__BILI_LOGIN_STUB__ || null

/** 生成二维码：返回 { key, url } */
export async function loginStart() {
  const sb = stub()
  if (sb) return sb.loginStart()
  const r = await fetch(GEN, { headers: { 'User-Agent': UA } })
  const j = await r.json()
  const data = j?.data
  if (!data?.qrcode_key || !data?.url) {
    throw new Error(`生成二维码失败：${j?.message || '返回里没有 qrcode_key'}`)
  }
  return { key: String(data.qrcode_key), url: String(data.url) }
}

/**
 * 轮询一次。
 * @returns {{state:'waiting'|'scanned'|'ok'|'expired'|'unknown', code:number, credential?:object, message?:string}}
 */
export async function loginPoll(key) {
  const sb = stub()
  if (sb) return sb.loginPoll(key)
  const res = await fetch(pollUrl(key), {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  })
  const setCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  let body = {}
  try {
    body = await res.json()
  } catch {
    /* poll 有时返回空体 */
  }
  const code = body?.data?.code

  if (code === 0) {
    const jar = await ensureBuvid3(pickCookies(setCookies))
    if (!jar.sessdata) {
      return {
        state: 'unknown',
        code,
        message: 'B站说成功了，但 Set-Cookie 里没有 SESSDATA',
      }
    }
    return { state: 'ok', code, credential: jar }
  }

  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', code, message: body?.message || '' }
}

/** 用 venv 里的 python `qrcode` 画 PNG，返回 data URI（画不出来就返回空串） */
export async function renderQrDataUrl(pythonPath, url) {
  const sb = stub()
  if (sb) return sb.renderQrDataUrl(url)
  const code = [
    'import sys, io, base64',
    'import qrcode',
    'buf = io.BytesIO()',
    'qrcode.make(sys.argv[1]).save(buf, format="PNG")',
    'sys.stdout.write(base64.b64encode(buf.getvalue()).decode())',
  ].join('\n')
  try {
    const { execFile } = await import('node:child_process')
    const b64 = await new Promise((resolve, reject) => {
      execFile(
        pythonPath || 'python',
        ['-c', code, url],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 20_000 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout || '').trim())),
      )
    })
    if (!b64) return ''
    return 'data:image/png;base64,' + b64
  } catch {
    return ''
  }
}
