/**
 * dsh-bili-interactor —— 宿主半边
 * ============================================================================
 * 干两件事：
 *   1. 把「逛 B站 并真的产生互动」跑起来（搜索 → 粗筛 → 挑 → 点赞/投币/收藏/弹幕/关注）
 *   2. 给设置页的面板供数据（/api/bili-interactor/*）
 *
 * 设计上的两条硬规矩：
 *   · **动作可回滚**：每一条都先写进 ledger.jsonl 再发，发失败就记 failed —— 账要能对上
 *   · **绝不猜**：视频信息拿不到就不动它；弹幕写不出来就用模板，不发空弹幕
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildState, loadConfig, saveConfig, ensureHome, homeDir, writeJson, readJson,
  appendLedger, bumpDaily, readDaily, flog, readLive, readLedger,
  liveFile, ledgerFile, logFile, dayKey,
} from './state.js'
import { runPy, prefilter, pickTargets, describeAction } from './targets.js'
import { makeDanmaku, makeComment, makeReply, stripMentions, extractLearnings, learnFromExchange, pickReplyTargets, hasApiKey } from './danmaku.js'
import { addLearned, pickLearned, pruneLearned, readLearned, learnedFile } from './learn.js'
import { readSeen, markSeen, markSeenMany, clearSeen } from './seen.js'

export const name = 'bili-interactor'
export const inject = ['webServer']

// 热重载时 apply 会被重新跑，但旧路由不一定先被拆掉 =>
// 「webserver: duplicate prefix route」刷屏，而且撑着的是旧实例的闭包：
// 新代码生成了 key，旧实例拿着旧的 rt 去 poll，永远对不上。
// 所以用模块级变量兜住，注册前先手动拆旧的。
globalThis.__BILI_INTERACTOR_ROUTE__ ||= { dispose: null }
const ROUTE_STATE = globalThis.__BILI_INTERACTOR_ROUTE__

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
// 脚本路径可覆盖：一是方便换实现，二是让集成测试能指向桩 ——
// 不必去动正在被运行中插件使用的真脚本（那样会污染真实凭证）。
const PY_SCRIPT = process.env.BILI_INTERACTOR_SCRIPT || join(PKG_DIR, 'py', 'interact.py')

// 扫码登录走 Node 侧（见 lib/login.mjs）：
// 凭证在 Set-Cookie 头里，不是 data.url 的 query —— 以前在 url 里找，永远拿不到。
import { loginStart, loginPoll, renderQrDataUrl } from './login.mjs'

/* 二维码时间预算（B站 给的有效期是 180 秒，改不了）
 * 用户还要：切到手机 → 打开 B站 App → 扫一扫 → 看清 → 点确认
 * 所以「剩不到 45 秒的码」不该再展示，也不该再复用 —— 递出去就是让人白扫。 */
// 允许用环境变量缩短，方便测试这段时序逻辑（默认就是 B站 真实的 180 秒）
const QR_TTL_MS = Number(process.env.BILI_QR_TTL_MS || 180_000)
// 按比例算，别写死秒数：真实 180 秒时就是「剩不足 45 秒不再展示」，
// 测试把 TTL 缩短时这些阈值会一起缩小，逻辑才是同一套。
const QR_MIN_USABLE_MS = Math.round(QR_TTL_MS * 0.25)   // 剩 25% 以下视为不可用
const QR_REFRESH_AT_MS = Math.round(QR_TTL_MS * 2 / 3)  // 用到 2/3 就提前换新
const qrLeftSec = (ageMs) => Math.max(0, Math.round((QR_TTL_MS - ageMs) / 1000))
const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version } catch { return '' }
})()

/* ─────────────────────── 过程实录（面板读这个） ─────────────────────── */

function appendLive(home, tag, text) {
  try {
    const f = liveFile(home)
    let lines = ''
    try { lines = readFileSync(f, 'utf8') } catch { /* 还没有 */ }
    const arr = lines.split(/\r?\n/).filter((x) => x.trim())
    arr.push(`【${tag}】${text}`)
    while (arr.length > 60) arr.shift()
    writeFileSync(f, arr.join('\n') + '\n', 'utf8')
  } catch { /* 写不进去不影响主流程 */ }
}

function clearLive(home) {
  try { writeFileSync(liveFile(home), '', 'utf8') } catch { /* ignore */ }
}

/* ─────────────────────── Python 解释器 ─────────────────────── */

/**
 * 找 Python 解释器 —— **全自动，不让用户填路径**。
 *
 * 为什么这么做：用户把依赖装在哪个 python 里，插件没法假设。让他手动填路径
 * 等于把插件自己的活丢给用户。所以这里把常见位置全扫一遍，
 * 而且**真的 import 一次 bilibili_api** —— 能 import 的那个才是能用的。
 *
 * 顺序（找到「能 import 的」就停）：
 *   配置里显式指定的（高级用法，不在界面暴露）
 *   → 本插件自己的 venv → 「刷B站」的 venv
 *   → 系统里常见的 Python 安装位置（按版本从新到旧）
 *   → PATH 上的 python3 / python / py
 */
const PY_DEP_PROBE = 'import bilibili_api, httpx, qrcode, PIL'

let pythonCache = { key: '', value: '' }

function pythonCandidates(cfg) {
  const isWin = process.platform === 'win32'
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
  const venvPy = (root) => (isWin ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python3'))

  const list = []
  if (cfg && cfg.pythonPath) list.push(String(cfg.pythonPath))

  // 插件自己/兄弟插件的 venv（DSH_HOME 和真实家目录都看）
  for (const base of [dshHome, join(home, '.dsh')]) {
    for (const name of ['bili-interactor', 'bili-duty']) {
      list.push(venvPy(join(base, name)))
    }
  }

  // 系统里常见的安装位置
  if (isWin) {
    const roots = [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Python') : '',
      process.env.ProgramFiles ? join(process.env.ProgramFiles, '') : '',
      'C:\\',
    ].filter(Boolean)
    for (const root of roots) {
      try {
        const dirs = readdirSync(root)
          .filter((d) => /^Python\d+$/i.test(d))
          .sort()
          .reverse()
        for (const d of dirs) list.push(join(root, d, 'python.exe'))
      } catch { /* 目录不存在就算了 */ }
    }
  } else {
    list.push('/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3')
    for (const r of ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
      try {
        for (const f of readdirSync(r).filter((x) => /^python3(\.\d+)?$/.test(x)).sort().reverse()) {
          list.push(join(r, f))
        }
      } catch { /* ignore */ }
    }
  }

  // PATH 上的命令名（放最后：优先用位置明确的）
  list.push(isWin ? 'python' : 'python3', 'python', 'py')
  return [...new Set(list.filter(Boolean))]
}

function probePython(cmd) {
  // 返回 { runs, hasDeps, version }
  const tryRun = (args) => {
    try {
      const out = execFileSync(cmd, args, { timeout: 15_000, encoding: 'utf8', windowsHide: true })
      return (out || '').trim()
    } catch {
      return ''
    }
  }
  const ver = tryRun(['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'])
  if (!ver) return { runs: false, hasDeps: false, version: '' }
  const dep = tryRun(['-c', PY_DEP_PROBE])
  // import 成功时 print 不出东西，所以用「退出码」判断：再跑一次带输出的
  const depOk = (() => {
    try {
      execFileSync(cmd, ['-c', PY_DEP_PROBE], { timeout: 20_000, windowsHide: true })
      return true
    } catch { return false }
  })()
  return { runs: true, hasDeps: depOk, version: ver }
}

function resolvePython(cfg) {
  const isWin = process.platform === 'win32'
  const key = JSON.stringify([cfg && cfg.pythonPath, process.env.DSH_HOME, process.env.USERPROFILE, process.env.HOME])
  if (pythonCache.key === key && pythonCache.value) return pythonCache.value

  const cands = pythonCandidates(cfg)
  let firstRuns = ''

  for (const c of cands) {
    const r = probePython(c)
    if (!r.runs) continue
    if (!firstRuns) firstRuns = c
    if (r.hasDeps) {
      // 这就是能干活的那个（依赖装在这里）
      pythonCache = { key, value: c }
      return c
    }
  }

  // 一个都没有依赖：返回能跑的那个，让 doctor 报「缺包」并给准确命令
  const fallback = firstRuns || (isWin ? 'python' : 'python3')
  pythonCache = { key, value: fallback }
  return fallback
}

/* ─────────────────────── 一轮 ─────────────────────── */

/**
 * 从学习到的「那句原话」反查它是评论区里哪一条，好让界面能直接跳过去。
 * 模型可能改写过分句，所以先精确匹配，再退化成前缀/包含匹配。
 */
export function guessRpid(text, items) {
  const t = String(text || '').trim()
  if (!t || !Array.isArray(items)) return ''
  const cands = items.filter((c) => c && c.rpid && c.content)
  const exact = cands.find((c) => String(c.content).trim() === t)
  if (exact) return String(exact.rpid)
  const head = t.slice(0, 24)
  const byHead = cands.find((c) => String(c.content).trim().startsWith(head))
  if (byHead) return String(byHead.rpid)
  const cHead = cands.find((c) => {
    const ct = String(c.content).trim()
    return ct.length >= 10 && (ct.includes(t.slice(0, 12)) || t.includes(ct.slice(0, 12)))
  })
  return cHead ? String(cHead.rpid) : ''
}

export function apply(ctx, config = {}) {
  const home = ensureHome(homeDir(config))
  /** 运行态（面板要用） */
  // 启动/热重载时把上次没扫完的 key 读回来（否则重启后那张码就成了孤儿）
  try {
    const saved = readJson(join(home, 'login.json'), {})
    if (saved && saved.qrcodeKey) {
      const age = Date.now() - Number(saved.at || 0)
      if (age < QR_TTL_MS - QR_MIN_USABLE_MS) {
        globalThis.__BILI_INTERACTOR_RT__ = globalThis.__BILI_INTERACTOR_RT__ || {}
        globalThis.__BILI_INTERACTOR_RT__.loginKey = saved.qrcodeKey
      } else {
        try { unlinkSync(join(home, 'login.json')) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  const rt = (globalThis.__BILI_INTERACTOR_RT__ ||= {
    running: false,
    phase: '',
    startedAt: 0,
    finishedAt: 0,
    error: '',
    progress: { index: 0, total: 0, currentBvid: '', currentTitle: '' },
    lastResult: null,
    stopRequested: false,
    loginBusy: false,
    loginAt: 0,
    loginKey: '',
    loginState: '',
    loginName: '',
    loginPolls: 0,
    loginGen: 0,
    loginScanned: false,
    loginExpiredAfterScan: false,
  })

  const log = (m) => flog(home, m)

  /* ───────── 「有人回我 → 我回他」的状态 ─────────
   * replied.json 记已经回过的子评论 rpid，避免同一个回复被反复回。
   * 存盘而不是只放内存：DSH 一重启就忘 = 会把同一句回好几遍。
   */
  const repliedFile = () => join(home, 'replied.json')
  const loadReplied = () => {
    const o = readJson(repliedFile(), {})
    const set = new Set(Array.isArray(o?.rpids) ? o.rpids : [])
    return set
  }
  const saveReplied = (set) => {
    try {
      // 只留最近 2000 条，别无限涨
      const arr = [...set].slice(-2000)
      const okWrite = writeJson(repliedFile(), { rpids: arr, at: Date.now() })
      if (!okWrite) log('⚠️ replied.json 写不进去 —— 重启后可能重复回同一句')
      return okWrite
    } catch (e) {
      log('⚠️ 保存已回复记录失败: ' + String(e?.message ?? e))
      return false
    }
  }

  /* ───────── 登录后台轮询器 ─────────
   * ⚠️ 关键设计：登录完成靠的是「有人一直在 poll」。
   *    以前只有前端在轮询 —— 用户扫完码切走了 / 关掉设置页 / 刷新了，
   *    就再也没人 poll，credential.json 永远写不进去，
   *    于是「再进设置还是让你扫码」。这是设计缺陷，不是配置问题。
   *    现在宿主自己起一个定时器，生成码后每 2 秒查一次，最多 3 分钟。
   */
  // timer 挂到 globalThis：apply 会被热重载反复执行，局部变量会留下一堆定时器
  const WATCH = (globalThis.__BILI_INTERACTOR_WATCH__ ||= { timer: null })
  const getTimer = () => WATCH.timer
  const setTimer = (v) => { WATCH.timer = v }

  function stopLoginWatcher() {
    const t = getTimer()
    if (t) { try { clearInterval(t) } catch { /* ignore */ } ; setTimer(null) }
  }

  /** 生成一张新码并落盘（被 /login/qr 和过期自动续期共用） */
  async function refreshQr() {
    const cfgQr = loadConfig(home)
    const start = await loginStart()
    const image = await renderQrDataUrl(resolvePython(cfgQr), start.url)
    rt.loginKey = String(start.key || '')
    rt.loginAt = Date.now()
    rt.loginGen = (rt.loginGen || 0) + 1
    rt.loginState = 'scan'
    rt.loginPolls = 0
    rt.loginScanned = false
    rt.loginSeenAt = Date.now()   // 刚生成，视为「有人正在看」
    // ⚠️ key 和图片必须写在**同一个文件**里，一次写完。
    //    以前分两个文件写，中间任何一次读都可能拿到「新 key + 旧图」，
    //    用户扫的就是一张和 key 对不上的码 —— 这类不同步极难查。
    try {
      const b64 = String(image || '').replace(/^data:image\/png;base64,/, '')
      writeJson(join(home, 'login.json'), {
        qrcodeKey: rt.loginKey,
        at: rt.loginAt,
        gen: rt.loginGen,
        image: b64,
      })
      // 顺手留一份给人看（调试用，不再是数据源）
      if (b64) writeFileSync(join(home, 'qr.png'), Buffer.from(b64, 'base64'))
    } catch { /* ignore */ }
    startLoginWatcher()
    return { ok: true, image: image || '', qrcodeKey: rt.loginKey, gen: rt.loginGen }
  }

  /** 最近一次有人看登录页的时刻 —— 没人看就别一直换码，那是白烧请求 */
  const lastSeen = () => Number(rt.loginSeenAt || 0)

  async function pollOnce() {
    if (!rt.loginKey) { stopLoginWatcher(); return }
    rt.loginPolls = (rt.loginPolls || 0) + 1
    const keyAtStart = rt.loginKey
    let r
    try {
      // ⭐ 凭证在 Set-Cookie 里，这条走 node（lib/login.mjs），不再交给 python
      r = await loginPoll(keyAtStart)
      // 归一成内部用语：waiting/scanned/ok/expired/unknown
      if (r.state === 'waiting') r = { ok: true, done: false, state: 'scan', hint: '还没扫' }
      else if (r.state === 'scanned') r = { ok: true, done: false, state: 'conf', hint: '扫到了，等确认' }
      else if (r.state === 'expired') r = { ok: true, done: false, state: 'timeout', hint: '过期' }
      else if (r.state === 'ok') r = { ok: true, done: true, state: 'done', credential: r.credential }
      else r = { ok: false, error: r.message || ('未知状态 ' + r.code) }
    } catch (e) {
      r = { ok: false, error: String(e?.message ?? e) }
    }
    // 这次请求在飞行期间，用户可能已经退出登录 / 换了新码
    // => 结果作废，别再往状态里写（否则退出后界面又变回 scan）
    if (rt.loginKey !== keyAtStart) return
    if (r?.done && r.credential) {
      try {
        ensureHome(home)
        writeJson(join(home, 'credential.json'), r.credential)
      } catch (e) {
        log('写凭证失败: ' + String(e?.message ?? e))
        return
      }
      // ⭐ 顺带把共享凭证补一份：~/​.dsh/bili-duty/bili_credential.json
      //    「刷B站」(dsh-bili-scroll) 读的是那个文件。它原来那份被我早前误删了，
      //    这里补上它就能继续用；**只写不删**，退出登录仍然只删自己这份。
      try {
        // 测试可以用 BILI_INTERACTOR_SHARED_DIR 指到临时目录，
        // 否则测试里的桩凭证会覆盖真实那份（踩过一次）
        const shared = process.env.BILI_INTERACTOR_SHARED_DIR
          ? String(process.env.BILI_INTERACTOR_SHARED_DIR)
          : (process.env.DSH_HOME
              ? join(process.env.DSH_HOME, 'bili-duty')
              : join(process.env.USERPROFILE || '', '.dsh', 'bili-duty'))
        const sharedFile = join(shared, 'bili_credential.json')
        mkdirSync(shared, { recursive: true })
        writeJson(sharedFile, {
          sessdata: r.credential.sessdata ?? '',
          bili_jct: r.credential.bili_jct ?? '',
          buvid3: r.credential.buvid3 || '',
          dedeuserid: r.credential.dedeuserid ?? '',
        })
        log('共享凭证已同步（刷B站 也能用了）：' + sharedFile)
      } catch (e) {
        log('共享凭证没同步上（不影响本插件）：' + String(e?.message ?? e))
      }

      try { unlinkSync(join(home, 'qr.png')) } catch { /* ignore */ }
      try { unlinkSync(join(home, 'login.json')) } catch { /* ignore */ }
      rt.loginKey = ''
      rt.loginAt = 0
      rt.loginState = 'done'
      rt.loginName = r.name || ''
      appendLive(home, '阶段', `登录成功：${r.name || r.uid || ''}`)
      log(`login ok uid=${r.uid} name=${r.name}（后台轮询）`)
      stopLoginWatcher()
      return
    }
    if (r?.state === 'timeout') {
      // ⚠️ 这个是这次登录失败的直接原因，必须说清楚：
      //    用户已经扫过、但还没来得及点确认，码就过期了。
      //    手机上再点确认也不会生效 —— 必须让他重新扫。
      const wasScanned = rt.loginScanned === true
      log(wasScanned ? '你已扫描的二维码过期了，换新码' : '二维码过期，自动换一张')
      rt.loginExpiredAfterScan = wasScanned
      rt.loginScanned = false
      rt.loginState = 'refreshed'
      stopLoginWatcher()
      try { await refreshQr() } catch (e) { log('自动换码失败: ' + String(e?.message ?? e)) }
      // refreshQr 会把 loginState 置回 scan；这里把「刚才扫的那张废了」标记保留住
      rt.loginExpiredAfterScan = wasScanned
      return
    }
    if (r?.state === 'conf') {
      rt.loginState = 'conf'
      rt.loginScanned = true      // 记住：这张码用户已经扫过了
      return
    }
    if (r?.state === 'scan') {
      // 只有从没扫过时才回退成 scan，别把「已扫待确认」冲掉
      if (rt.loginState !== 'conf') rt.loginState = 'scan'
      // 主动续期：还没人扫、且剩不到 50 秒，就提前换一张。
      // 否则会出现「递给你一张只剩十几秒的码，扫完就走到了过期」。
      const age = Date.now() - Number(rt.loginAt || 0)
      if (age > QR_REFRESH_AT_MS) {
        log('这张码剩不到 50 秒且还没人扫，提前换一张')
        rt.loginState = 'refreshed'
        stopLoginWatcher()
        try { await refreshQr() } catch (e) { log('提前换码失败: ' + String(e?.message ?? e)) }
      }
    }
  }

  function startLoginWatcher() {
    stopLoginWatcher()
    const startedAt = Date.now()
    const timer = setInterval(() => {
      // 三个退出条件：
      //   1) 跑太久（10 分钟）
      //   2) 已经登录了
      //   3) 超过 40 秒没人打开过登录页 —— 用户都走了还每 2 秒打 B站，纯浪费
      if (Date.now() - startedAt > 600_000) { stopLoginWatcher(); return }
      // 只认自己那份：hasCred() 还会看 ~/.dsh/bili-duty 的共享凭证，
      // 那份是「刷B站」的。它存在不代表这次扫码完成了。
      if (hasOwnCred()) { stopLoginWatcher(); return }
      if (lastSeen() && Date.now() - lastSeen() > 200_000) {
        log('200 秒无人查看，停掉登录轮询')
        stopLoginWatcher()
        return
      }
      pollOnce().catch(() => { /* 下一轮再试 */ })
    }, 2000)
    setTimer(timer)
    // 不阻止进程退出
    try { if (timer && typeof timer.unref === 'function') timer.unref() } catch { /* ignore */ }
  }

  ctx.effect(() => () => { stopLoginWatcher() }, 'bili-interactor: 收登录轮询')

  /* ───────── 后台：别人回了我，我去回他 ─────────
   * 光会发评论没用 —— 发完别人回你，你一声不吭，那就不是"在评论区混"。
   * 这里每次跑：
   *   1. 从 ledger 里挑出最近仍在有效期内的、我自己发的评论/回复（带 rpid）
   *   2. 拉它所在的那条楼中楼，找别人回我、我还没回过的
   *   3. 用同一个人设回过去（root=我的评论，parent=对方那条）
   * 次数上限由 replyBackMax 控制，0 = 不限。
   */
  const BACK = (globalThis.__BILI_INTERACTOR_BACK__ ||= { timer: null, running: false })

  async function replyBackOnce(trigger = 'timer', opts = {}) {
    const dry = opts.dry === true
    if (BACK.running) return { started: false, busy: true }
    if (!loadConfig(home).enabled) return { started: false, error: '插件是关着的' }
    const cfg = loadConfig(home)
    if (!cfg.doReplyBack) return { started: false, error: '「有人回我就回他」没开' }
    if (!hasCred()) return { started: false, error: '还没登录' }
    // 手动「跑一轮」正在跑时先让开：两边同时写会互相清 stopRequested，
    // 也会在同一时间密集发评论，更容易撞 B站 的频率上限（12014）
    if (rt.running) return { started: false, error: '正在跑一轮，监听这轮跳过' }

    BACK.running = true
    rt.stopRequested = false   // 上一轮留下的停止标记不能带到这里，否则一个都不检查
    rt.backRunning = true
    rt.backLastAt = new Date().toISOString()
    const pc = pyCtx(cfg)
    const led = readLedger(home, 400)
    const lookbackMs = Math.max(1, Number(cfg.listenLookbackHours) || 72) * 3600_000
    const since = Date.now() - lookbackMs
    const cap = Math.max(0, Number(cfg.replyBackMax) || 0)   // 每条楼最多回几句，0 = 不限
    // 每日总量上限（0 = 不限）。以前只有「每条楼」的限制，一天能回多少没边，
    // 很容易被 B站 的评论频率上限（12014）挡住。
    const dayCap = Math.max(0, Number(cfg.replyBackPerDay) || 0)
    const doneToday = Number((readDaily(home).byType || {}).replyback || 0)
    if (dayCap > 0 && doneToday >= dayCap) {
      log(`replyBack 今日已回 ${doneToday}/${dayCap}，跳过`)
      return { started: false, error: `今天已经回了 ${doneToday} 条，到上限了（${dayCap}）` }
    }
    // 这一轮最多还能回几条
    const remainToday = dayCap > 0 ? Math.max(0, dayCap - doneToday) : Number.MAX_SAFE_INTEGER
    const replied = loadReplied()
    // 我的昵称：用来识别「这条是不是在 @ 我」
    let myName = String(cfg.myName || '').trim()
    if (!myName) {
      try {
        const me = await runPy(pc, ['whoami'], { timeout: 30_000 })
        if (me?.ok && me.name) {
          myName = String(me.name)
          saveConfig(home, { myName })
        }
      } catch { /* 拿不到就只靠 parent 判断 */ }
    }
    const learned = cfg.doLearn ? pickLearned(home, Number.isFinite(Number(cfg.learnUseCount)) ? Number(cfg.learnUseCount) : 8) : []

    // 我自己发过、还可能有新回复的楼
    const roots = new Map()
    for (const row of led) {
      if (!row || row.ok !== true) continue
      if (row.kind !== 'comment' && row.kind !== 'reply') continue
      if (!row.bvid || !row.rpid) continue
      const when = Date.parse(row.at || row.ts || '') || 0
      if (when && when < since) continue
      const root = String(row.root || row.rpid)
      const key = row.bvid + '#' + root
      if (!roots.has(key)) {
        roots.set(key, { bvid: row.bvid, root, myRpid: String(row.rpid), at: when, title: row.title || '' })
      }
    }

    let checked = 0
    let sent = 0
    let skipped = 0
    const details = []

    // ⚠️ 间隔调到 1 分钟之后，一次全查 40 多个楼 = 每分钟 40+ 次请求，
    //    Lv2 小号这么打很容易被风控。所以改成「轮流查」：
    //    每次只查一部分（按最近发过的优先），下一轮接着往后轮。
    const allRoots = [...roots.values()].sort((a, b) => (b.at || 0) - (a.at || 0))
    const perTick = Math.max(1, Number(cfg.listenMaxThreadsPerTick) || 15)
    const cursor = Number(rt.backCursor || 0) % Math.max(1, allRoots.length)
    const slice = allRoots.length <= perTick
      ? allRoots
      : [...allRoots.slice(cursor), ...allRoots.slice(0, cursor)].slice(0, perTick)
    rt.backCursor = (cursor + perTick) % Math.max(1, allRoots.length)
    rt.backCursorInfo = { cursor: rt.backCursor, total: allRoots.length, perTick }

    for (const t of slice) {
      if (rt.stopRequested) break
      checked++
      let subs = null
      try {
        subs = await runPy(pc, ['sub-replies', '--bvid', t.bvid, '--rpid', t.root], { timeout: 60_000 })
      } catch { continue }
      if (!subs?.ok) { details.push({ bvid: t.bvid, root: t.root, error: subs?.error || '拉不到子评论' }); continue }

      const items = subs.items || []
      // 我在这楼里的 rpid 集合：被谁 parent 指向，就说明他在回我
      const myRpids = new Set(items.filter((x) => x.is_mine).map((x) => String(x.rpid || '')))
      myRpids.add(String(t.myRpid || ''))
      // 我最后说话的时间：只回在那之后出现的新回复
      const mineTimes = items.filter((x) => x.is_mine).map((x) => Number(x.ctime || 0))
      const myLastAt = mineTimes.length ? Math.max(...mineTimes) : 0
      let already = items.filter((x) => x.is_mine).length                   // 楼里我占了几层

      const directedAtMe = (x) => {
        if (myRpids.has(String(x.parent || ''))) return true
        if (myName && String(x.content || '').includes('@' + myName)) return true
        return false
      }

      const cands = items.filter((x) => {
        if (x.is_mine) return false
        if (!x.rpid || replied.has(String(x.rpid))) return false
        if (String(x.content || '').trim().length < (Number(cfg.replyBackMinLen) || 2)) return false
        // ⭐ 只回真的回我的；别人互相聊的，不插嘴
        if (!directedAtMe(x)) return false
        // 只回我最后一次发言之后的新回复，别翻旧账
        if (myLastAt && Number(x.ctime || 0) && Number(x.ctime) < myLastAt) return false
        return true
      })
      if (!cands.length) continue

      for (const c of cands) {
        if (rt.stopRequested) break
        if (cap > 0 && already >= cap) { skipped++; continue }   // 这条楼下我已经回到上限了
        if (sent >= remainToday) {                                 // 今天的总量到顶了
          appendLive(home, '阶段', `今天回满了 ${dayCap} 条，剩下的明天再回`)
          rt.stopRequested = true
          break
        }

        let rep = ''
        try {
          const g = await makeReply({ title: t.title, up: '' }, { uname: c.uname, content: c.content }, cfg, { learned })
          rep = stripMentions(g.text, cfg.mentionName || '')
        } catch { continue }
        if (!rep) continue

        let r = null
        if (dry) {
          r = { ok: true, rpid: null, dry: true }
        } else {
          try {
            r = await runPy(pc, ['comment', '--bvid', t.bvid, '--text', rep, '--root', t.root, '--parent', String(c.rpid)], { timeout: 60_000 })
          } catch (e) {
            r = { ok: false, error: String(e?.message ?? e) }
          }
        }

        if (r?.ok && dry) {
          sent++
          already++
          details.push({ bvid: t.bvid, to: c.uname, their: String(c.content).slice(0, 60), draft: rep, dry: true })
          appendLive(home, '思考', `[预览] 会回 ${c.uname}：「${rep.slice(0, 40)}」`)
          continue
        }
        if (r?.ok) {
          sent++
          already++
          replied.add(String(c.rpid))
          // 立刻落盘：以前整轮结束才写，中途进程没了这次记录就丢，
          // 下一轮会把同一个人再回一遍 —— 用户看到的就是「同一条下面回了三次」。
          saveReplied(replied)
          appendLive(home, '动作', `回了 ${c.uname}：「${rep.slice(0, 30)}」（${t.bvid}）`)
          appendLedger(home, {
            kind: 'replyback', ok: true, bvid: t.bvid, title: t.title,
            text: rep, rpid: r.rpid, toUid: c.uid, toName: c.uname, root: t.root, parent: c.rpid,
          })
          bumpDaily(home, 'replyback', 0, { countAction: false })   // 不占「跑一轮」的额度
          // 对方这句话要是值得，也学一手
          if (cfg.doLearn) {
            try {
              const g = await learnFromExchange(c.content, rep, cfg)
              if (g) {
                const minScore = Number.isFinite(Number(cfg.learnMinScore)) ? Number(cfg.learnMinScore) : 6
                if (Number(g.score) >= minScore) {
                  addLearned(home, { ...g, from: c.uname, bvid: t.bvid, rpid: c.rpid, root: t.root })
                }
              }
            } catch { /* 学习失败不影响回复 */ }
          }
        } else {
          const code = r?.code
          appendLive(home, '失败', `回 ${c.uname} 没成：${r?.error || code || '没给原因'}`)
          if ([-412, -352, -351, -101, 12014, 12015].includes(code)) {
            rt.stopRequested = true
            appendLive(home, '阶段', `B站 挡住回复了（${code}）：监听这轮先停`)
            break
          }
        }
        await new Promise((res) => setTimeout(res, 2500 + Math.random() * 3000))
      }
    }

    saveReplied(replied)
    rt.backLast = { at: new Date().toISOString(), trigger, checked, sent, skipped, threads: roots.size }
    BACK.running = false
    rt.backRunning = false
    rt.stopRequested = false
    log(`replyBack trigger=${trigger} threads=${roots.size} checked=${checked} sent=${sent} skipped=${skipped}`)
    if (sent) appendLive(home, '阶段', `回复监听：回了 ${sent} 条`)
    pruneLearned(home, 400)
    return { ok: true, ...rt.backLast, details }
  }

  function startReplyBack() {
    if (BACK.timer) return
    const cfg = loadConfig(home)
    const mins = Math.max(1, Number(cfg.listenIntervalMin) || 20)
    if (Number(cfg.listenIntervalMin) > 0 && !cfg.doReplyBack) return
    const timer = setInterval(() => {
      replyBackOnce('timer').catch((e) => log('replyBack 崩了: ' + String(e?.message ?? e)))
    }, mins * 60_000)
    BACK.timer = timer
    try { if (typeof timer.unref === 'function') timer.unref() } catch { /* ignore */ }
    log(`replyBack 监听已启动，每 ${mins} 分钟一次`)
  }

  function stopReplyBack() {
    if (BACK.timer) { try { clearInterval(BACK.timer) } catch { /* ignore */ } ; BACK.timer = null }
  }

  ctx.effect(() => () => { stopReplyBack() }, 'bili-interactor: 收回复监听')

  // 加载时自动自检一次：新用户打开面板就能看到缺什么，不用点按钮
  // （延迟 5 秒，别和插件启动抢资源）
  setTimeout(() => {
    runDoctor()
      .then((d) => {
        rt.doctor = d
        if (!d.ready) log(`自检未通过：${d.items.filter((x) => !x.ok).map((x) => x.name).join('、')}`)
      })
      .catch((e) => log('自检失败：' + String(e?.message ?? e)))
  }, 5_000).unref?.()

  // 启动时如果开关是开的就挂上（延迟 90 秒，别跟启动抢资源）
  setTimeout(() => {
    try {
      if (loadConfig(home).doReplyBack && hasCred()) startReplyBack()
    } catch { /* ignore */ }
  }, 90_000).unref?.()

  ctx.effect(() => () => { rt.stopRequested = true }, 'bili-interactor: 收摊')

  /* 每轮真正干的活 */
  /**
   * 跑一轮之前的全部检查（同步，不碰网络）。
   * /run 和 runOnce 共用，避免出现「接口说跑起来了，runOnce 立刻退出」。
   */
  function runPreflight() {
    if (rt.running) {
      return { ok: false, busy: true, error: '上一轮还没跑完' }
    }
    // 回复监听在跑时不能同时写 B站：会互相干扰、也更容易撞频率上限。
    // 以前这里没检查，用户点了「现在跑一轮」接口回 started:true，
    // 而 runOnce 立刻退出 —— 表现就是「点了没反应，按钮还能再点」。
    if (BACK.running) {
      return { ok: false, busy: true, listenBusy: true, error: '回复监听正在跑（它每分钟一轮），等它这轮结束再点，大概十几秒' }
    }
    const cfg = loadConfig(home)
    if (!cfg.enabled) return { ok: false, error: '插件是关着的（设置里打开「启用」）' }
    if (!hasCred()) return { ok: false, needLogin: true, error: '还没登录 B站 —— 先在下面扫码登录' }
    if (Number(cfg.maxActionsPerRun || 0) <= 0) {
      return { ok: false, error: '「一轮最多动几次」是 0，这样一轮什么都不会做，先去设置里改大' }
    }
    const d = readDaily(home)
    const dayCap = Number(cfg.maxActionsPerDay || 0)
    if (dayCap > 0 && d.actions >= dayCap) {
      return { ok: false, error: `今天已经动了 ${d.actions} 次，到上限了（${dayCap}）—— 想继续就去设置里调高` }
    }
    const left = dayCap <= 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, dayCap - d.actions)
    return { ok: true, quotaLeft: left }
  }

  async function runOnce(trigger = 'manual') {
    const pre = runPreflight()
    if (!pre.ok) return { started: false, ...pre }
    const quota = pre.quotaLeft
    const cfg = loadConfig(home)
    const daily = readDaily(home)

    rt.running = true
    rt.stopRequested = false
    rt.phase = '准备'
    rt.startedAt = Date.now()
    rt.finishedAt = 0
    rt.error = ''
    rt.progress = { index: 0, total: 0, currentBvid: '', currentTitle: '' }

    clearLive(home)
    // 这一轮参考的「学习记忆」：攒下来的看法/说法，写评论时带上
    let learned = []
    try {
      learned = cfg.doLearn ? pickLearned(home, Number.isFinite(Number(cfg.learnUseCount)) ? Number(cfg.learnUseCount) : 8) : []
      if (learned.length) appendLive(home, '思考', `翻了下笔记，有 ${learned.length} 条可以参考`)
    } catch { /* 读不到就当没有 */ }
    appendLive(home, '阶段', `开跑（${trigger === 'manual' ? '手动' : '定时'}）：${describeAction(cfg)}`)
    log(`run start trigger=${trigger} quota=${quota}`)

    const pc = pyCtx(cfg)

    const summary = { done: 0, failed: 0, skipped: 0, videos: [] }

    try {
      /* 1. 确认登录 */
      rt.phase = '确认账号'
      appendLive(home, '阶段', '确认登录状态')
      let me
      try {
        me = await runPy(pc, ['whoami'], { timeout: 30_000 })
      } catch (e) {
        throw new Error('调不通 Python：' + String(e?.message ?? e))
      }
      if (!me?.ok) {
        throw new Error('登录状态有问题：' + (me?.error || 'whoami 失败') + '（先用「刷B站」插件扫码登录）')
      }
      appendLive(home, '思考', `当前账号：${me.name}（Lv${me.level}，硬币 ${me.coins}）`)

      /* 2. 搜 + 粗筛 */
      rt.phase = '找视频'
      // 每个关键词取够 42 条（B站 搜索一页上限）；服务端既然已按天筛过，
      // 这 42 条就是「N 天内按播放最高的 42 条」，拿来挑足够。
      const searchLimit = 42
      const pool = []
      const seen = new Set()
      // 统计：这轮一共搜到多少、各条件筛掉多少、有多少是刷过的
      let totalSearched = 0
      let dupStat = 0
      const rejStat = {}
      // 以前刷过的 BV（开着开关才用）
      const seenBefore = cfg.skipSeenVideos
        ? (() => { try { return readSeen(home) } catch { return new Map() } })()
        : new Map()
      if (cfg.skipSeenVideos && seenBefore.size) {
        appendLive(home, '思考', `已记录 ${seenBefore.size} 条刷过的视频，这轮会跳过它们`)
      }
      for (const kw of cfg.keywords) {
        if (rt.stopRequested) break
        appendLive(home, '阶段', `搜「${kw}」${cfg.order === 'click' ? '按播放' : cfg.order === 'pubdate' ? '按最新' : '按综合'}`)
        let res
        try {
          // 把 daysBack 交给服务端筛（time_start/time_end），不是本地过滤。
          // 以前只在本地下载 42 条再按 pubdate 砍，而按播放排序返回的全是老爆款，
          // 砍完必然剩 0 —— 这就是「这轮空手」的真因之一。
          const searchArgs = ['search', '--keyword', kw, '--order', cfg.order, '--limit', String(searchLimit)]
          if (Number(cfg.daysBack) > 0) searchArgs.push('--days', String(Number(cfg.daysBack)))
          res = await runPy(pc, searchArgs, { timeout: 60_000 })
        } catch (e) {
          appendLive(home, '失败', `搜「${kw}」失败：${String(e?.message ?? e).slice(0, 80)}`)
          continue
        }
        if (!res?.ok) {
          appendLive(home, '失败', `搜「${kw}」没结果：${res?.error || ''}`)
          continue
        }
        const pf = prefilter(res.items, cfg)
        const kept = pf.kept
        // 累计各条件的拒绝数，空手时能说清到底卡在哪
        for (const k of Object.keys(pf.rejected)) rejStat[k] = (rejStat[k] || 0) + pf.rejected[k]
        totalSearched += Number(res.count) || kept.length

        // 跳过刷过的：收藏过的视频不再反复刷（用户可以关掉这个开关）
        let fresh = kept
        if (cfg.skipSeenVideos && seenBefore.size) {
          const before = kept.length
          fresh = kept.filter((v) => !seenBefore.has(String(v.bvid || '')))
          const dup = before - fresh.length
          dupStat += dup
          if (dup > 0) {
            appendLive(home, '跳过', `「${kw}」里 ${dup} 条以前刷过，跳过`)
          }
        }
        const why = []
        if (pf.rejected.old) why.push(`${pf.rejected.old} 条太老`)
        if (pf.rejected.play) why.push(`${pf.rejected.play} 条播放不足`)
        if (pf.rejected.skip) why.push(`${pf.rejected.skip} 条命中跳过词`)
        appendLive(home, '思考',
          `「${kw}」拿到 ${res.count} 条，粗筛后剩 ${fresh.length} 条` +
          (why.length ? `（筛掉：${why.join('、')}）` : ''))
        for (const v of fresh) {
          if (seen.has(v.bvid)) continue
          seen.add(v.bvid)
          pool.push({ ...v, __kw: kw })
        }
      }

      if (pool.length === 0) {
        // 分级说清空在哪一步，别一句「都不合适」糊过去
        const parts = []
        if (rejStat.old) parts.push(`${rejStat.old} 条超出 ${cfg.daysBack} 天`)
        if (rejStat.play) parts.push(`${rejStat.play} 条播放量低于 ${cfg.minPlay}`)
        if (rejStat.skip) parts.push(`${rejStat.skip} 条命中跳过词`)
        if (dupStat) parts.push(`${dupStat} 条以前刷过`)

        let why = ''
        if (dupStat > 0 && parts.length === 1) {
          // 只剩「刷过」这一个原因：说明是圈子刷空了，不是设置错了
          why = `搜了 ${totalSearched} 条，符合条件的新视频已经刷完了（这轮剩下 ${dupStat} 条都刷过）`
            + ` —— 要么把「只看最近几天」放宽，要么加新关键词，要么清掉已刷记录`
        } else if (parts.length) {
          why = `搜了 ${totalSearched} 条，全被筛掉：${parts.join('、')}`
            + (rejStat.old ? `
「只看最近 ${cfg.daysBack} 天」是最容易卡人的一项，可以调大或填 0（不限）` : '')
        } else {
          why = `搜了 ${totalSearched} 条，但没有可用的（可能搜索接口没返回详情）`
        }

        appendLive(home, '小结', '这轮空手 —— ' + why)
        rt.phase = ''
        return { started: true, done: 0, message: why }
      }

      /* 3. 挑 */
      rt.phase = '挑目标'
      const targets = pickTargets(pool, cfg, quota)
      appendLive(home, '思考', `候选池 ${pool.length} 条，这轮挑 ${targets.length} 条（今日还剩 ${quota} 次额度）`)
      rt.progress.total = targets.length
      // 挑中就算「刷过」：哪怕这条最后失败，也别下一轮又撞上同一条
      if (cfg.skipSeenVideos && targets.length) {
        markSeenMany(home, targets.map((v) => v.bvid))
      }

      /* 4. 逐条动 */
      // ⚠️ maxActionsPerRun 原来是「最多碰几条视频」，但每条视频下还能发
      //    1 条评论 + N 条回复，于是「20 次」的一轮能发出几百次写操作。
      //    现在它真的是**动作总数上限**（点赞/投币/弹幕/评论/回复都算）。
      const runCap = Number(cfg.maxActionsPerRun || 0) > 0 ? Number(cfg.maxActionsPerRun) : Infinity
      // ⚠️ 日均上限必须在这里也挡一次。
      //    以前只在 runOnce 开头算过一次 quota，算的是「还能挑几条视频」，
      //    而每条视频下面还有点赞/投币/弹幕/评论/N 条回复 —— 于是
      //    115/120 开一轮能直接冲到 153（用户实测）。
      const dayStartUsed = Number(daily.actions || 0)
      const dayCapRun = Number(cfg.maxActionsPerDay || 0)
      const overCap = () => {
        if (summary.done >= runCap) return true
        if (dayCapRun > 0 && dayStartUsed + summary.done >= dayCapRun) return true
        return false
      }
      for (let i = 0; i < targets.length; i++) {
        if (rt.stopRequested) {
          appendLive(home, '小结', `收到停止，做到第 ${i} 条为止`)
          break
        }
        if (overCap()) {
          const hitDaily = dayCapRun > 0 && dayStartUsed + summary.done >= dayCapRun
          appendLive(home, '小结', hitDaily
            ? `今天已经动了 ${dayStartUsed + summary.done} 次，到「每日上限」了（${dayCapRun}）—— 想继续就去设置里调高`
            : `这一轮已经动了 ${summary.done} 次，到「一轮上限」了，剩下的下次再说`)
          break
        }
        const v = targets[i]
        rt.phase = '互动中'
        rt.progress.index = i + 1
        rt.progress.currentBvid = v.bvid
        rt.progress.currentTitle = v.title || ''

        appendLive(home, '候选', `${v.bvid} · ${v.title || '(无标题)'} · ${v.up || '?'} · 播放 ${v.play}`)

        // ── 真的看一遍（会产生观看记录，不是空跑）──
        if (cfg.doWatch) {
          try {
            const w = await runPy(pc, ['watch', '--bvid', v.bvid, '--style', String(cfg.watchStyle || 'fast')], { timeout: 180_000 })
            if (w && w.ok) {
              appendLive(home, '动作', `看了 ${v.bvid}：上报 ${w.reports} 次${w.failed ? '（失败 ' + w.failed + '）' : ''} · ${w.style === 'real' ? '真实节奏' : '快速'}`)
            } else {
              appendLive(home, '失败', `观看上报没成功：${w?.error || '未知原因'}`)
            }
          } catch (e) {
            appendLive(home, '失败', '观看上报异常：' + String(e?.message ?? e).slice(0, 60))
          }
        }

        // ── 摘视频内容（字幕 / 弹幕 / 简介）──
        // ⚠️ 之前没有这一步，所以写出来的评论只能吐槽标题。
        let digest = null
        if (cfg.doDigest) {
          try {
            digest = await runPy(pc, ['digest', '--bvid', v.bvid, '--max-danmaku', '40'], { timeout: 90_000 })
            if (digest && digest.ok) {
              // 没字幕时，可选地走本地转写（复用「刷B站」已装好的 ASR 环境）
              if (!digest.hasSubtitle && cfg.doTranscribe) {
                try {
                  appendLive(home, '思考', '没字幕，本地转写中（慢，可能要一两分钟）…')
                  const tr = await runPy(pc, [
                    'transcribe', '--bvid', v.bvid,
                    '--max-chars', String(Math.max(500, Number(cfg.transcribeMaxChars) || 3000)),
                  ], { timeout: 480_000 })
                  if (tr && tr.ok && tr.text) {
                    digest.subtitle = tr.text
                    digest.hasSubtitle = true
                    digest.source = 'asr'
                    appendLive(home, '思考', `转写好了：${tr.chars} 字`)
                  } else if (tr && tr.ok && tr.empty) {
                    appendLive(home, '跳过', `这条没有语音（${tr.hint || '转写为空'}），按弹幕判断`)
                  } else {
                    appendLive(home, '失败', `转写没成功：${tr?.error || '未知原因'}`)
                  }
                } catch (e) {
                  appendLive(home, '失败', '转写异常：' + String(e?.message ?? e).slice(0, 60))
                }
              }
              const how = digest.source === 'subtitle'
                ? `字幕 ${String(digest.subtitle || '').length} 字`
                : (digest.source === 'asr'
                  ? `转写 ${String(digest.subtitle || '').length} 字`
                  : (digest.source === 'danmaku' ? `弹幕 ${digest.danmakuTotal} 条` : '只有标题'))
              appendLive(home, '思考', `看了下内容：${how}`)
            } else {
              digest = null
            }
          } catch {
            digest = null
          }
        }

        // 弹幕文案（要就先生成）
        let danmakuText = null
        if (cfg.doDanmaku) {
          try {
            const d = await makeDanmaku(v, cfg, { digest })
            danmakuText = d.text
            appendLive(home, '思考', `弹幕写好了（${d.source === 'llm' ? '模型' : '模板'}）：${d.text}`)
          } catch {
            danmakuText = null
          }
        }

        // @ 谁：UID 反查昵称，反查结果缓回配置（下次不用再查）
        let mentionName = String(cfg.mentionName || '').trim()
        if (Number(cfg.mentionUid) > 0) {
          const cached = String(cfg.__mentionCache || '').trim()
          if (cached) {
            mentionName = cached
          } else {
            try {
              const u = await runPy(pc, ['uidname', '--uid', String(cfg.mentionUid)], { timeout: 30_000 })
              if (u?.ok && u.name) {
                mentionName = u.name
                appendLive(home, '思考', `@ 对象 UID ${cfg.mentionUid} = 「${u.name}」`)
                // 缓存进配置，别每次跑都查一遍
                saveConfig(home, { mentionName: u.name })
              }
            } catch { /* 查不到就退化成不 @ */ }
          }
        }

        // 评论文案（重点功能：评论区留话）
        let commentText = null
        if (cfg.doComment) {
          try {
            const c = await makeComment(v, cfg, { mentionName, learned, digest })
            if (c.text) {
              // @ 由宿主统一拼在最前面，模型只写正文。
              // 再剥一次 @ 是双保险：万一模型没听话，也不会出现两个 @。
              const bodyText = stripMentions(c.text, mentionName)
              commentText = mentionName ? `@${mentionName} ${bodyText}` : bodyText
              appendLive(home, '思考', `评论写好了（${c.source === 'llm' ? '模型' : '模板'}）：${c.text}`)
            }
          } catch {
            commentText = null
          }
        }

        const args = ['act', '--bvid', v.bvid]
        if (cfg.doLike) args.push('--like')
        if (cfg.doCoin && Number(cfg.coinPerVideo) > 0) args.push('--coin', String(Math.min(2, Number(cfg.coinPerVideo))))
        if (cfg.doFavorite && Number(cfg.favoriteId) > 0) args.push('--fav', String(cfg.favoriteId))
        if (danmakuText) args.push('--danmaku', danmakuText)
        if (cfg.doFollow) args.push('--follow')
        args.push('--interval', String(cfg.actionIntervalMs[0] / 1000), String(cfg.actionIntervalMs[1] / 1000))

        let r = null
        try {
          r = await runPy(pc, args, { timeout: 120_000 })
        } catch (e) {
          r = { ok: false, error: String(e?.message ?? e), done: [], failed: [] }
        }

        const info = r?.info || {}
        const title = info.title || v.title || ''
        const up = info.up || v.up || ''

        // ── 发评论（只读/写分两步：先发顶层评论，再回别人的评论）──
        let myRpid = null
        if (commentText && !r?.riskTripped && !overCap()) {
          try {
            const cr = await runPy(pc, ['comment', '--bvid', v.bvid, '--text', commentText], { timeout: 60_000 })
            if (cr?.ok) {
              myRpid = cr.rpid || null
              appendLive(home, '动作', `${v.bvid} · 评论已发${mentionName ? '（@' + mentionName + '）' : ''}${myRpid ? ' · rpid ' + myRpid : ''}`)
              appendLedger(home, {
                kind: 'comment', ok: true, bvid: v.bvid, title, up,
                text: commentText, rpid: myRpid,
              })
              bumpDaily(home, 'comment')
              summary.done++
              summary.comments = (summary.comments || 0) + 1
            } else {
              const ccode = cr?.code
              const cmsg = cr?.error || (ccode != null ? 'code ' + ccode : '没给原因')
              appendLive(home, '失败', `评论没发出去：${cmsg}`)
              appendLedger(home, {
                kind: 'comment', ok: false, bvid: v.bvid, title, up,
                text: commentText, code: ccode ?? null, error: cmsg, raw: cr?.raw ?? null,
              })
              summary.failed++
              // 风控 / 未登录：继续撞只会更糟，直接收工
              if ([ -412, -352, -351, -101, 12014, 12015 ].includes(ccode)) {
                rt.stopRequested = true
                appendLive(home, '阶段', `B站 挡住评论了（${ccode}）：这一轮就停在这，别硬冲`)
                summary.stoppedByRisk = true
              }
            }
          } catch (e) {
            appendLive(home, '失败', '评论异常：' + String(e?.message ?? e).slice(0, 80))
            summary.failed++
          }
        }

        // ── 评论区：读一次，回评论要用，学习也要用 ──
        // ⚠️ 以前读评论区被包在「回别人的评论」开关里，导致关掉回评论后
        //    「边刷边学」也一起停了 —— 两件事本来互不依赖。
        const wantReply = !!(cfg.doReplyComment && Number(cfg.replyCount) > 0)
        let cmtList = null
        if ((wantReply || cfg.doLearn) && !r?.riskTripped) {
          try {
            cmtList = await runPy(pc, ['comments', '--bvid', v.bvid, '--order', 'time', '--limit', '20'], { timeout: 60_000 })
          } catch (e) {
            if (wantReply) appendLive(home, '失败', '读评论区失败：' + String(e?.message ?? e).slice(0, 80))
          }
        }
        const cmtItems = (cmtList && cmtList.items) || []

        // ── 学习：从评论区里挑真有内容的记下来（不看字数，看有没有东西）──
        if (cfg.doLearn && cmtItems.length) {
          const minScoreC = Number.isFinite(Number(cfg.learnMinScore)) ? Number(cfg.learnMinScore) : 6
          try {
            const got = await extractLearnings(v, cmtItems, cfg, {
              max: Math.max(0, Number.isFinite(Number(cfg.learnPerRun)) ? Number(cfg.learnPerRun) : 3),
            })
            let saved = 0
            const savedTexts = []
            for (const g of got) {
              if (Number(g.score) >= minScoreC &&
                  addLearned(home, { ...g, kind: 'rule', from: '评论区', bvid: v.bvid, rpid: guessRpid(g.evidence || g.text, cmtItems) })) {
                saved++
                savedTexts.push(String(g.rule || g.text).slice(0, 20))
              }
            }
            if (saved) {
              appendLive(home, '思考', `记了 ${saved} 条笔记：${savedTexts.join(' / ')}`)
              summary.learned = (summary.learned || 0) + saved
            }
            // 每轮都顺手淘汰一次，别等监听器才 prune（监听关着就永远不淘汰）
            pruneLearned(home, 400)
          } catch { /* 学习失败不影响跑 */ }
        }

        // ── 回别人的评论 ──
        if (wantReply && !r?.riskTripped && cmtItems.length) {
          // ⚠️ 以前这里完全不去重：同一个楼跑几轮就被回几次，
          //    用户真实遇到过同一条评论下面挂了自己 3 条回复（最夸张的账本里 11 条）。
          //    现在先算出「我已经回过的楼」，这些一律跳过。
          //    后续对话交给「回复监听」—— 那才是它该管的场景。
          const repliedRoots = (() => {
            const set = new Set()
            try {
              for (const row of readLedger(home, 800)) {
                if (!row || row.ok !== true) continue
                if (row.kind !== 'reply' && row.kind !== 'replyback') continue
                if (!row.bvid) continue
                const root = row.root || row.parent || ''
                if (root) set.add(String(row.bvid) + '#' + String(root))
              }
            } catch { /* 读不到就不去重，别把这一轮弄挂 */ }
            return set
          })()

          const poolAll = cmtItems
            .filter((c) => c.content && c.content.length >= 4 && !/[抽奖加群微信QQ代练]/.test(c.content))
          const pool = poolAll.filter((c) => !repliedRoots.has(String(v.bvid) + '#' + String(c.rpid)))
          const dupSkipped = poolAll.length - pool.length
          if (dupSkipped > 0) {
            appendLive(home, '思考', `跳过 ${dupSkipped} 条已经回过的评论（同一个楼不重复回）`)
          }
          if (!pool.length) {
            appendLive(home, '思考', '评论区里的新评论都回过了，这条视频不再重复回')
          }
          const want = Math.max(0, Number(cfg.replyCount))
          let picked = []
          try {
            picked = want > 0 ? await pickReplyTargets(v, pool, cfg, { max: want, learned, digest }) : []
          } catch {
            picked = []
          }
          const byId = new Map(pool.map((c) => [String(c.rpid), c]))
          const cands = picked.map((x) => byId.get(x.rpid)).filter(Boolean)
          if (cands.length) {
            appendLive(home, '思考', `评论区 ${cmtList.total} 条，值得接话的有 ${cands.length} 条：${picked.map((x) => (byId.get(x.rpid)?.uname || '') + '（' + (x.why || '有内容') + '）').join('、')}`)
          } else if (want > 0) {
            appendLive(home, '思考', `评论区 ${cmtList.total} 条，没挑出值得接话的，这次不硬回`)
          }
          for (const c of cands) {
            if (rt.stopRequested) break
            if (overCap()) {
              appendLive(home, '思考', `动作数到「一轮上限」了（${runCap}），后面的回复先不发了`)
              break
            }
            let rep = ''
            try {
              const g = await makeReply(v, c, cfg, { learned, digest })
              rep = g.text
            } catch { continue }
            if (!rep) continue
            try {
              const rr = await runPy(pc, ['comment', '--bvid', v.bvid, '--text', rep, '--root', c.rpid, '--parent', c.rpid], { timeout: 60_000 })
              if (rr?.ok) {
                appendLive(home, '动作', `${v.bvid} · 回了 ${c.uname}：「${rep.slice(0, 30)}」`)
                appendLedger(home, {
                  kind: 'reply', ok: true, bvid: v.bvid, title, up,
                  text: rep, rpid: rr.rpid, toUid: c.uid, toName: c.uname, root: c.rpid,
                })
                bumpDaily(home, 'reply')
                summary.done++
                summary.replies = (summary.replies || 0) + 1
              } else {
                const rc = rr?.code
                const rmsg = rr?.error || (rc != null ? 'code ' + rc : '没给原因')
                appendLive(home, '失败', `回复 ${c.uname} 没发出去：${rmsg}`)
                appendLedger(home, {
                  kind: 'reply', ok: false, bvid: v.bvid, title, up,
                  text: rep, code: rc ?? null, error: rmsg, toName: c.uname, raw: rr?.raw ?? null,
                })
                summary.failed++
                if ([-412, -352, -351, -101, 12014, 12015].includes(rc)) {
                  rt.stopRequested = true
                  appendLive(home, '阶段', `B站 挡住回复了（${rc}）：这一轮就停在这`)
                  summary.stoppedByRisk = true
                  break
                }
              }
            } catch { summary.failed++ }
            await new Promise((res) => setTimeout(res, 1500 + Math.random() * 2500))
          }
        }

        // ── 私信通知（默认关）──
        if (cfg.doDm && Number(cfg.dmUid) > 0 && (!cfg.dmOnComment || myRpid)) {
          try {
            // 没发评论时（doComment 关着、或这条没写成）别说「评论了」，那是假话
            const dtext = commentText
              ? `在 ${v.bvid} 评论了：${String(commentText).slice(0, 80)}`
              : `刷到了 ${v.bvid}${title ? '《' + String(title).slice(0, 30) + '》' : ''}`
            const dr = await runPy(pc, ['dm', '--uid', String(cfg.dmUid), '--text', dtext], { timeout: 40_000 })
            if (dr?.ok) {
              appendLive(home, '动作', `私信已发 → ${cfg.dmUid}`)
              appendLedger(home, { kind: 'dm', ok: true, bvid: v.bvid, title, up, text: dtext })
              summary.done++
            } else {
              appendLive(home, '失败', `私信没发出去：${dr?.error || ('code ' + dr?.code)}`)
              summary.failed++
            }
          } catch (e) {
            appendLive(home, '失败', '私信异常：' + String(e?.message ?? e).slice(0, 60))
          }
        }

        for (const d of (r?.done || [])) {
          appendLedger(home, {
            kind: d.kind, ok: true, bvid: v.bvid, title, up,
            n: d.n ?? null, text: d.text ?? null, dmid: d.dmid ?? null,
          })
          bumpDaily(home, d.kind, d.kind === 'coin' ? (d.n || 1) : 0)
          summary.done++
        }
        // 「已经赞过了」这类不是失败：想要的状态已经达成
        for (const sk of (r?.skipped || [])) {
          appendLedger(home, {
            kind: sk.kind, ok: true, skipped: true, bvid: v.bvid, title, up,
            code: sk.code ?? null, note: sk.msg ?? null,
          })
          summary.skipped = (summary.skipped || 0) + 1
        }
        for (const f of (r?.failed || [])) {
          appendLedger(home, {
            kind: f.kind, ok: false, bvid: v.bvid, title, up,
            code: f.code ?? null, error: f.msg ?? null,
          })
          summary.failed++
          appendLive(home, '失败', `${f.kind} 没成：${f.msg || ('code ' + f.code)}`)
        }

        if ((r?.done || []).length) {
          const what = r.done.map((d) => d.kind === 'danmaku' ? `弹幕「${d.text}」` : d.kind).join('、')
          appendLive(home, '动作', `${v.bvid} · ${title.slice(0, 40)} · ${what}`)
          summary.videos.push({ bvid: v.bvid, title, up, what })
        } else if (!(r?.failed || []).length) {
          appendLive(home, '跳过', `${v.bvid} · 没有任何动作被执行（可能设置里全关了）`)
          summary.skipped++
        }

        // ⚠️ 撞到风控就整轮停：继续硬试只会让账号更难看
        if (r?.riskTripped) {
          appendLive(home, '失败', 'B站 要人机验证了（-401）—— 这一轮到此为止，别再撞了')
          log('risk tripped, stopping run')
          summary.riskTripped = true
          break
        }

        // 视频之间歇一下
        if (i < targets.length - 1) {
          await new Promise((res) => setTimeout(res, 2000 + Math.random() * 4000))
        }
      }

      rt.phase = ''
      const msg = summary.riskTripped
        ? `动了 ${summary.done} 次，撞到风控提前收了（失败 ${summary.failed} 次）`
        : `动了 ${summary.done} 次，失败 ${summary.failed} 次`
      appendLive(home, '小结', msg)
      log(`run done ${msg}`)
      rt.lastResult = { at: new Date().toISOString(), ...summary, message: msg }
      return { started: true, ...summary, message: msg }
    } catch (e) {
      const msg = String(e?.message ?? e)
      rt.error = msg
      appendLive(home, '失败', msg.slice(0, 160))
      log('run failed: ' + msg)
      rt.lastResult = { at: new Date().toISOString(), error: msg }
      return { started: true, error: msg }
    } finally {
      rt.running = false
      rt.phase = ''
      rt.finishedAt = Date.now()
      rt.progress.currentBvid = ''
      rt.progress.currentTitle = ''
    }
  }

  /* ─────────────────────── HTTP 接口 ─────────────────────── */

  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    } catch { /* 连接断了 */ }
  }

  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    const fin = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) { data = ''; fin({}); req.destroy() }
    })
    req.on('end', () => { try { fin(JSON.parse(data || '{}')) } catch { fin({}) } })
    req.on('error', () => fin({}))
  })

  const sameOriginOk = (req) => {
    try {
      const host = String(req.headers.host || '')
      if (!host) return true
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
      const pick = String(req.headers.origin || req.headers.referer || '')
      if (!pick) return true
      try {
        const u = new URL(pick)
        return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)
      } catch { return false }
    } catch { return false }
  }

  /* ─────────────── 登录态 ─────────────── */

  /** 自己那份凭证优先，再退回 bili-duty 那份（跟 python 侧同一套顺序） */
  const credPaths = () => [
    join(home, 'credential.json'),
    join(process.env.DSH_HOME ?? join(process.env.USERPROFILE || '', '.dsh'), 'bili-duty', 'bili_credential.json'),
  ]

  /** 本插件自己的凭证存不存在 */
  const hasOwnCred = () => {
    try {
      const own = join(home, 'credential.json')
      return existsSync(own) && statSync(own).size > 20
    } catch { return false }
  }

  /** 能不能干活：自己有，或者借用刷视频插件那份 */
  const hasCred = () => credPaths().some((p) => {
    try { return existsSync(p) && statSync(p).size > 20 } catch { return false }
  })

  // 用函数声明（会提升）—— runOnce 里在定义位置之前就用到它了
  function pyCtx(cfg) {
    return {
      python: resolvePython(cfg),
      script: PY_SCRIPT,
      cwd: home,
      credHome: join(
        process.env.DSH_HOME ?? join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'),
        'bili-duty',
      ),
      // 让 python 把凭证写进本插件自己的家
      env: { BILI_INTERACTOR_HOME: home },
    }
  }

  /**
   * 自己装 Python 依赖 —— 用户不该为了装个插件去记 pip 命令。
   *
   * 干的事：用探测到的 python 建本插件的 venv（~/.dsh/bili-interactor/.venv），
   * 然后往里装依赖。装完清掉解释器缓存，下次探测就会选中这个新的。
   */
  const INSTALL_PKGS = ['bilibili-api-python', 'httpx', 'qrcode', 'pillow']

  const runCmd = (cmd, args) => new Promise((resolve, reject) => {
    const push = (buf) => {
      const text = String(buf || '')
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim()
        if (t) {
          rt.setup.log.push(t.slice(0, 240))
          if (rt.setup.log.length > 80) rt.setup.log.shift()
        }
      }
    }
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' } })
    } catch (e) {
      return reject(e)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(cmd.split(/[\\/]/).pop() + ' 退出码 ' + code))
    })
  })

  async function installDeps() {
    if (rt.setup && rt.setup.running) return { started: false, busy: true }
    const cfgI = loadConfig(home)
    const basePy = resolvePython(cfgI)
    const isWin = process.platform === 'win32'
    const venvDir = join(home, '.venv')
    const venvPy = isWin ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python3')

    rt.setup = { running: true, step: '准备', log: [], error: '', done: false, at: new Date().toISOString() }

    ;(async () => {
      try {
        if (!existsSync(venvPy)) {
          rt.setup.step = '创建虚拟环境'
          await runCmd(basePy, ['-m', 'venv', venvDir])
        }
        rt.setup.step = '升级 pip'
        await runCmd(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'])
        rt.setup.step = '安装依赖（首次可能几分钟）'
        await runCmd(venvPy, ['-m', 'pip', 'install', ...INSTALL_PKGS])
        rt.setup.step = '完成'
        rt.setup.done = true
        // 清缓存：下次 resolvePython 会重新探测，并选中这个新 venv
        pythonCache = { key: '', value: '' }
        appendLive(home, '阶段', 'Python 依赖装好了，可以开跑')
        log('依赖装好了: ' + venvPy)
      } catch (e) {
        rt.setup.error = String(e?.message ?? e)
        log('装依赖失败: ' + rt.setup.error)
      } finally {
        rt.setup.running = false
      }
    })()

    return { started: true }
  }

  /**
   * 自检：Python 依赖 + 登录 + key。
   * 加载时自动跑一次存进 rt.doctor，用户不用点就能看到缺什么。
   */
  async function runDoctor() {
    const cfgD = loadConfig(home)
    let pyDoctor = null
    try {
      pyDoctor = await runPy({ python: resolvePython(cfgD), script: PY_SCRIPT, cwd: home,
        credHome: join(process.env.DSH_HOME ?? join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), 'bili-duty'),
        env: { BILI_INTERACTOR_HOME: home } }, ['doctor'], { timeout: 60_000, env: { ...process.env, BILI_INTERACTOR_HOME: home } })
    } catch (e) {
      pyDoctor = { ok: false, error: String(e?.message ?? e) }
    }
    const items = Array.isArray(pyDoctor?.items) ? [...pyDoctor.items] : []
    items.push({
      name: 'DeepSeek API key',
      ok: hasApiKey(),
      detail: hasApiKey() ? '已找到' : '没有 —— 人设不生效，会退回内置模板',
      fix: '把 DEEPSEEK_API_KEY 写进 ~/.dsh/.credentials.yaml',
    })
    items.push({
      name: 'Python 解释器',
      ok: !!(pyDoctor && pyDoctor.ok),
      detail: pyDoctor?.python
        ? pyDoctor.python + '（自动探测）'
        : '没找到能用的 Python',
      fix: pyDoctor?.ok ? '' : '装 Python 3.10+ 后重启 DSH；插件会自动重新扫描',
    })
    const fatal = items.filter((x) => !x.ok)
    return {
      ok: true,
      ready: pyDoctor?.ok !== false && fatal.filter((x) => x.name !== 'B站 登录').length === 0,
      items,
      fatalCount: fatal.length,
      pyError: pyDoctor && pyDoctor.ok === false ? (pyDoctor.error || '') : '',
      at: new Date().toISOString(),
    }
  }

  const stateNow = () => {
    const s = buildState(home, { version: VERSION })
    return { ...s, run: { ...rt }, loggedIn: hasCred(), ownLogin: hasOwnCred(), loginState: rt.loginState || '', loginName: rt.loginName || '', loginPolls: rt.loginPolls || 0, loginGen: rt.loginGen || 0,
    listener: {
      enabled: !!loadConfig(home).doReplyBack,
      everyMin: Math.max(1, Number(loadConfig(home).listenIntervalMin) || 20),
      running: !!BACK.running,
      armed: !!BACK.timer,
      lastAt: rt.backLastAt || '',
      last: rt.backLast || null,
      todayDone: (() => { try { return Number((readDaily(home).byType || {}).replyback || 0) } catch { return 0 } })(),
      // 我发过的评论一共多少条（去重后的「楼」数），界面用来解释「每次看几条」
      totalThreads: (() => {
        try {
          const cfgL = loadConfig(home)
          const since = Date.now() - Math.max(1, Number(cfgL.listenLookbackHours) || 72) * 3600_000
          const keys = new Set()
          for (const r of readLedger(home, 400)) {
            if (!r || r.ok !== true) continue
            if (!['comment', 'reply', 'replyback'].includes(r.kind)) continue
            if (!r.bvid || !r.rpid) continue
            const when = Date.parse(r.at || r.ts || '') || 0
            if (when && when < since) continue
            keys.add(r.bvid + '#' + String(r.root || r.rpid))
          }
          return keys.size
        } catch { return 0 }
      })(),
      perDay: Math.max(0, Number(loadConfig(home).replyBackPerDay) || 0),
      cursor: rt.backCursorInfo || null,
    },
    seenCount: (() => { try { return readSeen(home).size } catch { return 0 } })(),
    learnedCount: (() => { try { return readLearned(home).length } catch { return 0 } })(),
    // 有没有 DeepSeek key。没有的话人设和「值得接话」的挑选都会退回模板/粗筛，
    // 界面必须能看出来，否则用户会以为角色卡在起作用。
    llm: (() => { try { return hasApiKey() } catch { return false } })(),
    // 加载时自动跑的自检结果（界面据此直接显示缺什么，不用用户点）
    env: rt.doctor || null,
  }
  }

  // 先拆掉上一次（热重载遗留）挂的路由，否则新实例永远抢不到请求
  try {
    if (ROUTE_STATE.dispose) { ROUTE_STATE.dispose(); ROUTE_STATE.dispose = null; log('旧路由已拆除') }
  } catch { /* 拆不掉就算了 */ }

  try {
    ctx.effect(() => {
      const d = ctx.webServer.register({
        kind: 'prefix',
        path: '/api/bili-itx',
      handler: async (req, res) => {
        if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
        const p = String(req.url || '/').split('?')[0].replace(/^\/api\/bili-itx/, '') || '/'
        try {
          if (req.method === 'GET' && (p === '/state' || p === '/')) return sendJson(res, 200, stateNow())
          if (req.method === 'GET' && p === '/config') return sendJson(res, 200, { ok: true, config: loadConfig(home) })

          if (req.method === 'POST' && p === '/config') {
            const body = await readBody(req)
            const cfg0 = loadConfig(home)          // 保存前的快照，用来判断监听参数有没有变
            const cfg = saveConfig(home, body || {})

            // 监听相关参数变了 => 重新排期，别让用户还得手动关开一次
            try {
              const after = loadConfig(home)
              const before = { everyMin: Math.max(1, Number(cfg0?.listenIntervalMin) || 20), on: cfg0?.doReplyBack }
              const nowEvery = Math.max(1, Number(after.listenIntervalMin) || 20)
              if (before.on !== after.doReplyBack || before.everyMin !== nowEvery) {
                stopReplyBack()
                if (after.doReplyBack && hasCred()) startReplyBack()
                log(`监听参数变了，重新排期：每 ${nowEvery} 分钟`)
              }
            } catch { /* ignore */ }
            log('config updated: ' + JSON.stringify(Object.keys(body || {})))
            return sendJson(res, 200, { ok: true, config: cfg })
          }

          if (req.method === 'POST' && p === '/run') {
            // ⚠️ 必须用和 runOnce 同一套检查。
            //    以前这里自己写了一份，漏了「回复监听正在跑」那一条 ——
            //    接口回 started:true，runOnce 立刻退出，rt.running 从未置真，
            //    用户看到的就是「点了没反应，按钮还能再点」。
            const pre = runPreflight()
            if (!pre.ok) {
              const { ok: _o, ...rest } = pre
              return sendJson(res, 200, { ok: true, started: false, ...rest })
            }
            runOnce('manual').catch((e) => log('run crashed: ' + String(e?.message ?? e)))
            return sendJson(res, 200, { ok: true, started: true, quotaLeft: pre.quotaLeft })
          }

          // 预览：只生成草稿、不发送。先看清楚它会说什么，再决定开不开
          if (req.method === 'POST' && p === '/reply-back/preview') {
            const r = await replyBackOnce('preview', { dry: true })
            return sendJson(res, 200, r)
          }

          // 立刻检查一次「有没有人回我」（不用等定时器）
          if (req.method === 'POST' && p === '/reply-back/now') {
            const r = await replyBackOnce('manual')
            return sendJson(res, 200, r)
          }

          // 开/关监听（会顺手启停定时器）
          if (req.method === 'POST' && p === '/reply-back/toggle') {
            let body = {}
            try { body = await readBody(req) } catch { /* ignore */ }
            const on = body.on !== false
            saveConfig(home, { doReplyBack: on })
            if (on) startReplyBack()
            else stopReplyBack()
            log('监听 ' + (on ? '开启' : '关闭'))
            return sendJson(res, 200, { ok: true, on, armed: !!BACK.timer })
          }

          if (req.method === 'POST' && p === '/stop') {
            rt.stopRequested = true
            appendLive(home, '思考', '收到停止指令，做完手上这条就收。')
            return sendJson(res, 200, { ok: true, stopping: true })
          }

          if (req.method === 'GET' && p === '/whoami') {
            const r = await runPy(pyCtx(loadConfig(home)), ['whoami'], { timeout: 30_000 })
              .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
            return sendJson(res, 200, r)
          }

          // ── 登录：扫码 ──────────────────────────────────────────
          // 三步：拿二维码 → 轮询是否确认 → 成功后凭证落到 ~/.dsh/bili-interactor/credential.json
          //
          // ⚠️ 写盘全在宿主这边：python 子进程跑在沙箱里，`~/.dsh/<插件名>` 是写不进去的
          //    （只有白名单目录可写）。所以 python 只负责联网要数据，文件系统归我们。
          if (req.method === 'POST' && p === '/login/qr') {
            if (rt.loginBusy) return sendJson(res, 200, { ok: false, error: '正在生成，等一下' })
            rt.loginBusy = true
            try {
              // ⭐⭐ 幂等：如果已经有一张还在有效期的码，就把它原样返回，
              //    绝不重新生成 —— 每生成一次，用户屏幕上/手机上正在扫的那张就作废。
              //    这就是「手机上点了确认、插件却说没扫」的真正原因。
              // 用户点「换一张」时要真的换，不能又返回同一张
              const force = /[?&]force=1/.test(req.url || '')
              if (force) log('用户点了换一张，强制生成新码')
              const alive = force ? null : (() => {
                try {
                  const saved = readJson(join(home, 'login.json'), {})
                  if (!saved || !saved.qrcodeKey) return null
                  const age = Date.now() - Number(saved.at || 0)
                  // 剩余不足 45 秒就别复用（递出去也会过期）
                  if (age > QR_TTL_MS - QR_MIN_USABLE_MS) return null
                  // 图和 key 来自同一份快照，绝不可能是「新 key 配旧图」
                  if (!saved.image) return null
                  return {
                    qrcodeKey: String(saved.qrcodeKey),
                    image: 'data:image/png;base64,' + saved.image,
                    reused: true,
                    gen: saved.gen || 0,
                    leftSec: qrLeftSec(age),
                    howto: '这张码还在有效期内，直接扫就行',
                  }
                } catch { return null }
              })()
              if (alive) {
                rt.loginKey = alive.qrcodeKey
                if (!getTimer()) startLoginWatcher()
                log('复用未过期的二维码（不重新生成）')
                return sendJson(res, 200, { ok: true, ...alive })
              }
              rt.loginExpiredAfterScan = false   // 用户主动换码，清掉上次失败的提示
              const r = await refreshQr()
              return sendJson(res, 200, r)
            } finally {
              rt.loginBusy = false
            }
          }

          if (req.method === 'GET' && p === '/login/poll') {
            // 兼容旧前端：前端现在已经统一走 /login/view，
            // 这里只回当前状态，不再自己跑一套轮询 —— 单一实现，避免两处逻辑打架。
            if (!rt.loginKey) {
              return sendJson(res, 200, { ok: true, done: false, state: 'none', hint: '还没生成二维码' })
            }
            if (hasCred()) {
              return sendJson(res, 200, { ok: true, done: true, state: 'done', name: rt.loginName || '' })
            }
            return sendJson(res, 200, {
              ok: true, done: false,
              state: rt.loginState === 'conf' ? 'conf' : 'scan',
              hint: rt.loginState === 'conf' ? '扫到了，等确认' : '还没扫',
            })
          }

          if (req.method === 'GET' && p === '/login/view') {
            const now = Date.now()
            rt.loginSeenAt = now
            // 自愈：内存 key 空了但盘里有有效码 => 捞回来
            //（否则前端看到有图、后端说没码，poll 永远不动）
            if (!rt.loginKey) {
              try {
                const savedK = readJson(join(home, 'login.json'), {})
                if (savedK && savedK.qrcodeKey && now - Number(savedK.at || 0) < QR_TTL_MS - QR_MIN_USABLE_MS) {
                  rt.loginKey = String(savedK.qrcodeKey)
                  rt.loginAt = Number(savedK.at) || now
                }
              } catch { /* ignore */ }
            }
            // 有人在看、但轮询停了 => 重新起来
            if (!getTimer() && rt.loginKey && !hasCred()) {
              startLoginWatcher()
            }
            let saved = null
            try { saved = readJson(join(home, 'login.json'), {}) } catch { /* ignore */ }
            const age = saved ? now - Number(saved.at || 0) : Infinity
            const fresh = !!(saved && saved.qrcodeKey && age < QR_TTL_MS - QR_MIN_USABLE_MS)

            let image = ''
            if (fresh && saved.image) {
              image = 'data:image/png;base64,' + saved.image
            }
            return sendJson(res, 200, {
              ok: true,
              loggedIn: hasCred(),
              ownLogin: hasOwnCred(),
              pending: fresh && !!image,
              image,
              // 没有有效码时不要回放上一次的 scan/logout 残留状态
              state: fresh ? (rt.loginState || 'scan') : '',
              name: rt.loginName || '',
              gen: rt.loginGen || 0,
              expiredAfterScan: !!rt.loginExpiredAfterScan,
              leftSec: fresh ? qrLeftSec(age) : 0,
            })
          }

          // 兼容旧版前端（现在统一走 /login/view）。留着不碍事，
          // 因为可能还有页面是从旧 bundle 加载的。
          if (req.method === 'GET' && p === '/login/pending') {
            const pending = (() => {
              try {
                const saved = readJson(join(home, 'login.json'), {})
                if (!saved || !saved.qrcodeKey) return null
                const age = Date.now() - Number(saved.at || 0)
                if (age > 170_000) return null
                return { key: String(saved.qrcodeKey), ageSec: Math.round(age / 1000), image: saved.image || '' }
              } catch { return null }
            })()
            if (!pending) return sendJson(res, 200, { ok: true, pending: false })
            return sendJson(res, 200, {
              ok: true, pending: true,
              image: pending.image ? 'data:image/png;base64,' + pending.image : '',
              state: rt.loginState || 'scan', ageSec: pending.ageSec,
              leftSec: Math.max(0, 170 - pending.ageSec),
            })
          }

          if (req.method === 'POST' && p === '/logout') {
            // ⚠️ 只删**本插件自己**那份。
            //    绝不碰 ~/.dsh/bili-duty 里的共用凭证 —— 那是「刷B站」插件的登录，
            //    删它等于把别人的登录一起端了（上一次就是这么搞砸的）。
            const removed = []
            for (const f of [join(home, 'credential.json'), join(home, 'qr.png'), join(home, 'login.json')]) {
              try {
                if (existsSync(f)) { unlinkSync(f); removed.push(f) }
              } catch { /* 删不掉就跳过 */ }
            }
            rt.loginKey = ''
            rt.loginAt = 0
            rt.loginState = ''
            rt.loginName = ''
            rt.loginGen = (rt.loginGen || 0) + 1
            stopLoginWatcher()
            // 监听器也要停：它每次都检查 hasCred()，而共享凭证还在，
            // 不停的话「退出登录」之后它照样会去回别人。
            stopReplyBack()
            appendLive(home, '阶段', '已退出登录，回复监听也停了')
            log('logout removed=' + JSON.stringify(removed))
            // 本插件的登录态只看自己那份；共用那份只用来「借用」，不算已登录
            return sendJson(res, 200, {
              ok: true,
              removed,
              loggedIn: hasOwnCred(),
              usingShared: !hasOwnCred() && hasCred(),
            })
          }

          if (req.method === 'GET' && p === '/me') {
            if (!hasCred()) return sendJson(res, 200, { ok: false, needLogin: true, error: '还没登录' })
            const r = await runPy(pyCtx(loadConfig(home)), ['whoami'], { timeout: 30_000 })
              .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
            return sendJson(res, 200, { ...r, which: credPaths().find((x) => { try { return existsSync(x) } catch { return false } }) || '' })
          }

          if (req.method === 'POST' && p === '/search') {
            const body = await readBody(req)
            const kw = String(body.keyword || '').trim()
            if (!kw) return sendJson(res, 400, { ok: false, error: 'keyword 必填' })
            const cfg = loadConfig(home)
            const r = await runPy(pyCtx(cfg), ['search', '--keyword', kw, '--order', String(body.order || cfg.order), '--limit', String(body.limit || 12)], { timeout: 60_000 })
              .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
            return sendJson(res, 200, r)
          }

          // ── 自检：新用户装完插件，先看这个知道缺什么 ──
          // 光抛 ModuleNotFoundError 用户没法自救，这里给能直接复制的命令。
          // ── 刷过的视频：条数 / 清空 ──
          if (req.method === 'GET' && p === '/seen') {
            const m = (() => { try { return readSeen(home) } catch { return new Map() } })()
            const list = [...m.entries()]
              .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
              .slice(0, 50)
              .map(([bvid, at]) => ({ bvid, at }))
            return sendJson(res, 200, { ok: true, count: m.size, recent: list })
          }

          if (req.method === 'POST' && p === '/seen/clear') {
            const okClear = clearSeen(home)
            log('清空已刷记录 ok=' + okClear)
            appendLive(home, '阶段', '清空了「刷过的视频」记录，之后会重新刷到它们')
            return sendJson(res, 200, { ok: okClear, count: okClear ? 0 : -1 })
          }

          // ── 一键装依赖：用户不该为了插件去记 pip ──
          if (req.method === 'POST' && p === '/setup/deps') {
            const r = await installDeps()
            return sendJson(res, 200, { ok: true, ...r, setup: rt.setup })
          }

          if (req.method === 'GET' && p === '/setup/status') {
            return sendJson(res, 200, { ok: true, setup: rt.setup || null })
          }

          if (req.method === 'GET' && p === '/doctor') {
            // 逻辑在 runDoctor() 里，这里只负责返回
            const d = await runDoctor()
            rt.doctor = d
            return sendJson(res, 200, d)
          }

          // ── 可见性：B站 收了（code 0）不等于别人看得见 ──
          // 新号/敏感内容会进审核或折叠：作者用 cookie 查得到，别人查不到。
          // 这里按「带 cookie vs 匿名」对比来判断，结果缓存到 visibility.json。
          if (req.method === 'GET' && p === '/visibility') {
            const cache = readJson(join(home, 'visibility.json'), {})
            return sendJson(res, 200, { ok: true, map: cache && cache.map ? cache.map : {}, at: cache?.at || '' })
          }

          if (req.method === 'POST' && p === '/visibility/check') {
            let body = {}
            try { body = await readBody(req) } catch { /* ignore */ }
            const limit = Math.max(1, Math.min(30, Number(body.limit) || 10))
            const cfgV = loadConfig(home)
            const pcV = pyCtx(cfgV)

            // 取最近发过、带 rpid 的评论/回复，按 rpid 去重
            const rows = []
            const seenR = new Set()
            for (const r of readLedger(home, 400).slice().reverse()) {
              if (rows.length >= limit) break
              if (!r || r.ok !== true) continue
              if (!['comment', 'reply', 'replyback'].includes(r.kind)) continue
              if (!r.bvid || !r.rpid) continue
              const k = String(r.rpid)
              if (seenR.has(k)) continue
              seenR.add(k)
              rows.push(r)
            }
            if (!rows.length) return sendJson(res, 200, { ok: true, checked: 0, map: {} })

            const map = Object.assign({}, (readJson(join(home, 'visibility.json'), {}) || {}).map || {})
            let hidden = 0
            let failed = 0
            for (const r of rows) {
              let v = null
              try {
                v = await runPy(pcV, ['visible', '--bvid', r.bvid, '--rpid', String(r.rpid), '--root', String(r.root || r.rpid)], { timeout: 60_000 })
              } catch (e) {
                v = { ok: false, error: String(e?.message ?? e) }
              }
              if (v?.ok) {
                map[String(r.rpid)] = { public: !!v.visible, hint: v.hint || '', at: new Date().toISOString() }
                if (!v.visible) hidden++
              } else {
                failed++
                map[String(r.rpid)] = { public: null, hint: v?.error || '查不到', at: new Date().toISOString() }
              }
              await new Promise((res2) => setTimeout(res2, 400))
            }
            // 只留最近 500 条，避免这个映射无限涨
            const keys = Object.keys(map)
            if (keys.length > 500) {
              const sorted = keys.sort((a, b) => String(map[b]?.at || '').localeCompare(String(map[a]?.at || '')))
              for (const k of sorted.slice(500)) delete map[k]
            }
            try { writeJson(join(home, 'visibility.json'), { at: new Date().toISOString(), map }) } catch { /* ignore */ }
            log(`可见性检查 ${rows.length} 条：${hidden} 条别人看不到，${failed} 条查失败`)
            return sendJson(res, 200, { ok: true, checked: rows.length, hidden, failed, map })
          }

          // 大肥鱼的记忆：给界面看，也能删单条
          if (req.method === 'GET' && p === '/learned') {
            const all = readLearned(home)
            const cfgL = loadConfig(home)
            const used = cfgL.doLearn ? pickLearned(home, Number.isFinite(Number(cfgL.learnUseCount)) ? Number(cfgL.learnUseCount) : 8) : []
            return sendJson(res, 200, {
              ok: true,
              total: all.length,
              // 新→旧
              items: all.slice().reverse().slice(0, 300),
              // 下次说话会真的带上的那几条（界面标出来，一眼能对上）
              used: used.map((e) => String(e.text)),
            })
          }

          // 手动加一条：用户自己觉得值得记的
          if (req.method === 'POST' && p === '/learned/add') {
            let body = {}
            try { body = await readBody(req) } catch { /* ignore */ }
            const text = String(body.text || '').trim()
            if (!text) return sendJson(res, 200, { ok: false, error: '内容不能为空' })
            const okAdd = addLearned(home, {
              text: text.slice(0, 500),
              why: String(body.why || '手动添加').slice(0, 200),
              from: '手动',
              score: Number.isFinite(Number(body.score)) ? Number(body.score) : 8,
            })
            if (!okAdd) return sendJson(res, 200, { ok: false, error: '写不进去（权限？）' })
            log('手动加了一条记忆：' + text.slice(0, 30))
            return sendJson(res, 200, { ok: true, total: readLearned(home).length })
          }

          if (req.method === 'POST' && p === '/learned/delete') {
            let body = {}
            try { body = await readBody(req) } catch { /* ignore */ }
            const text = String(body.text || '')
            if (!text) return sendJson(res, 200, { ok: false, error: '没给要删哪条' })
            const all = readLearned(home)
            const keep = all.filter((e) => String(e.text) !== text)
            try {
              writeFileSync(learnedFile(home), keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''), 'utf8')
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
            }
            log(`删掉一条记忆：${text.slice(0, 30)}`)
            return sendJson(res, 200, { ok: true, total: keep.length })
          }

          if (req.method === 'GET' && p === '/live') return sendJson(res, 200, { ok: true, ...readLive(home) })

          return sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (e) {
          log('http error: ' + String(e?.message ?? e))
          return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
        }
      },
      })
      // 抓到 disposer 存起来：下次热重载先拆它，不然旧闭包会一直占着路由
      if (d && typeof d.dispose === 'function') {
        ROUTE_STATE.dispose = () => { try { d.dispose() } catch { /* ignore */ } }
      }
      return d
    }, 'bili-interactor: /api/bili-interactor 路由')
  } catch (e) {
    log('路由没挂上：' + String(e?.message ?? e))
  }

  /* 后台任务面板里也露个脸 */
  log(`loaded v${VERSION} home=${home} python=${resolvePython(loadConfig(home))}`)
}
