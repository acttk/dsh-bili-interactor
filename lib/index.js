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
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildState, loadConfig, saveConfig, ensureHome, homeDir,
  appendLedger, bumpDaily, readDaily, flog, readLive,
  liveFile, ledgerFile, logFile, dayKey,
} from './state.js'
import { runPy, prefilter, pickTargets, describeAction } from './targets.js'
import { makeDanmaku } from './danmaku.js'

export const name = 'bili-interactor'
export const inject = ['webServer']

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
  const rt = {
    running: false,
    phase: '',
    startedAt: 0,
    finishedAt: 0,
    error: '',
    progress: { index: 0, total: 0, currentBvid: '', currentTitle: '' },
    lastResult: null,
    stopRequested: false,
  }

  const log = (m) => flog(home, m)

  ctx.effect(() => () => { rt.stopRequested = true }, 'bili-interactor: 收摊')

  /* 每轮真正干的活 */
  async function runOnce(trigger = 'manual') {
    if (rt.running) return { started: false, busy: true, error: '上一轮还没跑完' }

    const cfg = loadConfig(home)
    if (!cfg.enabled) return { started: false, error: '插件是关着的（设置里打开 "启用"）' }

    const daily = readDaily(home)
    const quota = Math.max(0, Number(cfg.maxActionsPerDay || 0) - daily.actions)
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

    const pc = {
      python: resolvePython(cfg),
      script: PY_SCRIPT,
      cwd: home,
      credHome: process.env.DSH_HOME ? join(process.env.DSH_HOME, 'bili-duty') : join(process.env.USERPROFILE || '', '.dsh', 'bili-duty'),
    }

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

        // 视频之间歇一下
        if (i < targets.length - 1) {
          await new Promise((res) => setTimeout(res, 2000 + Math.random() * 4000))
        }
      }

      rt.phase = ''
      const msg = `动了 ${summary.done} 次，失败 ${summary.failed} 次`
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

  const stateNow = () => {
    const s = buildState(home, { version: VERSION })
    return { ...s, run: { ...rt } }
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-interactor',
      handler: async (req, res) => {
        if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
        const p = String(req.url || '/').split('?')[0].replace(/^\/api\/bili-interactor/, '') || '/'
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
            const cfg = loadConfig(home)
            if (!cfg.enabled) return sendJson(res, 200, { ok: true, started: false, error: '插件是关着的（设置里打开「启用」）' })
            const d = readDaily(home)
            const left = Math.max(0, Number(cfg.maxActionsPerDay || 0) - d.actions)
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
            const cfg = loadConfig(home)
            const pc = {
              python: resolvePython(cfg), script: PY_SCRIPT, cwd: home,
              credHome: process.env.DSH_HOME ? join(process.env.DSH_HOME, 'bili-duty') : join(process.env.USERPROFILE || '', '.dsh', 'bili-duty'),
            }
            const r = await runPy(pc, ['whoami'], { timeout: 30_000 }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
            return sendJson(res, 200, r)
          }

          if (req.method === 'POST' && p === '/search') {
            const body = await readBody(req)
            const kw = String(body.keyword || '').trim()
            if (!kw) return sendJson(res, 400, { ok: false, error: 'keyword 必填' })
            const cfg = loadConfig(home)
            const pc = {
              python: resolvePython(cfg), script: PY_SCRIPT, cwd: home,
              credHome: process.env.DSH_HOME ? join(process.env.DSH_HOME, 'bili-duty') : join(process.env.USERPROFILE || '', '.dsh', 'bili-duty'),
            }
            const r = await runPy(pc, ['search', '--keyword', kw, '--order', String(body.order || cfg.order), '--limit', String(body.limit || 12)], { timeout: 60_000 })
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
    }), 'bili-interactor: /api/bili-interactor 路由')
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
