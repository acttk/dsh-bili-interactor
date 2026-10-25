/**
 * dsh-bili-interactor —— 数据层
 * ============================================================================
 * 只做三件事：读配置、读账本、把「今天干了什么」整理成面板要的样子。
 *
 * 家目录默认 ~/.dsh/bili-interactor，里面：
 *   config.json       配置（开关、限额、口味）
 *   ledger.jsonl      一行一次互动（append-only，好查好删）
 *   daily.json        当日计数（限额用）
 *   interact.log      运行日志
 *   live.md           过程实录（这一轮在干什么，中文，面板直接读）
 *
 * ⚠️ 这里不碰 B站 接口 —— 那是 py/interact.py 的活，两边靠 JSON 对话。
 */
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const pad = (n) => String(n).padStart(2, '0')
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export const readText = (f) => { try { return readFileSync(f, 'utf8').replace(/^\uFEFF/, '') } catch { return '' } }
export const readJson = (f, d) => { try { return JSON.parse(readText(f)) } catch { return d } }
export const exists = (f) => { try { return existsSync(f) } catch { return false } }

export function writeJson(f, obj) {
  try { writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); return true } catch { return false }
}

export function homeDir(config = {}) {
  return config.home ?? process.env.BILI_INTERACTOR_HOME ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'bili-interactor')
}

export function ensureHome(home) {
  try { mkdirSync(home, { recursive: true }) } catch { /* 已经在了 */ }
  return home
}

export const logFile = (home) => join(home, 'interact.log')
export const ledgerFile = (home) => join(home, 'ledger.jsonl')
export const configFile = (home) => join(home, 'config.json')
export const dailyFile = (home) => join(home, 'daily.json')
export const liveFile = (home) => join(home, 'live.md')

export function flog(home, msg) {
  try {
    ensureHome(home)
    appendFileSync(logFile(home), `${new Date().toISOString()}  ${msg}\n`, 'utf8')
  } catch { /* 写不进去就算了 */ }
}

/* ────────────────────────── 配置 ────────────────────────── */

export const DEFAULT_CONFIG = {
  enabled: true,
  // 一次跑多久、跑多少条（这两个是**上限**，用户想改多大都行）
  maxActionsPerRun: 20,
  maxActionsPerDay: 120,
  // 要做什么（可按需关掉某一类）
  doLike: true,
  doCoin: true,
  coinPerVideo: 1,
  doFavorite: false,
  favoriteId: 0,            // 收藏夹 ID（0 = 没设，收藏开关打开也不会收藏）
  doDanmaku: true,
  doFollow: false,
  // ── 评论（这是重点：评论区留话 + @ 你）──
  doComment: true,             // 在视频下发顶层评论
  doReplyComment: true,        // 回复别人在评论区说的话
  mentionUid: 0,               // @ 谁（填 UID，插件会反查昵称）—— 0 = 不 @
  replyCount: 2,               // 每条视频最多回几条别人的评论
  commentPersona: '',          // 评论区语气（留空就用下面的人设）
  // ── 私信（默认关：发出去收不回）──
  doDm: false,
  dmUid: 0,                    // 私信发给谁（填 UID）
  dmOnComment: true,           // 评论成功后才发私信（doDm 打开时才生效）
  // ── 人设：随便写多长，不截断 ──
  persona: '像一个普通的 B站 用户，看完了随手点个赞、投个币，偶尔说句话。不热情，不写小作文。',
  // 口味：从哪找视频
  keywords: ['恐怖游戏', '游戏解说'],
  order: 'click',           // click=按播放 / pubdate=按最新 / totalrank=综合
  daysBack: 7,
  minPlay: 1000,            // 播放量低于这个不碰
  // 风控
  actionIntervalMs: [1500, 4000],   // 两次动作之间随机等
  maxPerUpPerRun: 2,                // 同一个 UP 最多碰几条
  skipKeywords: ['抽奖', '广告', '加群', '微信', 'QQ', '代练', '私聊', '刷单', '加V'],
  // 弹幕
  danmakuStyle: '像真人随手发的，短，6~20 字，不评价视频质量，不刷屏',

  // ── 有人回我 → 我主动回（后台监听）──
  doReplyBack: true,          // 开不开「别人回了我，我去回他」
  replyBackMax: 0,            // 每条评论下最多回几句：0 = 不限
  replyBackPerDay: 0,         // 一天最多回几条：0 = 不限（默认不限，由用户自己定）
  listenIntervalMin: 1,       // 每多少分钟去查一次（最小 1）
  listenMaxThreadsPerTick: 15, // 每次检查最多看几条「我发过的评论」（多了轮流，别一次全查）
  listenLookbackHours: 72,    // 只看最近多少小时内我发的评论
  replyBackMinLen: 2,         // 对方回复少于这个字数就不理（过滤"顶""1"这种）

  // ── 学习：把有价值的评论/互动存下来，以后回复时带上 ──
  doLearn: true,              // 开不开学习
  learnPerRun: 3,             // 一轮最多记几条
  learnUseCount: 8,           // 生成评论/回复时带几条记忆进去
  // 用户自己定的「什么才值得记」——会原样塞进模型的判断提示词里
  learnPrompt: '只记有信息量或有观点的：具体事实、真实经历、站得住的分析、用得妙的说法。' +
    '不记纯情绪（笑死、哈哈）、复读（1、cy、3）、求关注、广告、人身攻击。',
  learnMinScore: 6,           // 低于这个分数不记（0~10）
}

export function loadConfig(home) {
  const raw = readJson(configFile(home), {})
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  // 数组类字段：写坏了就退回默认，别让面板崩
  if (!Array.isArray(cfg.keywords) || cfg.keywords.length === 0) cfg.keywords = DEFAULT_CONFIG.keywords.slice()
  if (!Array.isArray(cfg.skipKeywords)) cfg.skipKeywords = DEFAULT_CONFIG.skipKeywords.slice()
  if (!Array.isArray(cfg.actionIntervalMs) || cfg.actionIntervalMs.length !== 2) cfg.actionIntervalMs = DEFAULT_CONFIG.actionIntervalMs.slice()
  return cfg
}

export function saveConfig(home, patch) {
  const cur = loadConfig(home)
  const next = { ...cur, ...(patch || {}) }
  ensureHome(home)
  writeJson(configFile(home), next)
  return next
}

/* ────────────────────────── 账本 ────────────────────────── */

export function readLedger(home, limit = 400) {
  const txt = readText(ledgerFile(home))
  if (!txt) return []
  const rows = []
  for (const line of txt.split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    try {
      const j = JSON.parse(l)
      if (j && typeof j === 'object') rows.push(j)
    } catch { /* 坏行跳过 */ }
  }
  return rows.slice(-limit)
}

export function appendLedger(home, row) {
  try {
    ensureHome(home)
    appendFileSync(ledgerFile(home), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n', 'utf8')
    return true
  } catch { return false }
}

/* ────────────────────────── 当日额度 ────────────────────────── */

export function readDaily(home) {
  const d = readJson(dailyFile(home), {})
  const today = dayKey()
  if (!d || d.day !== today) return { day: today, actions: 0, coins: 0, byType: {} }
  return { day: today, actions: Number(d.actions || 0), coins: Number(d.coins || 0), byType: d.byType || {} }
}

export function bumpDaily(home, kind, coins = 0, opts = {}) {
  const d = readDaily(home)
  // opts.countAction === false：只记类型，不算进「今日动作数」。
  // 监听器回别人的评论用这个 —— 它有自己独立的每日上限（replyBackPerDay），
  // 不该把 maxActionsPerDay 顶满、把用户手动「跑一轮」挤掉。
  if (opts.countAction !== false) d.actions += 1
  d.coins += coins
  d.byType[kind] = (d.byType[kind] || 0) + 1
  writeJson(dailyFile(home), d)
  return d
}

/* ────────────────────────── 过程实录 ────────────────────────── */

const LIVE_TAGS = new Set(['阶段', '思考', '候选', '挑中', '动作', '跳过', '小结', '失败'])

export function readLive(home) {
  const txt = readText(liveFile(home))
  const lines = []
  const stats = { acting: 0, skipped: 0, cand: 0 }
  for (const raw of txt.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l) continue
    const m = /^【([^】]+)】\s*(.*)$/.exec(l)
    const tag = m ? m[1].trim() : ''
    const text = m ? m[2].trim() : l
    lines.push({ tag, text })
    if (tag === '动作') stats.acting++
    else if (tag === '跳过') stats.skipped++
    else if (tag === '候选') stats.cand++
  }
  let mtime = ''
  try { mtime = statSync(liveFile(home)).mtime.toISOString() } catch { /* 没有 */ }
  return { exists: lines.length > 0, mtime, lines, stats, knownTags: [...LIVE_TAGS] }
}

export function clearLive(home) {
  try { ensureHome(home); writeFileSync(liveFile(home), '', 'utf8'); return true } catch { return false }
}

/* ────────────────────────── 汇总给面板 ────────────────────────── */

export function buildState(home, opts = {}) {
  const cfg = loadConfig(home)
  const daily = readDaily(home)
  const ledger = readLedger(home, 400)
  const today = dayKey()

  const todayRows = ledger.filter((r) => String(r.ts || '').startsWith(today))
  // 最近 40 条动作，新的在前
  const recent = ledger.slice(-40).reverse()

  const byType = {}
  for (const r of todayRows) {
    const k = r.kind || 'other'
    byType[k] = (byType[k] || 0) + 1
  }

  // 今天碰过的视频（去重）
  // ⚠️ 以前只给「动作类型的字符串数组」，界面除了堆一排标签什么都做不了，
  //    而标签又不换行，12 条视频能把整行撑出容器 → 横向滚动条。
  //    现在把「这条视频我干了什么、说过什么、什么时候最后一次动」一起算好，
  //    界面才有的可显示。
  const TALK_KINDS = ['comment', 'reply', 'replyback', 'dm']
  const videos = []
  const seen = new Set()
  for (const r of todayRows) {
    if (!r.bvid || seen.has(r.bvid)) continue
    seen.add(r.bvid)
    const rowsOf = todayRows.filter((x) => x.bvid === r.bvid)
    const talkRows = rowsOf.filter((x) => TALK_KINDS.includes(x.kind))
    const withRpid = talkRows.filter((x) => x.rpid)
    const talk = withRpid.slice(-1)[0]

    // 每种动作几次
    const counts = {}
    for (const x of rowsOf) {
      if (!x.kind) continue
      counts[x.kind] = (counts[x.kind] || 0) + 1
    }
    // 最近 3 条说过的话（新→旧），带上能否直达
    const sayings = talkRows
      .slice(-3)
      .reverse()
      .filter((x) => x.text)
      .map((x) => ({
        kind: x.kind,
        text: String(x.text).slice(0, 300),
        toName: x.toName || '',
        ok: x.ok !== false,
        rpid: x.rpid ? String(x.rpid) : '',
        jump: x.rpid ? String(x.root || x.rpid) : '',
      }))

    videos.push({
      bvid: r.bvid,
      title: r.title || '',
      up: r.up || '',
      url: 'https://www.bilibili.com/video/' + r.bvid,
      // 有 root 就跳 root，子评论 rpid 锚点跳不过去
      lastRpid: talk ? String(talk.root || talk.rpid) : '',
      lastKind: talk ? talk.kind : '',
      lastTs: rowsOf.length ? String(rowsOf[rowsOf.length - 1].ts || '') : '',
      counts,
      total: rowsOf.length,
      talkTotal: talkRows.length,
      sayings,
      // 兼容旧字段（别的地方可能还在读）
      acts: rowsOf.map((x) => x.kind).filter(Boolean),
    })
  }
  // 最近动过的排前面，比「按第一次碰到的顺序」有用
  videos.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)))

  let logMtime = ''
  try { logMtime = statSync(logFile(home)).mtime.toISOString() } catch { /* 没有 */ }

  return {
    ok: true,
    now: new Date().toISOString(),
    today,
    home,
    version: opts.version || '',
    config: {
      enabled: cfg.enabled,
      doLike: cfg.doLike,
      doCoin: cfg.doCoin,
      coinPerVideo: cfg.coinPerVideo,
      doFavorite: cfg.doFavorite,
      favoriteId: cfg.favoriteId,
      doDanmaku: cfg.doDanmaku,
      doFollow: cfg.doFollow,
      doComment: cfg.doComment,
      doReplyComment: cfg.doReplyComment,
      mentionUid: cfg.mentionUid,
      mentionName: cfg.mentionName || '',      // 反查出来缓存的名字，只读
      replyCount: cfg.replyCount,
      commentPersona: cfg.commentPersona,
      doDm: cfg.doDm,
      dmUid: cfg.dmUid,
      dmOnComment: cfg.dmOnComment,
      maxActionsPerRun: cfg.maxActionsPerRun,
      maxActionsPerDay: cfg.maxActionsPerDay,
      keywords: cfg.keywords,
      order: cfg.order,
      daysBack: cfg.daysBack,
      minPlay: cfg.minPlay,
      persona: cfg.persona,
      danmakuStyle: cfg.danmakuStyle,
      // 回复监听 / 学习记忆（不放进白名单界面就只能看到默认值）
      doReplyBack: cfg.doReplyBack,
      replyBackMax: cfg.replyBackMax,
      replyBackPerDay: cfg.replyBackPerDay,
      listenIntervalMin: cfg.listenIntervalMin,
      listenMaxThreadsPerTick: cfg.listenMaxThreadsPerTick,
      listenLookbackHours: cfg.listenLookbackHours,
      replyBackMinLen: cfg.replyBackMinLen,
      doLearn: cfg.doLearn,
      learnPerRun: cfg.learnPerRun,
      learnUseCount: cfg.learnUseCount,
      learnPrompt: cfg.learnPrompt,
      learnMinScore: cfg.learnMinScore,
      maxPerUpPerRun: cfg.maxPerUpPerRun,
      skipKeywords: cfg.skipKeywords,
      actionIntervalMs: cfg.actionIntervalMs,
      myName: cfg.myName || '',
    },
    quota: {
      today: daily.actions,
      limit: cfg.maxActionsPerDay,
      // 0 = 不限（跟后端 /run 的判断保持一致，别一处说不限、一处说禁止）
      left: Number(cfg.maxActionsPerDay) <= 0
        ? -1
        : Math.max(0, Number(cfg.maxActionsPerDay) - daily.actions),
      unlimited: Number(cfg.maxActionsPerDay) <= 0,
      perRun: Number(cfg.maxActionsPerRun || 0),
      coins: daily.coins,
    },
    today: {
      actions: todayRows.length,
      byType,
      videos: videos.slice(0, 30),
    },
    recent,
    live: readLive(home),
    log: { file: logFile(home), mtime: logMtime },
    files: {
      config: configFile(home),
      ledger: ledgerFile(home),
      live: liveFile(home),
      log: logFile(home),
    },
  }
}
