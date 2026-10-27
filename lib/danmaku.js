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

/**
 * 把「视频里到底在说什么」拼成给模型看的材料。
 *
 * ⚠️ 之前提示词里只有标题和简介，模型根本不知道视频内容，
 *    所以写出来的评论只能吐槽标题 —— 用户以为它在刷视频，其实没有。
 *    这里优先用字幕（UP 传的/自动生成的），没有就用弹幕池。
 *    弹幕很好用：观众会把关键点、坑、梗直接打在屏幕上。
 */
export function digestBlock(digest) {
  if (!digest || typeof digest !== 'object') return []
  const out = []
  const t = String(digest.title || '').trim()
  const up = String(digest.up || '').trim()
  const desc = String(digest.desc || '').trim()
  const sub = String(digest.subtitle || '').trim()
  const dm = Array.isArray(digest.danmaku) ? digest.danmaku.filter(Boolean).slice(0, 24) : []

  if (t) out.push('视频标题：' + t)
  if (up) out.push('UP 主：' + up)
  if (desc) out.push('简介：' + desc.slice(0, 500))
  if (sub) {
    out.push('字幕（视频里实际说的，节选）：')
    out.push(sub.slice(0, 1600))
  } else if (dm.length) {
    out.push('观众弹幕（真实存在的，按出现次数排；能看出视频里的重点和坑）：')
    out.push(dm.map((x) => '· ' + String(x).slice(0, 40)).join('\n'))
  }
  return out
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
  const dg = digestBlock(opt.digest)
  const user = [
    ...dg,
    !dg.length ? '视频标题：' + (v.title || '') : '',
    !dg.length && v.up ? 'UP：' + v.up : '',
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
/**
 * 干掉文案里的 @mention。
 * @ 统一由宿主拼在开头，模型写的任何一个都是多余的（以前会变成两个 @）。
 */
export function stripMentions(text, name) {
  let t = String(text || '')
  // 开头：@某某（可能带全角空格）
  t = t.replace(/^\s*(@[^\s@]+[\s\u3000]*)+/, '')
  // 结尾：@某某
  t = t.replace(/([\s\u3000]*@[^\s@]+)+\s*$/, '')
  // 中间：如果就是那个人的 @，删掉；别人的 @ 也删（我们只允许宿主拼一个）
  t = t.replace(/@[^\s@]+/g, name ? (m) => (m === '@' + name ? '' : m) : '')
  // 如果 name 给了，把所有 @name 全删（首尾已删，中间残留也清）
  if (name) {
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp('@' + esc, 'g'), '')
  }
  // 收尾清理多余空格
  return t.replace(/[\s\u3000]{2,}/g, ' ').trim()
}

/**
 * 把学到的内容拼成提示词片段。
 *
 * ⚠️ 关键区别（旧版没有，导致模型只会模仿别人的句子）：
 *   · rule  = **必须遵守的写法**（你总结出来的规律）
 *   · quote = 只用来感受语感，**明确禁止照抄**
 */
function learnedBlock(learned) {
  if (!Array.isArray(learned) || !learned.length) return ''
  const rules = learned.filter((e) => e.kind === 'rule' && (e.rule || e.text))
  const quotes = learned.filter((e) => e.kind !== 'rule' && e.text)

  const out = []
  if (rules.length) {
    out.push('你总结出来的说话规律（这些是你自己攒的，写的时候照着做）：')
    out.push(...rules.slice(0, 10).map((e) => '· ' + String(e.rule || e.text).replace(/\s+/g, ' ').slice(0, 90)))
  }
  if (quotes.length) {
    out.push('')
    out.push('下面是别人的句子，**只用来感受语感，一个字都不许照抄**（抄了就是缝合怪，比 AI 味更假）：')
    out.push(...quotes.slice(0, 2).map((e) => '· ' + String(e.text).replace(/\s+/g, ' ').slice(0, 80)))
  }
  return out.join('\n')
}

/**
 * 从真人评论里**总结说话规律**，而不是抄句子。
 * ============================================================================
 * ⚠️ 这里语义重构过。旧版是「挑出说得好的句子存起来」，结果模型下次只会
 *    模仿别人的句子，写出缝合怪 —— 记的是「别人说了什么」，不是「怎么说话」。
 *
 * 新版目标只有一个：**减少 AI 味**。
 * 输出的是**规律**（rule），不是原句。规律要能直接指导下一次怎么写，例如：
 *   ✅「先给反应再给理由：先说笑死，再补为什么好笑」
 *   ✅「不解释梗，抛完就走」
 *   ❌「术士顺转是没盛饭的空盆」（这是别人的句子，不是规律）
 *
 * 返回 [{kind:'rule'|'quote', rule|text, why, evidence, score}]
 */
export async function extractLearnings(v, comments, cfg, opt = {}) {
  const list = (comments || [])
    .map((c) => String(c.content || '').trim())
    .filter((t) => t.length >= 4)
    .slice(0, 40)
  if (list.length < 3) return []

  const persona = personaOf(cfg, 'comment')
  const userRule = String(cfg.learnPrompt || '').trim()

  const sys = [
    '你在帮一个 AI 角色**学习怎么说话才像个活人**，目标是减少 AI 味。',
    '',
    '你看到的是一批**真人写的 B站 评论**。不要抄他们的话，要从中提炼',
    '**可复用的说话规律**——能直接指导下一条评论怎么写的动作级规律。',
    '',
    persona ? '这个角色的设定：\n' + persona.slice(0, 900) : '',
    '',
    '什么叫「规律」：',
    '✅ 好规律（可执行、能指导写作）：',
    '   · 先给反应再给理由：先一句「笑死」，再补为什么好笑',
    '   · 不解释自己的梗，抛完就走',
    '   · 用短句砸，不写「首先其次」这种结构',
    '   · 承认不知道就说不懂，不硬编',
    '   · 吐槽只打那句话本身，不上升到人',
    '❌ 不是规律（这些别输出）：',
    '   · 直接抄某条评论的原句',
    '   · 「要真诚」「要有感情」这种空话',
    '   · 「多用口语」这种等于没说的废话',
    '',
    '特别注意「AI 味的典型症状」，看到真人评论跟这些症状相反的做法，就记下来：',
    '   · 结构工整、分点罗列、有总结句、有服务尾',
    '   · 先铺垫再给观点，绕一圈才说事',
    '   · 过度礼貌、什么都要解释清楚、怕被误解',
    '   · 每段都想要「升华」一下',
    '',
    userRule ? '【主人定的标准，优先于上面所有默认标准】\n' + userRule.slice(0, 1500) : '',
    '',
    '宁可少给，也别凑数。提炼不出规律就回空数组。',
    '只输出 JSON 数组，不要解释，不要 markdown 代码块。格式：',
    '[{"rule":"规律（≤60字，祈使句或陈述句，能直接指导写作）","why":"为什么这样更像真人（≤30字）","evidence":"支撑它的原话片段（≤30字，只做证据，不会让人照抄）","score":0-10}]',
  ].filter(Boolean).join('\n')

  const user = [
    '视频：' + (v.title || ''),
    '真人评论：',
    ...list.map((t, i) => `${i + 1}. ${t.slice(0, 220)}`),
    '',
    `最多提炼 ${Number(opt.max || 3)} 条规律。`,
  ].join('\n')

  const raw = await askLLM(sys, user, { maxTokens: 900, temperature: 0.35 })
  if (!raw) return []
  let t = raw.replace(/^\s*```[a-z]*/i, '').replace(/```\s*$/, '').trim()
  const a = t.indexOf('[')
  const b = t.lastIndexOf(']')
  if (a >= 0 && b > a) t = t.slice(a, b + 1)
  let arr
  try {
    arr = JSON.parse(t)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr
    .filter((x) => x && (x.rule || x.text) && String(x.rule || x.text).trim())
    .map((x) => ({
      kind: 'rule',
      rule: String(x.rule || x.text).trim().slice(0, 200),
      text: String(x.rule || x.text).trim().slice(0, 200),
      why: String(x.why || '').trim().slice(0, 80),
      evidence: String(x.evidence || '').trim().slice(0, 80),
      score: Math.max(0, Math.min(10, Number(x.score) || 0)),
    }))
    .slice(0, Number.isFinite(Number(opt.max)) ? Math.max(0, Number(opt.max)) : 3)
}

/**
 * 一对一学习：从「对方说了什么 + 我怎么回的」里总结一条接话规律。
 *
 * 跟 extractLearnings 的区别：那个是批量提炼（需要多条样本），
 * 这个是单条对话提炼 —— 监听器里每次只拿到一个人的一句话，
 * 塞给批量提炼会因为没有样本量而永远返回空。
 */
export async function learnFromExchange(theirText, myReply, cfg) {
  const their = String(theirText || '').trim()
  const mine = String(myReply || '').trim()
  if (!their || !mine) return null

  const persona = personaOf(cfg, 'comment')
  const userRule = String(cfg.learnPrompt || '').trim()

  const sys = [
    '你在帮一个 AI 角色复盘：刚才这次接话，有什么「像人」或「像 AI」的经验值得记下来。',
    '',
    persona ? '角色设定：\n' + persona.slice(0, 700) : '',
    '',
    '判断标准只有一个：**怎么说才不像 AI**。',
    '像人的接话：短、先反应后理由、不解释自己的梗、不铺垫、不说场面话。',
    '像 AI 的接话：客气、完整、解释过度、爱总结、爱升华、怕被误解。',
    '',
    '输出**一条可复用的规律**（祈使句，≤60字，能直接指导下一次接话）。',
    '如果这次接话没什么值得总结的（比如对方只是「哈哈」），回 {"skip":true}。',
    '',
    userRule ? '【主人定的标准，优先】\n' + userRule.slice(0, 1000) : '',
    '',
    '只输出 JSON，不要解释：',
    '{"rule":"规律","why":"为什么","score":0-10}  或  {"skip":true}',
  ].filter(Boolean).join('\n')

  const user = [
    '对方说：' + their.slice(0, 300),
    '我回的是：' + mine.slice(0, 300),
    '这次有什么值得记的规律？',
  ].join('\n')

  const raw = await askLLM(sys, user, { maxTokens: 300, temperature: 0.3 })
  if (!raw) return null
  let t = raw.replace(/^\s*```[a-z]*/i, '').replace(/```\s*$/, '').trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) t = t.slice(a, b + 1)
  let o
  try {
    o = JSON.parse(t)
  } catch {
    return null
  }
  if (!o || o.skip || !o.rule) return null
  return {
    kind: 'rule',
    rule: String(o.rule).trim().slice(0, 200),
    text: String(o.rule).trim().slice(0, 200),
    why: String(o.why || '').trim().slice(0, 80),
    evidence: '',
    score: Math.max(0, Math.min(10, Number(o.score) || 0)),
  }
}

/**
 * 审查一段来回对话：还值不值得继续聊。
 *
 * 为什么要有这个：实测会出现「我回他、他回我」刷十几楼的情况，
 * 对面往往也是另一个 AI 插件 —— 两个机器人互相捧场，纯浪费额度，
 * 而且十几条连续回复最容易把账号刷进折叠。
 *
 * 返回 { stop: boolean, reason: string, score: 0-10 }
 *   stop=true 表示「别聊了」，score 越低越没营养。
 */
export async function reviewConversation(v, theirLines, myLines, cfg, opt = {}) {
  const theirs = (theirLines || []).filter(Boolean).map((x) => String(x).slice(0, 200))
  const mine = (myLines || []).filter(Boolean).map((x) => String(x).slice(0, 200))
  if (!theirs.length) return { stop: false, reason: '没有对方的话', score: 5 }

  const persona = personaOf(cfg, 'comment')
  const rounds = Number(opt.rounds) || theirs.length

  const sys = [
    '你在替一个人判断：评论区这段来回对话，还值不值得继续聊下去。',
    persona ? '这个人是这样说话的：\n' + persona.slice(0, 700) : '',
    '',
    '判断标准（只看这三点）：',
    '1. 有营养吗？对方有没有给出新信息、新观点、真情绪？还是只是在附和、复读、客套、绕圈？',
    '2. 像真人吗？真人的回复短、有情绪、会跑题、会只说半句；AI 的回复工整、面面俱到、爱总结、爱升华、爱反问。',
    '3. 有没有推进？聊了这么多轮，话题有没有往前走？还是原地打转？',
    '',
    '已经聊了这么多轮：' + rounds + ' 轮。',
    '如果判定「不值得再聊」，stop=true。典型情形：',
    '  · 两个 AI 互相客套、互相夸、互相总结',
    '  · 对方每句都在附和，没有新东西',
    '  · 对方开始复读同一类话',
    '  · 话题已经结束，再聊就是硬凑',
    '',
    '如果确实还有新东西，stop=false，别乱判。',
    '',
    '只输出 JSON，不要解释：',
    '{"stop":true|false,"reason":"为什么（≤30字）","score":0-10}',
  ].filter(Boolean).join('\n')

  const user = [
    '视频：' + (v.title || ''),
    '',
    '对方说的（按时间顺序）：',
    ...theirs.map((t, i) => `${i + 1}. ${t}`),
    '',
    '我说的：',
    ...mine.map((t, i) => `${i + 1}. ${t}`),
    '',
    '还值得聊吗？',
  ].join('\n')

  const raw = await askLLM(sys, user, { maxTokens: 300, temperature: 0.2 })
  if (!raw) return { stop: false, reason: '模型没回复，保守继续', score: 5 }
  let t = raw.replace(/^\s*```[a-z]*/i, '').replace(/```\s*$/, '').trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) t = t.slice(a, b + 1)
  let o
  try {
    o = JSON.parse(t)
  } catch {
    return { stop: false, reason: '解析失败，保守继续', score: 5 }
  }
  return {
    stop: o.stop === true,
    reason: String(o.reason || '').slice(0, 60),
    score: Math.max(0, Math.min(10, Number(o.score) || 0)),
  }
}

/**
 * 生成「不聊了」的最后一句。
 *
 * 要传达的意思（用户原话）：
 *   · 觉得对面没什么意思
 *   · 懒得搭理了
 *   · 这是最后一次跟他说话
 *   · 跟他说话又累又无趣
 *
 * 但不写「弱智」这类直接侮辱 —— 红线是不辱骂攻击具体真人。
 * 用「接不上话 / 没劲 / 累 / 算了」表达同样的轻视，效果一样但不越线。
 */
export async function makeFarewell(v, theirLastText, cfg, opt = {}) {
  const persona = personaOf(cfg, 'comment')
  const rounds = Number(opt.rounds) || 10
  const why = String(opt.reason || '').slice(0, 60)

  const sys = [
    '你要替这个人写**最后一条**回复 —— 说完这句，以后就不再理对方了。',
    persona ? '人设（完全照这个人的说话方式来）：\n' + persona.slice(0, 700) : '',
    '',
    '这一句要表达清楚四件事，但要说得像人、短、有态度：',
    '1. 这对话没意思 / 你接不上我的话',
    '2. 我懒得再聊了',
    '3. 这是最后一次回你',
    '4. 跟你说话又累又无趣',
    '',
    '硬要求：',
    '· 1~3 句，短。总长不超过 60 字。',
    '· 不要骂人、不要脏话、不要人身攻击（会被折叠，而且难看）。',
    '· 不要说「根据我的判断」「综上所述」这种 AI 腔。',
    '· 不要解释为什么，直接给态度。',
    '· 不要 @ 任何人（程序会处理）。',
    '· 只输出这句话本身，不要引号、不要解释。',
  ].filter(Boolean).join('\n')

  const user = [
    '视频：' + (v.title || ''),
    '对方最后说的是：' + String(theirLastText || '').slice(0, 200),
    '我们已经来回聊了 ' + rounds + ' 轮' + (why ? '，我判断是：' + why : '') + '。',
    '写最后这一句。',
  ].join('\n')

  let t = await askLLM(sys, user, { maxTokens: 200, temperature: 0.9 })
  t = String(t || '').replace(/^["'「『]+|["'」』]+$/g, '').trim()
  t = stripMentions(t)
  if (!t) {
    // 兜底：模型没回就用手写的，别因为一次失败就继续跟对方聊
    t = '行了，跟你说话又累又没意思，这是最后一句。以后别 @ 我了。'
  }
  if (t.length > 120) t = t.slice(0, 120)
  return t
}

/**
 * 从评论区里挑「值得接话」的那几条。
 *
 * 以前是「按时间取前 N 条就回」—— 结果就是对着「1」「cy」「哈哈哈」也认真回一句，
 * 看着像个自动回复机器人。这里让模型先挑：
 *   · 有观点、有信息、有梗、有情绪可以接
 *   · 不是纯复读、不是求关注、不是广告
 * 挑不出来就一条都不回，宁缺毋滥。
 *
 * @returns {Promise<Array<{rpid:string, why:string}>>}
 */
export async function pickReplyTargets(v, comments, cfg, opt = {}) {
  // ⚠️ 别写 opt.max || 2：0 是合法值（= 一条都不回），|| 会把它变成 2
  const want = Number.isFinite(Number(opt.max)) ? Math.max(0, Math.floor(Number(opt.max))) : 2
  const list = (comments || []).filter((c) => c && c.rpid && String(c.content || '').trim().length >= 4)
  if (!want || !list.length) return []

  const persona = personaOf(cfg, 'comment')
  const learned = Array.isArray(opt.learned) ? opt.learned : []

  const sys = [
    '你在帮一个人挑「评论区里哪几条值得接话」。',
    persona ? '这个人是这样说话的：\n' + persona.slice(0, 1200) : '',
    learnedBlock(learned),
    '',
    '值得接的标准：说了观点、给了信息、抛了梗、有情绪可以顺着走。',
    '不值得接：纯复读（1、cy、3）、纯情绪无内容（哈哈哈、笑死）、求关注、广告、无意义争吵。',
    '宁可一条都不挑，也别凑数。',
    '',
    '只输出 JSON 数组，不要解释、不要代码块。格式：',
    '[{"rpid":"评论的 rpid","why":"为什么值得接（≤20字）"}]',
  ].filter(Boolean).join('\n')

  // ⚠️ 以前这里只给了视频标题，模型在「不知道视频讲了什么」的情况下判断
  //    「哪条评论值得接」—— 只能看评论本身的字面，很容易挑到看似有干货、
  //    其实和视频无关的句子。把 digest（字幕/弹幕/简介）也给它，判断才准。
  const dg = digestBlock(opt.digest)
  const user = [
    dg.length ? '【视频内容（用来判断评论在说什么）】' : '',
    ...dg.slice(0, 6),
    dg.length ? '【以上是背景，不要评论它，你只是在挑该回谁】' : '',
    '',
    '视频标题：' + (v.title || ''),
    '评论：',
    ...list.slice(0, 25).map((c) => `rpid=${c.rpid} | ${c.uname || '网友'}：${String(c.content).slice(0, 120)}`),
    '',
    dg.length
      ? `最多挑 ${want} 条。优先挑「跟上面视频内容有关、能接上话」的；纯情绪和复读不挑。`
      : `最多挑 ${want} 条。`,
  ].filter((x) => x !== '').join('\n')

  // 给了视频内容之后提示词会长不少，token 上限跟着提
  const raw = await askLLM(sys, user, { maxTokens: dg.length ? 600 : 400, temperature: 0.2 })
  if (!raw) return fallbackTargets(list, want)

  let t = raw.replace(/^\s*```[a-z]*/i, '').replace(/```\s*$/, '').trim()
  const a = t.indexOf('[')
  const b = t.lastIndexOf(']')
  if (a >= 0 && b > a) t = t.slice(a, b + 1)
  let arr
  try {
    arr = JSON.parse(t)
  } catch {
    return fallbackTargets(list, want)
  }
  if (!Array.isArray(arr)) return fallbackTargets(list, want)

  const byRpid = new Map(list.map((c) => [String(c.rpid), c]))
  const out = []
  for (const x of arr) {
    const id = String(x?.rpid ?? '').trim()
    if (!id || !byRpid.has(id)) continue
    if (out.some((o) => o.rpid === id)) continue
    out.push({ rpid: id, why: String(x?.why || '').slice(0, 40) })
    if (out.length >= want) break
  }
  // 模型一条都没挑出来 = 真的都不值得接，就空着（不回）
  return out
}

/**
 * 模型挂了/没 key 时的退路。
 *
 * ⚠️ 以前是「内容 >= 8 字，按长度从长到短排」—— 但长度和信息量只是弱相关：
 *    「我笑死哈哈哈哈哈哈哈哈」14 个字，「8080 改 6199」10 个字，
 *    纯废话反而更长，排在前面。
 *
 * 现在给一个**便宜的规则打分**，不再只看长度：
 *   + 有数字/英文/参数（8033、API、VSync）—— 多半是具体信息
 *   + 有问号 —— 在提问，接得上
 *   + 长度在 10~80 之间 —— 太短没内容，太长可能是复制的长文
 *   - 纯情绪词占比高 —— 减分
 *   - 复读式短句（1、cy、3、顶）—— 直接排除
 */
export function fallbackTargets(list, want) {
  const EMOTION = /^(哈|笑死|草|啊|这|牛|绝|顶|1|3|cy|6|？|\?)+$/i
  const EMOTION_WORDS = /(哈哈哈|笑死|啊这|草|好家伙|绷不住|麻了|绝了|难绷)/g
  const INFO = /(\d|API|api|config|配置|报错|版本|参数|代码|地址|链接|安装|设置|参数|教程)/

  const scored = list.map((c) => {
    const t = String(c.content || '').trim()
    let s = 0
    if (EMOTION.test(t)) return { c, s: -999 }              // 纯复读/纯情绪，直接出局
    if (t.length >= 10 && t.length <= 80) s += 2             // 合适长度
    else if (t.length < 10) s -= 1
    else s -= 1                                              // 太长，可能是长文复制
    if (INFO.test(t)) s += 3                                 // 有具体信息
    if (/[?？]/.test(t)) s += 2                              // 在提问
    const emo = (t.match(EMOTION_WORDS) || []).length
    if (emo >= 2) s -= 2                                     // 情绪词太密
    if (/@/.test(t)) s -= 1                                  // 在 @ 别人，插进去容易尴尬
    return { c, s }
  })
    .filter((x) => x.s > -999)
    .sort((a, b) => b.s - a.s)

  return scored
    .slice(0, want)
    .map((x) => ({ rpid: String(x.c.rpid), why: '按信息量粗选（模型没回复时的退路）' }))
}

export async function makeComment(v, cfg, opt = {}) {
  const persona = personaOf(cfg, 'comment')
  const mention = String(opt.mentionName || cfg.mentionName || '').trim()
  const learned = Array.isArray(opt.learned) ? opt.learned : []

  const sys = [
    '你在帮一个真人，在 B站 视频评论区留一条**普通用户的评论**。',
    persona ? '你的人设（完全照这个人的说话方式来，不要偏移）：\n' + persona : '人设：普通 B站 用户',
    '',
    '硬要求：',
    '· 只输出评论正文，不要引号、不要解释、不要 markdown、不要写"以下是我的评论"。',
    '· 可以 1~3 句，长短随内容；像人，不像 AI；不要客套、不要"首先其次"。',
    '· 不要复述标题，不要假装看过全部内容；可以就标题/UP/简介说一句实在话。',
    '· 不要带话题标签、不要带链接、不要求关注。',
    '· 正文里绝对不要出现 @ 符号。',
    learnedBlock(learned),
    learned.length
      ? '· 上面是你自己攒下的看法/说法。可以带一点那个味道，但**别照抄原句**，也别为了用而硬塞。'
      : '',
  ].filter(Boolean).join('\n')

  const dg = digestBlock(opt.digest)
  const user = [
    ...dg,
    !dg.length ? '视频标题：' + (v.title || '') : '',
    !dg.length && v.up ? 'UP 主：' + v.up : '',
    Number(v.play) ? '播放量：' + v.play : '',
    dg.length
      ? '（上面是视频的真实内容/观众反应。可以说到具体内容，但别复述标题，也别装作亲眼看完全程。）'
      : '',
    // ⚠️ @ 一律由宿主拼在开头，模型一个字都不许写 ——
    //    以前这里让模型「结尾 @ 一下」，宿主又在开头 @ 一次，
    //    结果评论区里同一条评论出现两个 @。
    mention ? '正文里不要写任何 @，一个字都不要（@ 由程序统一加在开头）。' : '正文里不要写 @。',
    '写这条评论。',
  ].filter(Boolean).join('\n')

  let t = await askLLM(sys, user, { maxTokens: 260, temperature: 1.0 })
  t = t.replace(/^["'「『]+|["'」』]+$/g, '').trim()
  t = stripMentions(t)

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
export async function makeReply(v, c, cfg, opt = {}) {
  const persona = personaOf(cfg, 'comment')
  const learned = Array.isArray(opt.learned) ? opt.learned : []
  const sys = [
    '你在帮一个真人在 B站 评论区回别人的话。',
    persona ? '你的人设（照这个人的说话方式）：\n' + persona : '人设：普通 B站 用户',
    learnedBlock(learned),
    '硬要求：只输出回复正文，不要引号、不要解释、不要写 @；1~2 句，口语，别客套，别抬杠。',
  ].filter(Boolean).join('\n')
  const dg = digestBlock(opt.digest)
  const user = [
    dg.length ? '视频：' + String(dg[0] || '').replace('视频标题：', '') : '视频：' + (v.title || ''),
    dg.length > 1 ? dg.slice(1).join('\n').slice(0, 900) : '',
    `对方（${c.uname || '网友'}）说：${String(c.content || '').slice(0, 300)}`,
    '回他。',
  ].filter(Boolean).join('\n')

  let t = await askLLM(sys, user, { maxTokens: 160, temperature: 1.05 })
  t = t.replace(/^["'「『]+|["'」』]+$/g, '').trim()
  if (!t) t = pick(FALLBACK_CM)
  if (t.length > 300) t = t.slice(0, 300)
  return { text: t }
}

export function hasApiKey() {
  return !!findApiKey()
}
