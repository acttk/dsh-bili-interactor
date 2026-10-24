/**
 * 文本生成 —— 弹幕 / 评论 / 回复别人
 * ============================================================================
 * 有 DeepSeek key 就让模型写，没有就退回模板（模板只保证能发，不保证好听）。
 *
 * 为什么要单独一层：发出去收不回来，写得像机器人比不发更糟。
 * 所以这里要能读视频标题/UP/简介/评论区上下文，让话沾点边。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FALLBACK_DM = [
  '这波可以', '笑死', '有点东西', '???', '绷不住了', '好活',
  '前排', '芜湖', '这就去看看', '意犹未尽', '绝了', '学到了',
]
const FALLBACK_CM = [
  '看完了，还行', '这个真可以', '收藏了', '有点意思',
  '同感', '确实', '哈哈哈', '学到了',
]

/* 从 DSH 凭据里摸一个 DeepSeek key（有就用，没有不报错） */
function findApiKey() {
  try {
    const f = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
    const txt = readFileSync(f, 'utf8')
    if (/DEEPSEEK_API_KEY/.test(txt) && process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
    const m = txt.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/)
    if (m) return m[1]
  } catch { /* 没凭据就算了 */ }
  return process.env.DEEPSEEK_API_KEY || ''
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

async function askLLM(sys, user, { maxTokens = 220, temperature = 1.05 } = {}) {
  const key = findApiKey()
  if (!key) return ''
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return ''
    const j = await res.json()
    return String(j?.choices?.[0]?.message?.content || '').trim()
  } catch {
    return ''
  }
}

/* 人设可以很长（角色卡整段塞进来），这里只做最基本的裁剪保护 */
function personaOf(cfg, kind) {
  const p = kind === 'comment'
    ? (cfg.commentPersona && String(cfg.commentPersona).trim() ? cfg.commentPersona : cfg.persona)
    : cfg.persona
  return String(p || '').trim()
}

/**
 * 生成一条弹幕。短，4~18 字。
 */
export async function makeDanmaku(v, cfg, opt = {}) {
  const persona = personaOf(cfg, 'danmaku')
  const sys = [
    '你在帮一个真人发 B站 弹幕。',
    persona ? '人设（完全照这个人的说话方式来）：\n' + persona : '人设：普通 B站 用户',
    '风格：' + (cfg.danmakuStyle || '短、口语、不评价视频质量'),
    '硬要求：只输出弹幕正文，不要引号、不要解释、不要换行；长度 4~18 个汉字。',
  ].join('\n')
  const user = [
    '视频标题：' + (v.title || ''),
    'UP：' + (v.up || ''),
    v.desc ? '简介：' + String(v.desc).slice(0, 200) : '',
    '写一条弹幕。',
  ].filter(Boolean).join('\n')

  const t = (await askLLM(sys, user, { maxTokens: 40, temperature: 1.1 }))
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/\s+/g, '')
  if (t && t.length <= 24) return { text: t, source: 'llm' }
  return { text: pick(FALLBACK_DM), source: 'template' }
}

/**
 * 生成一条**视频下的顶层评论**（可以带 @）。
 *
 * @param {object} v      {title, up, desc, play, danmaku}
 * @param {object} cfg    配置（persona / commentPersona / mentionName）
 * @param {object} opt    {mentionName}
 * @returns {Promise<{text:string, source:string}>}
 */
export async function makeComment(v, cfg, opt = {}) {
  const persona = personaOf(cfg, 'comment')
  const mention = String(opt.mentionName || cfg.mentionName || '').trim()

  const sys = [
    '你在帮一个真人，在 B站 视频评论区留一条**普通用户的评论**。',
    persona ? '你的人设（完全照这个人的说话方式来，不要偏移）：\n' + persona : '人设：普通 B站 用户',
    '',
    '硬要求：',
    '· 只输出评论正文，不要引号、不要解释、不要 markdown、不要写"以下是我的评论"。',
    '· 可以 1~3 句，长短随内容；像人，不像 AI；不要客套、不要"首先其次"。',
    '· 不要复述标题，不要假装看过全部内容；可以就标题/UP/简介说一句实在话。',
    '· 不要带话题标签、不要带链接、不要求关注。',
  ].join('\n')

  const user = [
    '视频标题：' + (v.title || ''),
    'UP 主：' + (v.up || ''),
    v.desc ? '简介：' + String(v.desc).slice(0, 300) : '',
    Number(v.play) ? '播放量：' + v.play : '',
    mention ? `结尾要 @ 一个叫「${mention}」的人（就写 @${mention}），除此之外别 @ 别人。` : '',
    '写这条评论。',
  ].filter(Boolean).join('\n')

  let t = await askLLM(sys, user, { maxTokens: 260, temperature: 1.0 })
  t = t.replace(/^["'「『]+|["'」』]+$/g, '').trim()

  const source = t ? 'llm' : 'template'
  if (!t) t = pick(FALLBACK_CM)
  // B站 评论正文上限 1000 字，但我们不主动写长；超了才截
  if (t.length > 800) t = t.slice(0, 800)

  // @ 交给调用方拼（宿主统一处理，避免模型把 @ 写歪）
  return { text: t, source }
}

/**
 * 回复别人的评论。
 * @param {object} v      视频信息
 * @param {object} c      原评论 {uname, content}
 * @param {object} cfg    配置
 */
export async function makeReply(v, c, cfg) {
  const persona = personaOf(cfg, 'comment')
  const sys = [
    '你在帮一个真人在 B站 评论区回别人的话。',
    persona ? '你的人设（照这个人的说话方式）：\n' + persona : '人设：普通 B站 用户',
    '硬要求：只输出回复正文，不要引号、不要解释；1~2 句，口语，别客套，别抬杠。',
  ].join('\n')
  const user = [
    '视频：' + (v.title || ''),
    `对方（${c.uname || '网友'}）说：${String(c.content || '').slice(0, 300)}`,
    '回他。',
  ].join('\n')

  let t = await askLLM(sys, user, { maxTokens: 160, temperature: 1.05 })
  t = t.replace(/^["'「『]+|["'」』]+$/g, '').trim()
  if (!t) t = pick(FALLBACK_CM)
  if (t.length > 300) t = t.slice(0, 300)
  return { text: t }
}

export function hasApiKey() {
  return !!findApiKey()
}
