/**
 * lib/ignore.js —— 不想再搭理的人
 * ============================================================================
 * ⚠️ 这不是「拉黑」。不做任何 B站 层面的拉黑/屏蔽，对方照样能评论、能 @、
 * 能看到我的旧评论 —— 只是插件自己以后不再回复他。纯本地记录，不联网。
 *
 * 用途：大肥鱼跟某个人在同一个视频下面来回聊了太多轮，触发「审查」后
 * 判定这段对话没营养（对方不像真人、或者纯粹两个 AI 互刷），就发最后一句
 * 表明不再聊，然后把这个人记下来 —— 之后他再 @、再说话，都不回复。
 *
 * 作用域：(bvid, uid) —— 按视频算。同一个视频里他烦过我，
 * 换个视频我心情好还是可以理他。
 *
 * 存储：~/.dsh/bili-interactor/ignored.json
 *   { "BVxxx#12345": { bvid, uid, uname, at, rounds, reason } }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ignoredFile = (home) => join(home, 'ignored.json')

const keyOf = (bvid, uid) => String(bvid || '') + '#' + String(uid || '')

export function readIgnored(home) {
  const f = ignoredFile(home)
  if (!existsSync(f)) return {}
  try {
    const o = JSON.parse(String(readFileSync(f, 'utf8') || '{}'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

function writeIgnored(home, map) {
  try {
    mkdirSync(dirname(ignoredFile(home)), { recursive: true })
    writeFileSync(ignoredFile(home), JSON.stringify(map, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 这个人在这个视频下，我是不是已经不想理了 */
export function isIgnored(home, bvid, uid) {
  if (!bvid || !uid) return null
  const map = readIgnored(home)
  return map[keyOf(bvid, uid)] || null
}

/** 记下来。rounds = 聊了多少轮才决定不聊的 */
export function addIgnored(home, { bvid, uid, uname, rounds, reason }) {
  if (!bvid || !uid) return false
  const map = readIgnored(home)
  map[keyOf(bvid, uid)] = {
    bvid: String(bvid),
    uid: String(uid),
    uname: String(uname || '').slice(0, 40),
    at: new Date().toISOString(),
    rounds: Number(rounds) || 0,
    reason: String(reason || '').slice(0, 120),
  }
  return writeIgnored(home, map)
}

export function removeIgnored(home, bvid, uid) {
  const map = readIgnored(home)
  const k = keyOf(bvid, uid)
  if (!map[k]) return false
  delete map[k]
  return writeIgnored(home, map)
}

export function clearIgnored(home) {
  return writeIgnored(home, {})
}

/**
 * 数一数我在这个视频下、跟这个人来回聊了多少轮。
 * 只算成功的、真正发出去的那几条（ok === true）。
 */
export function countRounds(ledger, bvid, uid) {
  if (!bvid || !uid) return 0
  let n = 0
  for (const r of ledger || []) {
    if (!r || r.ok !== true) continue
    if (r.kind !== 'replyback' && r.kind !== 'reply') continue
    if (String(r.bvid || '') !== String(bvid)) continue
    if (String(r.toUid || '') !== String(uid)) continue
    n++
  }
  return n
}
