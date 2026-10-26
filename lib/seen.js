/**
 * lib/seen.js —— 记下「哪些视频已经刷过」，避免反复刷同一条。
 * ============================================================================
 * 为什么要它：以前每一轮都重新搜，同一批热门视频会一遍遍出现，用户看到的
 * 永远是那几条，等于白刷。这里把刷过的 BV 号存下来，下次搜索直接过滤掉。
 *
 * 存 ~/.dsh/bili-interactor/seen.json：
 *   { "v": { "BV1xxx": "2026-10-26T20:00:00.000Z", ... }, "at": "..." }
 * 用对象而不是数组，是为了能按时间去重、也能显示「什么时候刷过」。
 *
 * 为什么要设上限：天天刷，一年下来能攒几千条。留最近 3000 条足够用，
 * 再老的就算刷过也早该允许重刷了。
 */
import { join } from 'node:path'
import { readJson, writeJson, ensureHome } from './state.js'

const MAX_KEEP = 3000

export const seenFile = (home) => join(home, 'seen.json')

/** 读成 Map<bvid, iso> */
export function readSeen(home) {
  const raw = readJson(seenFile(home), null)
  const v = raw && typeof raw.v === 'object' && raw.v ? raw.v : {}
  const out = new Map()
  for (const [k, t] of Object.entries(v)) {
    if (k) out.set(String(k), String(t || ''))
  }
  return out
}

/** 记一条（已存在就更新时间） */
export function markSeen(home, bvid) {
  const b = String(bvid || '').trim()
  if (!b) return false
  try {
    ensureHome(home)
    const m = readSeen(home)
    m.set(b, new Date().toISOString())
    // 超了就砍最老的
    if (m.size > MAX_KEEP) {
      const sorted = [...m.entries()].sort((a, b2) => String(a[1]).localeCompare(String(b2[1])))
      for (const [k] of sorted.slice(0, m.size - MAX_KEEP)) m.delete(k)
    }
    return writeJson(seenFile(home), { v: Object.fromEntries(m), at: new Date().toISOString() })
  } catch {
    return false
  }
}

/** 批量记 */
export function markSeenMany(home, bvids) {
  const list = (bvids || []).map((x) => String(x || '').trim()).filter(Boolean)
  if (!list.length) return 0
  try {
    ensureHome(home)
    const m = readSeen(home)
    const now = new Date().toISOString()
    for (const b of list) m.set(b, now)
    if (m.size > MAX_KEEP) {
      const sorted = [...m.entries()].sort((a, b2) => String(a[1]).localeCompare(String(b2[1])))
      for (const [k] of sorted.slice(0, m.size - MAX_KEEP)) m.delete(k)
    }
    writeJson(seenFile(home), { v: Object.fromEntries(m), at: now })
    return list.length
  } catch {
    return 0
  }
}

/** 清空（用户想重新刷同一批时可以清） */
export function clearSeen(home) {
  try {
    ensureHome(home)
    return writeJson(seenFile(home), { v: {}, at: new Date().toISOString() })
  } catch {
    return false
  }
}

/** 看某条刷过没有 */
export function hasSeen(home, bvid) {
  return readSeen(home).has(String(bvid || ''))
}
