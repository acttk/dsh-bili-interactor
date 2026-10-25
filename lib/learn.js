/**
 * lib/learn.js —— 大肥鱼的「学习记忆」
 * ============================================================================
 * 它不是训练模型，是**攒一本自己的笔记**：
 *   · 刷到评论区里一句话说得漂亮的，抄下来，顺手写一句"这句好在哪"
 *   · 别人回它的话，如果值得，也记下来
 *   · 下次写评论 / 回别人的时候，把最近最值钱的几条塞进提示词
 *
 * 存储：~/.dsh/bili-interactor/learned.jsonl（一行一条，只追加）
 * 为什么要单独一个文件：跟 ledger 分开 —— ledger 是"我干了什么"，
 * learned 是"我学到了什么"，两件事不该混在一起，也不好按条数淘汰。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const learnedFile = (home) => join(home, 'learned.jsonl')

/** 读全部笔记（坏行跳过，不因为一行脏数据整个坏掉） */
export function readLearned(home) {
  const f = learnedFile(home)
  if (!existsSync(f)) return []
  const out = []
  for (const line of String(readFileSync(f, 'utf8') || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && o.text) out.push(o)
    } catch { /* 跳过坏行 */ }
  }
  return out
}

/** 追加一条笔记 */
export function addLearned(home, entry) {
  try {
    mkdirSync(dirname(learnedFile(home)), { recursive: true })
    appendFileSync(
      learnedFile(home),
      JSON.stringify({
        at: new Date().toISOString(),
        text: String(entry.text || '').slice(0, 500),
        why: String(entry.why || '').slice(0, 300),
        from: String(entry.from || '').slice(0, 80),
        bvid: entry.bvid || '',
        rpid: entry.rpid ? String(entry.rpid) : '',
        score: Number(entry.score || 0),
      }) + '\n',
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/**
 * 挑出要给模型看的那几条：
 * 先按分数，再按新近 —— 但不能全是同一类，所以按 text 去重。
 */
export function pickLearned(home, limit = 8) {
  const all = readLearned(home)
  if (!all.length || limit <= 0) return []
  const scored = all
    .map((e) => ({
      ...e,
      _s: Number(e.score || 0) * 1e12 + (Date.parse(e.at) || 0) / 1e6,
    }))
    .sort((a, b) => b._s - a._s)
  const seen = new Set()
  const out = []
  for (const e of scored) {
    const k = String(e.text).slice(0, 40)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
    if (out.length >= limit) break
  }
  return out
}

/** 总量上限保护：超过 max 条就把分数最低的清掉，别让文件无限涨 */
export function pruneLearned(home, max = 400) {
  const all = readLearned(home)
  if (all.length <= max) return 0
  const keep = all
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, max)
  try {
    writeFileSync(
      learnedFile(home),
      keep.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )
  } catch {
    return 0
  }
  return all.length - keep.length
}
