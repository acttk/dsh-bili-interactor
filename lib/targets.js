/**
 * 找视频 + 挑该动哪几条
 * ============================================================================
 * 这里是"选谁"的策略层，跟"怎么点"（py/interact.py）分开。
 * 策略刻意写得保守：宁可少动，不要乱动 —— 这是别人的账号。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** 跑一次 py/interact.py，解析它吐的 JSON */
export async function runPy(ctx, args, { timeout = 90_000 } = {}) {
  const { script, python, cwd } = ctx
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    BILI_DUTY_HOME: ctx.credHome || '',
    // ⭐ 让 python 把凭证写进本插件自己的家（ctx.env 由调用方传）
    ...(ctx.env || {}),
  }
  const { stdout } = await execFileP(python, [script, ...args], {
    cwd,
    env,
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  // 可能有多行（run 系列是 NDJSON），JSON 对象取最后一行；login 那类就一行
  const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean)
  const line = lines[lines.length - 1]
  if (!line) throw new Error('python 没有输出')
  try {
    return JSON.parse(line)
  } catch {
    throw new Error('python 输出不是 JSON：' + line.slice(0, 200))
  }
}

const now = () => Math.floor(Date.now() / 1000)

/** 粗筛：播放量、关键词、时长 */
export function prefilter(items, cfg) {
  const skip = (cfg.skipKeywords || []).map((s) => String(s))
  const hitSkip = (s) => skip.some((k) => k && s.includes(k))
  // 统计被哪个条件拒掉，空手时才能跟用户说清楚
  const rejected = { noId: 0, skip: 0, play: 0, old: 0 }
  const kept = []
  for (const v of items || []) {
    if (!v.bvid) { rejected.noId++; continue }
    const text = (v.title || '') + ' ' + (v.up || '')
    if (hitSkip(text)) { rejected.skip++; continue }
    if (Number(v.play || 0) < Number(cfg.minPlay || 0)) { rejected.play++; continue }
    if (cfg.daysBack > 0 && v.pubdate && now() - Number(v.pubdate) > cfg.daysBack * 86400) { rejected.old++; continue }
    kept.push(v)
  }
  return { kept, rejected }
}

/**
 * 从候选里挑出这一轮要动的，遵守：
 *   · 总量不超过 quota（今日剩余）
 *   · 同一 UP 不超过 maxPerUpPerRun
 *   · 打散关键词，不要一头扎进同一个词
 */
export function pickTargets(pool, cfg, quota) {
  // maxActionsPerRun 为 0 时视为「不限」，只受当日剩余额度约束
  const perRun = Number(cfg.maxActionsPerRun || 0)
  const cap = Math.max(0, perRun > 0 ? Math.min(perRun, quota) : quota)
  if (cap === 0) return []

  const perUp = {}
  const picked = []
  const usedBv = new Set()

  // 先按关键词轮转，每个词取一条，再循环
  const byKeyword = new Map()
  for (const v of pool) {
    const k = v.__kw || ''
    if (!byKeyword.has(k)) byKeyword.set(k, [])
    byKeyword.get(k).push(v)
  }

  let cursor = 0
  const limitLoops = 200
  while (picked.length < cap && cursor < limitLoops) {
    let added = false
    for (const list of byKeyword.values()) {
      if (picked.length >= cap) break
      const v = list.shift()
      if (!v) continue
      if (usedBv.has(v.bvid)) continue
      const up = v.up || ''
      if (up && (perUp[up] || 0) >= Number(cfg.maxPerUpPerRun || 99)) continue
      usedBv.add(v.bvid)
      if (up) perUp[up] = (perUp[up] || 0) + 1
      picked.push(v)
      added = true
    }
    cursor++
    if (!added) break
  }

  return picked
}

export function describeAction(cfg) {
  const parts = []
  if (cfg.doLike) parts.push('点赞')
  if (cfg.doCoin) parts.push('投币' + (cfg.coinPerVideo > 1 ? '×' + cfg.coinPerVideo : ''))
  if (cfg.doFavorite) parts.push('收藏')
  if (cfg.doDanmaku) parts.push('弹幕')
  if (cfg.doFollow) parts.push('关注')
  return parts.length ? parts.join(' + ') : '（什么都没开）'
}
