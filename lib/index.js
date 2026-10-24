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
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildState, loadConfig, saveConfig, ensureHome, homeDir, writeJson, readJson,
  appendLedger, bumpDaily, readDaily, flog, readLive,
  liveFile, ledgerFile, logFile, dayKey,
} from './state.js'
import { runPy, prefilter, pickTargets, describeAction } from './targets.js'
import { makeDanmaku, makeComment, makeReply } from './danmaku.js'

export const name = 'bili-interactor'
export const inject = ['webServer', 'jobs']

// 热重载时 apply 会被重新跑，但旧路由不一定先被拆掉 =>
// 「webserver: duplicate prefix route」刷屏，而且撑着的是旧实例的闭包：
// 新代码生成了 key，旧实例拿着旧的 rt 去 poll，永远对不上。
// 所以用模块级变量兜住，注册前先手动拆旧的。
globalThis.__BILI_INTERACTOR_ROUTE__ ||= { dispose: null }
const ROUTE_STATE = globalThis.__BILI_INTERACTOR_ROUTE__

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const PY_SCRIPT = join(PKG_DIR, 'py', 'interact.py')
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

function resolvePython(cfg) {
  const candidates = [
    cfg.pythonPath,
    join(process.env.DSH_HOME ?? join(process.env.USERPROFILE || '', '.dsh'), 'bili-duty', '.venv', 'Scripts', 'python.exe'),
    join(process.env.USERPROFILE || '', '.dsh', 'bili-duty', '.venv', 'Scripts', 'python.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch { /* ignore */ }
  }
  return candidates[0] || 'python'
}

/* ─────────────────────── 一轮 ─────────────────────── */

export function apply(ctx, config = {}) {
  const home = ensureHome(homeDir(config))
  /** 运行态（面板要用） */
  // 启动/热重载时把上次没扫完的 key 读回来（否则重启后那张码就成了孤儿）
  try {
    const saved = readJson(join(home, 'login.json'), {})
    if (saved && saved.qrcodeKey) {
      const age = Date.now() - Number(saved.at || 0)
      if (age < 170_000) {
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
  })

  const log = (m) => flog(home, m)

  /* ───────── 登录后台轮询器 ─────────
   * ⚠️ 关键设计：登录完成靠的是「有人一直在 poll」。
   *    以前只有前端在轮询 —— 用户扫完码切走了 / 关掉设置页 / 刷新了，
   *    就再也没人 poll，credential.json 永远写不进去，
   *    于是「再进设置还是让你扫码」。这是设计缺陷，不是配置问题。
   *    现在宿主自己起一个定时器，生成码后每 2 秒查一次，最多 3 分钟。
   */
  let loginTimer = null

  function stopLoginWatcher() {
    if (loginTimer) { try { clearInterval(loginTimer) } catch { /* ignore */ } ; loginTimer = null }
  }

  async function pollOnce() {
    if (!rt.loginKey) { stopLoginWatcher(); return }
    rt.loginPolls = (rt.loginPolls || 0) + 1
    let r
    try {
      r = await runPy(pyCtx(loadConfig(home)), ['login-poll', '--key', rt.loginKey], { timeout: 40_000 })
    } catch (e) {
      r = { ok: false, error: String(e?.message ?? e) }
    }
    if (r?.done && r.credential) {
      try {
        ensureHome(home)
        writeJson(join(home, 'credential.json'), r.credential)
      } catch (e) {
        log('写凭证失败: ' + String(e?.message ?? e))
        return
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
      rt.loginState = 'timeout'
      log('二维码过期')
      stopLoginWatcher()
      try { unlinkSync(join(home, 'login.json')) } catch { /* ignore */ }
      rt.loginKey = ''
      return
    }
    if (r?.state === 'conf') rt.loginState = 'conf'
    else if (r?.state === 'scan') rt.loginState = 'scan'
  }

  function startLoginWatcher() {
    stopLoginWatcher()
    const startedAt = Date.now()
    loginTimer = setInterval(() => {
      if (Date.now() - startedAt > 200_000) { stopLoginWatcher(); return }
      pollOnce().catch(() => { /* 下一轮再试 */ })
    }, 2000)
    // 不阻止进程退出
    try { if (loginTimer && typeof loginTimer.unref === 'function') loginTimer.unref() } catch { /* ignore */ }
  }

  ctx.effect(() => () => { stopLoginWatcher() }, 'bili-interactor: 收登录轮询')

  ctx.effect(() => () => { rt.stopRequested = true }, 'bili-interactor: 收摊')

  /* 每轮真正干的活 */
  async function runOnce(trigger = 'manual') {
    if (rt.running) return { started: false, busy: true, error: '上一轮还没跑完' }

    const cfg = loadConfig(home)
    if (!cfg.enabled) return { started: false, error: '插件是关着的（设置里打开 "启用"）' }

    const daily = readDaily(home)
    const dayLimit = Number(cfg.maxActionsPerDay || 0)
    // ⚠️ 0 表示「不限」——以前当 0 算，会变成「一次都不许」，跟界面写的正好相反
    const quota = dayLimit <= 0 ? Number(cfg.maxActionsPerRun || 20) : Math.max(0, dayLimit - daily.actions)
    if (quota <= 0) return { started: false, error: `今天已经动了 ${daily.actions} 次，到上限了` }

    rt.running = true
    rt.stopRequested = false
    rt.phase = '准备'
    rt.startedAt = Date.now()
    rt.finishedAt = 0
    rt.error = ''
    rt.progress = { index: 0, total: 0, currentBvid: '', currentTitle: '' }

    clearLive(home)
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
      const pool = []
      const seen = new Set()
      for (const kw of cfg.keywords) {
        if (rt.stopRequested) break
        appendLive(home, '阶段', `搜「${kw}」${cfg.order === 'click' ? '按播放' : cfg.order === 'pubdate' ? '按最新' : '按综合'}`)
        let res
        try {
          res = await runPy(pc, ['search', '--keyword', kw, '--order', cfg.order, '--limit', '30'], { timeout: 60_000 })
        } catch (e) {
          appendLive(home, '失败', `搜「${kw}」失败：${String(e?.message ?? e).slice(0, 80)}`)
          continue
        }
        if (!res?.ok) {
          appendLive(home, '失败', `搜「${kw}」没结果：${res?.error || ''}`)
          continue
        }
        const kept = prefilter(res.items, cfg)
        appendLive(home, '思考', `「${kw}」拿到 ${res.count} 条，粗筛后剩 ${kept.length} 条`)
        for (const v of kept) {
          if (seen.has(v.bvid)) continue
          seen.add(v.bvid)
          pool.push({ ...v, __kw: kw })
        }
      }

      if (pool.length === 0) {
        appendLive(home, '小结', '没有一条通过粗筛（播放量/关键词/时长都不合适），这轮空手')
        rt.phase = ''
        return { started: true, done: 0, message: '这轮没挑到合适的' }
      }

      /* 3. 挑 */
      rt.phase = '挑目标'
      const targets = pickTargets(pool, cfg, quota)
      appendLive(home, '思考', `候选池 ${pool.length} 条，这轮挑 ${targets.length} 条（今日还剩 ${quota} 次额度）`)
      rt.progress.total = targets.length

      /* 4. 逐条动 */
      for (let i = 0; i < targets.length; i++) {
        if (rt.stopRequested) {
          appendLive(home, '小结', `收到停止，做到第 ${i} 条为止`)
          break
        }
        const v = targets[i]
        rt.phase = '互动中'
        rt.progress.index = i + 1
        rt.progress.currentBvid = v.bvid
        rt.progress.currentTitle = v.title || ''

        appendLive(home, '候选', `${v.bvid} · ${v.title || '(无标题)'} · ${v.up || '?'} · 播放 ${v.play}`)

        // 弹幕文案（要就先生成）
        let danmakuText = null
        if (cfg.doDanmaku) {
          try {
            const d = await makeDanmaku(v, cfg)
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
            const c = await makeComment(v, cfg, { mentionName })
            if (c.text) {
              // @ 由宿主统一拼在最前面，模型只写正文
              commentText = mentionName ? `@${mentionName} ${c.text}` : c.text
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
        if (commentText && !r?.riskTripped) {
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
              appendLive(home, '失败', `评论没发出去：${cr?.error || ('code ' + cr?.code)}`)
              appendLedger(home, {
                kind: 'comment', ok: false, bvid: v.bvid, title, up,
                text: commentText, code: cr?.code ?? null, error: cr?.error ?? null,
              })
              summary.failed++
            }
          } catch (e) {
            appendLive(home, '失败', '评论异常：' + String(e?.message ?? e).slice(0, 80))
            summary.failed++
          }
        }

        // ── 回别人的评论 ──
        if (cfg.doReplyComment && !r?.riskTripped && Number(cfg.replyCount) > 0) {
          try {
            const list = await runPy(pc, ['comments', '--bvid', v.bvid, '--order', 'time', '--limit', '20'], { timeout: 60_000 })
            const cands = (list?.items || [])
              .filter((c) => c.content && c.content.length >= 4 && !/[抽奖加群微信QQ代练]/.test(c.content))
              .slice(0, Math.max(0, Number(cfg.replyCount)))
            if (cands.length) appendLive(home, '思考', `评论区有 ${list.total} 条，挑 ${cands.length} 条回`)
            for (const c of cands) {
              if (rt.stopRequested) break
              let rep = ''
              try {
                const g = await makeReply(v, c, cfg)
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
                  appendLedger(home, {
                    kind: 'reply', ok: false, bvid: v.bvid, title, up,
                    text: rep, code: rr?.code ?? null, error: rr?.error ?? null, toName: c.uname,
                  })
                  summary.failed++
                }
              } catch { summary.failed++ }
              await new Promise((res) => setTimeout(res, 1500 + Math.random() * 2500))
            }
          } catch (e) {
            appendLive(home, '失败', '读评论区失败：' + String(e?.message ?? e).slice(0, 80))
          }
        }

        // ── 私信通知（默认关）──
        if (cfg.doDm && Number(cfg.dmUid) > 0 && (!cfg.dmOnComment || myRpid)) {
          try {
            const dtext = `在 ${v.bvid} 评论了：${String(commentText || '').slice(0, 80)}`
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
      credHome: process.env.DSH_HOME ? join(process.env.DSH_HOME, 'bili-duty') : join(process.env.USERPROFILE || '', '.dsh', 'bili-duty'),
      // 让 python 把凭证写进本插件自己的家
      env: { BILI_INTERACTOR_HOME: home },
    }
  }

  const stateNow = () => {
    const s = buildState(home, { version: VERSION })
    return { ...s, run: { ...rt }, loggedIn: hasCred(), ownLogin: hasOwnCred(), loginState: rt.loginState || '', loginName: rt.loginName || '', loginPolls: rt.loginPolls || 0 }
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
            const cfg = saveConfig(home, body || {})
            log('config updated: ' + JSON.stringify(Object.keys(body || {})))
            return sendJson(res, 200, { ok: true, config: cfg })
          }

          if (req.method === 'POST' && p === '/run') {
            // ⚠️ 先同步做一遍"能不能跑"的检查再返回，不然界面会说"跑起来了"、
            //    结果后台那条一秒就退了 —— 骗人比直接拒绝更糟
            if (rt.running) return sendJson(res, 200, { ok: true, started: false, busy: true, error: '上一轮还没跑完' })
            if (!hasCred()) {
              return sendJson(res, 200, { ok: true, started: false, needLogin: true, error: '还没登录 B站 —— 先去下面扫个码' })
            }
            const cfg = loadConfig(home)
            if (!cfg.enabled) return sendJson(res, 200, { ok: true, started: false, error: '插件是关着的（设置里打开「启用」）' })
            const d = readDaily(home)
            // 一轮上限为 0 = 一次都不许，直接拒（别让它"跑起来了"然后一秒就退）
            if (Number(cfg.maxActionsPerRun || 0) <= 0) {
              return sendJson(res, 200, {
                ok: true, started: false,
                error: '「一轮最多动几条」是 0 —— 这样一轮什么都不会做，先去设置里改大',
              })
            }
            const dayCap = Number(cfg.maxActionsPerDay || 0)
            const left = dayCap <= 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, dayCap - d.actions)
            if (left <= 0) {
              return sendJson(res, 200, {
                ok: true, started: false,
                error: `今天已经动了 ${d.actions} 次，到上限了（${cfg.maxActionsPerDay}）`,
              })
            }
            // 后台跑，立刻返回（面板靠轮询看进度）
            runOnce('manual').catch((e) => log('run crashed: ' + String(e?.message ?? e)))
            return sendJson(res, 200, { ok: true, started: true, quotaLeft: left })
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
              const r = await runPy(pyCtx(loadConfig(home)), ['login'], { timeout: 40_000 })
              if (!r?.ok) return sendJson(res, 200, { ok: false, error: r?.error || '生成二维码失败' })
              rt.loginKey = String(r.qrcodeKey || '')
              // ⚠️ key 落盘：只放内存的话，DSH 一重启（热重载不算）就丢了，
              //    用户扫的码还在有效期内，插件却已经不知道这张码是谁 ⇒ 永远 poll 不动。
              try { writeJson(join(home, 'login.json'), { qrcodeKey: rt.loginKey, at: Date.now() }) } catch { /* ignore */ }
              rt.loginAt = Date.now()
              rt.loginState = 'scan'
              rt.loginPolls = 0
              startLoginWatcher()   // ← 宿主自己盯着，不再依赖前端一直开着
              // 宿主自己落一份二维码，命令行/排查时能直接看
              try {
                const b64 = String(r.image || '').replace(/^data:image\/png;base64,/, '')
                if (b64) writeFileSync(join(home, 'qr.png'), Buffer.from(b64, 'base64'))
              } catch { /* 存不下来不影响主流程 */ }
              return sendJson(res, 200, r)
            } finally {
              rt.loginBusy = false
            }
          }

          if (req.method === 'GET' && p === '/login/poll') {
            // ⚠️ 兜底：如果内存里的 key 空了（DSH 重启过、或请求打到另一个实例），
            //    先从盘里的 login.json 捞回来 —— 不然你手机上已经点了确认，
            //    插件却回一句「还没生成二维码」，登录永远完成不了。
            if (!rt.loginKey) {
              try {
                const saved = readJson(join(home, 'login.json'), {})
                if (saved && saved.qrcodeKey && Date.now() - Number(saved.at || 0) < 290_000) {
                  rt.loginKey = String(saved.qrcodeKey)
                  rt.loginAt = Number(saved.at) || Date.now()
                  log('loginKey 从盘里恢复')
                }
              } catch { /* ignore */ }
            }
            if (!rt.loginKey) {
              return sendJson(res, 200, { ok: true, done: false, state: 'none', hint: '还没生成二维码，点一下「扫码登录」' })
            }
            const r = await runPy(pyCtx(loadConfig(home)), ['login-poll', '--key', rt.loginKey], { timeout: 40_000 })
              .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))

            if (r?.done && r.credential) {
              // 凭证由宿主写盘
              try {
                ensureHome(home)
                writeJson(join(home, 'credential.json'), r.credential)
              } catch (e) {
                log('写凭证失败: ' + String(e?.message ?? e))
                return sendJson(res, 200, { ok: false, error: '登录成功但存不下凭证：' + String(e?.message ?? e) })
              }
              try { unlinkSync(join(home, 'qr.png')) } catch { /* 没有就算了 */ }
              try { unlinkSync(join(home, 'login.json')) } catch { /* 没有就算了 */ }
              rt.loginKey = ''
              rt.loginAt = 0
              appendLive(home, '阶段', `登录成功：${r.name || r.uid || ''}`)
              log(`login ok uid=${r.uid} name=${r.name}`)
              const { credential, ...rest } = r
              return sendJson(res, 200, rest)
            }
            if (r?.state === 'done' || r?.state === 'timeout') rt.loginKey = ''
            return sendJson(res, 200, r)
          }

          // 重新进设置时，如果还有一张没扫完的码，把它还给前端
          // （否则用户切走再回来只能看到「扫码登录」按钮，以为又要重扫）
          if (req.method === 'GET' && p === '/login/pending') {
            const pending = (() => {
              try {
                const saved = readJson(join(home, 'login.json'), {})
                if (!saved || !saved.qrcodeKey) return null
                const age = Date.now() - Number(saved.at || 0)
                if (age > 170_000) return null
                return { key: String(saved.qrcodeKey), ageSec: Math.round(age / 1000) }
              } catch { return null }
            })()
            if (!pending) return sendJson(res, 200, { ok: true, pending: false })
            let image = ''
            try {
              const buf = readFileSync(join(home, 'qr.png'))
              image = 'data:image/png;base64,' + buf.toString('base64')
            } catch { /* 图没了就只有状态 */ }
            return sendJson(res, 200, {
              ok: true, pending: true, image,
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
  try {
    if (ctx.jobs) {
      ctx.effect(() => ctx.jobs.attachController(name))
      ctx.jobs.start({
        kind: 'bili-interactor',
        label: 'B站互动',
        run: () => {
          let resolveDone
          const done = new Promise((r) => { resolveDone = r })
          // 这个 job 只是"常驻挂个名字"，真正的一轮由 /run 触发
          return {
            cancel: () => resolveDone({ status: 'killed' }),
            done,
            readOutput: () => {
              const t = readFileSync(logFile(home), 'utf8')
              return t.split(/\r?\n/).slice(-20).join('\n')
            },
          }
        },
      })
    }
  } catch (e) {
    log('job 没挂上：' + String(e?.message ?? e))
  }

  log(`loaded v${VERSION} home=${home} python=${resolvePython(loadConfig(home))}`)
}
