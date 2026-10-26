/**
 * lib/learn.js —— 大肥鱼的「写作规律本」
 * ============================================================================
 * ⚠️ 这一版重构过语义，因为旧设计方向错了：
 *
 *   旧设计：从评论区抄「说得好的原句」，下次直接塞进提示词。
 *           结果它只会模仿别人的句子，写出缝合怪 —— 记的是「别人说了什么」。
 *
 *   新设计：记的是**规律**，不是句子。两类：
 *     kind='rule'  写作准则 —— 可执行的动作，例如
 *                  「先给反应再给理由：先说笑死，再补为什么好笑」
 *                  这是它真正能变「有活人味」的东西。
 *     kind='quote' 例句 —— 只用来感受语感，明确禁止照抄。
 *
 * 存储：~/.dsh/bili-interactor/learned.jsonl（一行一条，只追加）
 * 旧数据没有 kind 字段，读的时候一律按 'quote' 处理（它们是抄来的原句）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const learnedFile = (home) => join(home, 'learned.jsonl')

/** 读全部（坏行跳过，不因为一行脏数据整个坏掉） */
export function readLearned(home) {
  const f = learnedFile(home)
  if (!existsSync(f)) return []
  const out = []
  for (const line of String(readFileSync(f, 'utf8') || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (!o) continue
      // 兼容旧数据：没有 kind 的，都是当年抄来的原句
      const kind = o.kind === 'rule' ? 'rule' : 'quote'
      const text = kind === 'rule' ? (o.rule || o.text || '') : (o.text || o.rule || '')
      if (!text) continue
      out.push({ ...o, kind, rule: kind === 'rule' ? String(text) : '', text: String(text) })
    } catch { /* 跳过坏行 */ }
  }
  return out
}

/** 追加一条。kind='rule' 存准则，kind='quote' 存例句 */
export function addLearned(home, entry) {
  try {
    mkdirSync(dirname(learnedFile(home)), { recursive: true })
    const kind = entry.kind === 'rule' ? 'rule' : 'quote'
    const text = String(kind === 'rule' ? (entry.rule || entry.text || '') : (entry.text || entry.rule || '')).trim()
    if (!text) return false

    // 准则去重：同一条准则不重复记，改成加分（越被反复验证越可信）
    if (kind === 'rule') {
      const all = readLearned(home)
      const key = norm(text)
      const hit = all.find((e) => e.kind === 'rule' && norm(e.text) === key)
      if (hit) {
        const next = all.map((e) => (e === hit ? { ...e, score: Math.min(10, Number(e.score || 0) + 1), at: new Date().toISOString() } : e))
        writeFileSync(learnedFile(home), next.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
        return true
      }
    }

    appendFileSync(
      learnedFile(home),
      JSON.stringify({
        at: new Date().toISOString(),
        kind,
        text: text.slice(0, 500),
        rule: kind === 'rule' ? text.slice(0, 500) : '',
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

/** 归一化，用于去重（去掉空白和标点差异） */
function norm(s) {
  return String(s || '').replace(/[\s，。、！？；：""''（）()…—~～·,.\-_!?;:'"]/g, '')
}

/**
 * 挑给模型看的内容：准则优先，例句少量点缀。
 * 返回 [{kind, text, rule, why, score}]，准则在前。
 */
export function pickLearned(home, limit = 8) {
  const all = readLearned(home)
  if (!all.length || limit <= 0) return []

  const rank = (list) =>
    list
      .slice()
      .sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)) || ((Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)))

  const rules = rank(all.filter((e) => e.kind === 'rule'))
  const quotes = rank(all.filter((e) => e.kind !== 'rule'))

  // 准则占大头；例句最多 2 条，只用来感受语感
  const maxQuotes = Math.min(2, Math.floor(limit / 3))
  const out = [...rules.slice(0, Math.max(0, limit - maxQuotes)), ...quotes.slice(0, maxQuotes)]

  // 兜底：如果一条准则都没有（老数据），至少给几条例句，别让记忆空着
  if (!rules.length && quotes.length) return quotes.slice(0, limit)
  return out
}

/** 只取准则（给「我学到了什么」这类展示用） */
export function pickRules(home, limit = 20) {
  return readLearned(home)
    .filter((e) => e.kind === 'rule')
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit)
}

/**
 * 总量保护：超过 max 条就清一部分。
 * ⚠️ 准则和例句要分开算 —— 准则稀缺且值钱，例句是消耗品，
 *    不能因为例句攒太多把准则挤掉。
 */
export function pruneLearned(home, max = 400) {
  const all = readLearned(home)
  if (all.length <= max) return 0
  const rules = all.filter((e) => e.kind === 'rule')
  const quotes = all.filter((e) => e.kind !== 'rule')
  const keepRules = Math.max(0, Math.min(rules.length, Math.ceil(max / 2)))
  const keepQuotes = Math.max(0, max - keepRules)

  const sortedRules = rules.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, keepRules)
  const sortedQuotes = quotes
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, keepQuotes)

  const keep = [...sortedRules, ...sortedQuotes]
  try {
    writeFileSync(learnedFile(home), keep.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  } catch {
    return 0
  }
  return all.length - keep.length
}
