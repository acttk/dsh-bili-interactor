/**
 * 弹幕文案生成
 * ============================================================================
 * 优先用 DeepSeek 写（有 key 就写人话），没有 key 就退回模板。
 *
 * 为什么要单独一层：弹幕是"发出去就收不回来"的东西，写得像机器人
 * 比不发更糟 —— 所以这里要能读视频标题/UP/简介，让文案沾点边。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FALLBACK = [
  '这波可以', '笑死', '有点东西', '???', '绷不住了', '好活',
  '前排', '芜湖', '这就去看看', '意犹未尽', '绝了', '学到了',
]

/* 从 DSH 凭据里摸一个 DeepSeek key（有就用，没有不报错） */
function findApiKey() {
  try {
    const f = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
    const txt = readFileSync(f, 'utf8')
    // refs 段里是引用的环境变量名，值在进程环境里
    if (/DEEPSEEK_API_KEY/.test(txt) && process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
    // 也接受直接写在 yaml 里的 apiKey
    const m = txt.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/)
    if (m) return m[1]
  } catch { /* 没凭据就算了 */ }
  return process.env.DEEPSEEK_API_KEY || ''
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 生成一条弹幕。
 * @param {object} v    {title, up, desc}
 * @param {object} cfg  {persona, danmakuStyle}
 * @param {object} opt  {apiKey}
 * @returns {Promise<{text: string, source: 'llm'|'template'}>}
 */
export async function makeDanmaku(v, cfg, opt = {}) {
  const key = opt.apiKey ?? findApiKey()
  if (key) {
    try {
      const sys = [
        '你在帮一个真人发 B站 弹幕。',
        '人设：' + (cfg.persona || '普通 B站 用户'),
        '风格：' + (cfg.danmakuStyle || '短、口语、不评价视频质量'),
        '硬要求：只输出弹幕正文，不要引号、不要解释、不要换行；长度 4~18 个汉字；',
        '不要用「这视频」「UP主」「质量」「推荐」这类解说腔；不要带话题标签。',
      ].join('\n')
      const user = [
        '视频标题：' + (v.title || ''),
        'UP：' + (v.up || ''),
        v.desc ? '简介：' + String(v.desc).slice(0, 160) : '',
        '写一条弹幕。',
      ].filter(Boolean).join('\n')

      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
          ],
          temperature: 1.1,
          max_tokens: 40,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) {
        const j = await res.json()
        let t = (j?.choices?.[0]?.message?.content || '').trim()
        t = t.replace(/^["'「『]|["'」』]$/g, '').replace(/\s+/g, '')
        if (t && t.length <= 24) return { text: t, source: 'llm' }
      }
    } catch { /* 网络/额度问题都不致命，退回模板 */ }
  }
  return { text: pick(FALLBACK), source: 'template' }
}

export function hasApiKey() {
  return !!findApiKey()
}
