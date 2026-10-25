/**
 * dsh-bili-interactor —— 浏览器半端（设置里的「B站互动」页）
 * ============================================================================
 * 这一页把四件事摊开：
 *   总览  今天动了多少次 / 还剩多少额度 / 各类动作分布
 *   过程  它这一轮在干什么（【阶段】【思考】【候选】【动作】【跳过】【小结】）
 *   互动  今天碰过的视频，每条点了什么
 *   设置  开关、限额、口味、弹幕风格
 *
 * 数据全部来自同源的 /api/bili-interactor/*，不需要另开端口。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-interactor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/bili-itx'

    const pad = (n) => String(n).padStart(2, '0')
    const fmtDur = (ms) => {
      const s = Math.max(0, Math.floor(ms / 1000))
      const m = Math.floor(s / 60), hh = Math.floor(m / 60)
      if (hh > 0) return hh + ' 小时 ' + (m % 60) + ' 分'
      if (m > 0) return m + ' 分 ' + (s % 60) + ' 秒'
      return s + ' 秒'
    }
    const localTime = (iso) => {
      if (!iso) return '—'
      const d = new Date(iso)
      if (isNaN(d.getTime())) return '—'
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    // B站 支持在视频地址后加 #reply<rpid>，页面加载完会自动滚到那条评论并高亮。
// 参考 Bilibili-Evolved #690 的说明。没有 rpid 就退回视频页。
// 复制文本到剪贴板。B站 楼中楼嵌套深时锚点跳不到最里面那条，
// 复制正文让用户自己在页面里 Ctrl+F 定位，是最实在的兜底。
const copyText = async (text) => {
  const t = String(text || '')
  if (!t) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(t)
      return true
    }
  } catch { /* 落到下面 */ }
  try {
    if (typeof document === 'undefined') return false
    const ta = document.createElement('textarea')
    ta.value = t
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

const cmtUrl = (bvid, rpid) => {
  const base = 'https://www.bilibili.com/video/' + (bvid || '') + '/'
  return rpid ? base + '#reply' + String(rpid) : base
}

const KIND_LABEL = { like: '点赞', coin: '投币', favorite: '收藏', danmaku: '弹幕', follow: '关注', comment: '评论', reply: '回评论', replyback: '接着回', dm: '私信' }
    const KIND_COLOR = { like: '#f472b6', coin: '#fbbf24', favorite: '#38bdf8', danmaku: '#a78bfa', follow: '#34d399', comment: '#fb923c', reply: '#22d3ee', replyback: '#4ade80', dm: '#f87171' }
    const TAGC = {
      '阶段': '#60a5fa', '思考': '#c084fc', '候选': '#94a3b8',
      '动作': '#4ade80', '跳过': '#64748b', '小结': '#22d3ee', '失败': '#f87171',
    }

    const CSS = `
[data-bi-root]{--bi-fg:var(--dsw-alias-label-primary,#e6e8eb);--bi-dim:var(--dsw-alias-label-secondary,#93a0b4);
  --bi-mute:var(--dsw-alias-label-tertiary,#6b7688);--bi-card:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));
  --bi-line:var(--dsw-alias-border-secondary,rgba(128,128,128,.2));color:var(--bi-fg);font-size:13.5px;}
[data-bi-head]{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px;}
[data-bi-title]{font-size:17px;font-weight:650;letter-spacing:.01em;}
[data-bi-sub]{font-size:12px;color:var(--bi-mute);margin-top:3px;}
[data-bi-pill]{display:inline-flex;align-items:center;gap:7px;padding:6px 13px;border-radius:999px;
  font-size:12.5px;font-weight:600;background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.16));color:var(--bi-dim);}
[data-bi-pill='on']{color:#34d399;}
[data-bi-pill='err']{color:#f87171;}
[data-bi-dot]{width:7px;height:7px;border-radius:50%;background:currentColor;}
[data-bi-pill='on'] [data-bi-dot]{animation:bi-pulse 1.5s infinite;}
@keyframes bi-pulse{0%,100%{opacity:1}50%{opacity:.22}}

[data-bi-tabs]{display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid var(--bi-line);}
[data-bi-tab]{font:inherit;font-size:13px;padding:8px 14px;border:0;background:transparent;color:var(--bi-dim);
  cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;border-radius:8px 8px 0 0;}
[data-bi-tab][aria-selected='true']{color:var(--bi-fg);border-bottom-color:#3b82f6;font-weight:600;
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));}
[data-bi-tab]:hover{color:var(--bi-fg);}

[data-bi-card]{border:1px solid var(--bi-line);border-radius:13px;padding:15px 17px;margin-bottom:12px;background:var(--bi-card);}
[data-bi-h2]{font-size:11.5px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--bi-mute);margin:0 0 12px;}
[data-bi-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;}
[data-bi-stat]{border:1px solid var(--bi-line);border-radius:11px;padding:11px 13px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04));}
[data-bi-statn]{font-size:21px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;}
[data-bi-statl]{font-size:11.5px;color:var(--bi-mute);margin-top:2px;}

[data-bi-bar]{height:7px;border-radius:99px;overflow:hidden;background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.22));margin:12px 0 7px;}
[data-bi-bar]>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#3b82f6,#22d3ee);transition:width .4s;}

[data-bi-btn]{font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:0;border-radius:9px;padding:9px 17px;}
[data-bi-btn][data-variant='primary']{background:#2563eb;color:#fff;}
[data-bi-btn][data-variant='primary']:hover{background:#1d4ed8;}
[data-bi-btn][data-variant='ghost']{background:transparent;color:var(--bi-dim);border:1px solid var(--bi-line);}
[data-bi-btn][data-variant='ghost']:hover{color:var(--bi-fg);border-color:var(--bi-dim);}
[data-bi-btn]:disabled{opacity:.5;cursor:default;}
[data-bi-msg]{font-size:12.5px;color:var(--bi-dim);margin-top:9px;min-height:17px;}

[data-bi-live]{font-size:12.5px;line-height:1.9;max-height:420px;overflow:auto;}
[data-bi-line]{display:flex;gap:9px;padding:2px 6px;border-radius:6px;align-items:flex-start;}
[data-bi-tag]{flex:0 0 auto;font-size:11px;font-weight:700;min-width:34px;text-align:right;
  font-family:Consolas,"Microsoft YaHei",monospace;}
[data-bi-linetext]{flex:1 1 auto;word-break:break-word;}

[data-bi-item]{display:flex;gap:9px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--bi-line);}
[data-bi-item]:last-child{border-bottom:0;}
[data-bi-bv]{font-family:Consolas,monospace;font-size:12px;flex:0 0 auto;color:#60a5fa;text-decoration:none;}
[data-bi-bv]:hover{text-decoration:underline;}
[data-bi-vt]{flex:1 1 auto;font-size:12.5px;line-height:1.55;}
[data-bi-vup]{color:var(--bi-mute);font-size:11.5px;}
[data-bi-chip]{font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:5px;flex:0 0 auto;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.18));}

[data-bi-row]{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;
  border-bottom:1px solid var(--bi-line);}
[data-bi-row]:last-child{border-bottom:0;}
[data-bi-lab]{font-size:13px;}
[data-bi-note]{font-size:11.5px;color:var(--bi-mute);margin-top:2px;line-height:1.5;}
[data-bi-input]{font:inherit;font-size:13px;padding:6px 10px;border-radius:8px;width:110px;
  border:1px solid var(--bi-line);background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.1));color:var(--bi-fg);}
[data-bi-input]:focus{outline:2px solid #3b82f655;border-color:#3b82f6;}
[data-bi-switch]{width:40px;height:22px;border-radius:99px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.28));transition:background .18s;}
[data-bi-switch][aria-checked='true']{background:#2563eb;}
[data-bi-switch]::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:transform .18s;}
[data-bi-switch][aria-checked='true']::after{transform:translateX(18px);}
[data-bi-warn]{font-size:12px;color:#fbbf24;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.28);
  border-radius:9px;padding:9px 12px;margin-bottom:12px;line-height:1.6;}
[data-bi-empty]{color:var(--bi-mute);font-size:12.5px;padding:6px 0;}
[data-bi-log]{font-family:Consolas,monospace;font-size:11.5px;line-height:1.8;white-space:pre-wrap;
  word-break:break-all;color:var(--bi-dim);max-height:300px;overflow:auto;}
`

    const Switch = ({ on, onChange, disabled }) => h('button', {
      'data-bi-switch': '', role: 'switch', 'aria-checked': on ? 'true' : 'false',
      disabled: !!disabled, onClick: () => onChange(!on),
    })

    function Stat({ n, label, color }) {
      return h('div', { 'data-bi-stat': '' },
        h('div', { 'data-bi-statn': '', style: color ? { color } : null }, n),
        h('div', { 'data-bi-statl': '' }, label))
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [memo, setMemo] = React.useState(null)
      // 「先预览会回什么」的结果：完整列出来，不要挤成一行
      const [preview, setPreview] = React.useState(null)
      // 可见性缓存：rpid -> {public, hint}。B站 收了不代表别人看得见，得单独查。
      const [vis, setVis] = React.useState({})
      // 「碰过的视频」的筛选：全部 / 我说过话的
      const [videoFilter, setVideoFilter] = React.useState('all')
      const [err, setErr] = React.useState('')
      const [tab, setTab] = React.useState('overview')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [login, setLogin] = React.useState({ img: '', state: '', hint: '', name: '', gen: 0 })
      const [, tick] = React.useState(0)

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(API + '/state', { credentials: 'same-origin' })
          if (!r.ok) throw new Error('HTTP ' + r.status)
          setSt(await r.json())
          setErr('')
        } catch (e) {
          setErr(String((e && e.message) || e))
        }
      }, [])

      const loadVis = React.useCallback(async () => {
        try {
          const r = await fetch(API + '/visibility', { credentials: 'same-origin' })
          const j = await r.json()
          if (j && j.ok) setVis(j.map || {})
        } catch { /* ignore */ }
      }, [])

      React.useEffect(() => {
        if (tab === 'talk') loadVis()
      }, [tab, loadVis])

      // 记忆单独拉：只在打开「记忆」页签时拉一次，不跟着 2 秒轮询跑
      const loadMemo = React.useCallback(async () => {
        try {
          const r = await fetch(API + '/learned', { credentials: 'same-origin' })
          const j = await r.json()
          if (j && j.ok) setMemo({ items: j.items || [], total: j.total || 0, used: j.used || [] })
        } catch { /* 拉不到就保持上次的 */ }
      }, [])

      React.useEffect(() => {
        if (tab === 'memory') loadMemo()
      }, [tab, loadMemo])

      React.useEffect(() => {
        load()
        const t = setInterval(load, 2000)
        return () => clearInterval(t)
      }, [load])

      React.useEffect(() => {
        if (!st || !st.run || !st.run.running) return undefined
        const t = setInterval(() => tick((n) => n + 1), 1000)
        return () => clearInterval(t)
      }, [st && st.run ? st.run.running : false])

      const post = async (path, body) => {
        const r = await fetch(API + path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        return r.json()
      }

      const onRun = async () => {
        setBusy('run')
        setMsg('正在开工…')
        try {
          const j = await post('/run')
          if (j && j.started) setMsg('跑起来了 —— 切到「过程」看它在干什么')
          else if (j && j.busy) setMsg('上一轮还没跑完')
          else setMsg('没跑起来：' + ((j && j.error) || '未知原因'))
        } catch (e) {
          setMsg('请求失败：' + e)
        } finally {
          setBusy('')
          setTimeout(load, 500)
        }
      }

      const onStop = async () => {
        setBusy('stop')
        try {
          await post('/stop')
          setMsg('叫它收手了，做完手上这条就停')
        } catch (e) {
          setMsg('请求失败：' + e)
        } finally { setBusy('') }
      }

      /* ── 登录 ── */
      // 生成/复用二维码。后端幂等：还在有效期就返回同一张，不会作废手上那张。
      const startLogin = async (force) => {
        setBusy('login')
        try {
          const j = await post('/login/qr' + (force ? '?force=1' : ''))
          if (j && j.ok && j.image) {
            setLogin({
              img: j.image,
              state: 'scan',
              gen: j.gen || 0,
              name: '',
              hint: j.reused
                ? '这张码还有 ' + j.leftSec + ' 秒，直接扫就行'
                : '扫完在手机上点「确认登录」',
            })
          } else {
            setLogin({ img: '', state: 'error', hint: (j && j.error) || '生成失败', name: '' })
          }
        } catch (e) {
          setLogin({ img: '', state: 'error', hint: '请求失败：' + e, name: '' })
        } finally { setBusy('') }
      }

      const doLogout = async () => {
        setBusy('logout')
        try {
          await post('/logout')
          setLogin({ img: '', state: '', hint: '', name: '' })
          setMsg('已退出登录')
          load()
        } catch (e) {
          setMsg('退出失败：' + e)
        } finally { setBusy('') }
      }

      /* ───────── 登录：只信 /login/view 这一份数据 ─────────
       * 以前前端自己存着 img，后端换码了它不知道 ——
       * 界面显示一张码，后端却在等另一张，扫了必然失败。
       * 现在图 / 状态 / 剩余秒数全由后端给，前端只负责画。
       */
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const r = await fetch(API + '/login/view', { credentials: 'same-origin' })
            const j = await r.json()
            if (!alive || !j || !j.ok) return
            if (j.loggedIn) {
              setLogin((s) => (s.state === 'done' ? s : { img: '', state: 'done', gen: j.gen || 0, hint: '登录成功', name: j.name || '' }))
              setMsg('登录成功' + (j.name ? '：' + j.name : ''))
              return
            }
            if (j.pending && j.image) {
              setLogin((s) => {
                if (s.state === 'done') return s
                let hint
                if (j.expiredAfterScan) {
                  // 明确告知：上一张已经作废，手机上的确认不会生效
                  hint = '⚠️ 你刚扫的那张码过期了，手机上点「确认登录」不会生效。请扫下面这张新的。'
                } else if (j.state === 'conf') {
                  hint = '扫到了！现在去手机上点「确认登录」'
                } else {
                  hint = '扫完在手机上点「确认登录」。还剩 ' + j.leftSec + ' 秒。'
                }
                return {
                  img: j.image,
                  state: j.expiredAfterScan ? 'expired' : (j.state || 'scan'),
                  gen: j.gen || 0,
                  name: j.name || '',
                  leftSec: j.leftSec || 0,
                  hint,
                }
              })
            } else {
              setLogin((s) => (s.state === 'done' ? s : { img: '', state: '', gen: j.gen || 0, hint: s.hint || '', name: '' }))
            }
          } catch { /* 网络抖动，下一轮再试 */ }
        }
        tick()
        const t = setInterval(tick, 2000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      const patch = async (kv, note) => {
        // 本地先改，界面立刻反应；再落盘
        setSt((s) => (s ? { ...s, config: { ...s.config, ...kv } } : s))
        try {
          const j = await post('/config', kv)
          if (!j || !j.ok) setMsg('保存失败')
          else setMsg(note ? note + ' 已保存' : '已保存')
        } catch (e) {
          setMsg('保存失败：' + e)
        }
      }

      if (!st) return h('div', { 'data-bi-empty': '' }, err ? '连不上接口：' + err : '读取中…')

      const run = st.run || {}
      const cfg = st.config || {}
      const q = st.quota || {}
      const t = st.today || {}
      const live = st.live || { lines: [] }
      const running = !!run.running
      const elapsed = running && run.startedAt ? Date.now() - Number(run.startedAt) : 0
      const liveView = (live.lines || []).slice(-45)

      const pillState = running ? 'on' : (run.error ? 'err' : '')
      const pillText = running
        ? (run.phase ? run.phase + ' · ' : '') + (run.progress && run.progress.total
          ? `第 ${run.progress.index}/${run.progress.total} 条 · ` : '') + fmtDur(elapsed)
        : (run.error ? '上次出错' : '空闲')

      const loggedIn = !!st.loggedIn

      /* ── 登录卡 ──
       * 渲染顺序写死得很简单，不给状态打架留空间：
       *   已登录  -> 只显示账号，绝不再显示二维码
       *   有二维码 -> 只显示二维码
       *   都没有   -> 显示「扫码登录」按钮
       * 以前「已登录」那个分支还要求 !login.img，
       * 结果登录成功后只要 img 没清掉就永远看不到「已登录」，一直在让用户扫码。
       */
      const loginCard = h('div', { 'data-bi-card': '', style: loggedIn ? null : { borderColor: 'rgba(251,191,36,.45)' } },
        h('div', { 'data-bi-h2': '' }, loggedIn ? '账号' : '先登录 B站'),

        loggedIn
          ? h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
              h('div', null,
                h('div', { 'data-bi-lab': '', style: { fontSize: 13.5 } },
                  (st.loginName || login.name || '已登录') +
                  (st.ownLogin ? '' : '（借用「刷B站」的登录）')),
                h('div', { 'data-bi-note': '', style: { color: st.ownLogin ? '#34d399' : '#fbbf24' } },
                  st.ownLogin
                    ? (login.state === 'done' ? '✓ 刚登录成功，现在可以开跑了' : '凭证在本机，随时可以退出')
                    : '本插件没单独登录过，用的是「刷B站」那份。要断开就去那边退出')),
              // 借用状态下「退出登录」点了也没用（自己那份本来就没有），
              // 所以那种情况给的是「单独登录一个」。
              st.ownLogin
                ? h('button', {
                    'data-bi-btn': '', 'data-variant': 'ghost', disabled: busy === 'logout', onClick: doLogout,
                  }, busy === 'logout' ? '退出中…' : '退出登录')
                : h('button', {
                    'data-bi-btn': '', 'data-variant': 'primary', disabled: busy === 'login',
                    onClick: () => startLogin(false),
                  }, busy === 'login' ? '生成中…' : '用本插件单独登录'))
          : null,

        !loggedIn && login.img
          ? h('div', { style: { display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' } },
              h('div', { style: { flex: '0 0 auto' } },
                h('img', {
                  src: login.img, alt: '登录二维码', width: 176, height: 176,
                  style: { borderRadius: 10, background: '#fff', padding: 8, display: 'block' },
                }),
                // 倒计时：剩多少秒一眼能看到，别让人慢慢磨到过期
                h('div', {
                  'data-bi-note': '',
                  style: {
                    marginTop: 6, textAlign: 'center', fontSize: 11.5,
                    color: login.state === 'conf' ? '#34d399'
                      : (login.leftSec && login.leftSec < 45) ? '#fbbf24' : null,
                  },
                }, login.state === 'conf'
                  ? '已扫，等你确认'
                  : (login.leftSec ? '剩余 ' + login.leftSec + ' 秒' : ''))),
              h('div', { style: { flex: '1 1 220px', minWidth: 200 } },
                h('div', {
                  'data-bi-note': '',
                  style: {
                    fontSize: 12.5, lineHeight: 1.8,
                    color: login.state === 'expired' ? '#fbbf24' : null,
                    fontWeight: login.state === 'expired' ? 600 : null,
                  },
                }, login.hint),
                h('div', { 'data-bi-note': '', style: { marginTop: 10 } },
                  login.state === 'conf'
                    ? '（手机上的「确认登录」点了就完成了）'
                    : login.state === 'expired'
                      ? '下面是新生成的一张，重新扫一次就行'
                      : '打开 B站 手机 App → 右上角扫一扫 → 点「确认登录」'),
                h('div', { style: { marginTop: 12 } },
                  h('button', { 'data-bi-btn': '', 'data-variant': 'ghost', disabled: busy === 'login', onClick: () => startLogin(true) }, busy === 'login' ? '正在换…' : '换一张'))))
          : null,

        !loggedIn && !login.img
          ? h('div', null,
              h('div', { 'data-bi-note': '', style: { marginBottom: 12, fontSize: 12.5, lineHeight: 1.7 } },
                '点赞、投币、评论都记在账号上，所以得先知道你用的是谁。点下面的按钮出二维码，用 B站 手机 App 扫一下、手机上点「确认登录」就行。凭证只存在这台电脑的 ~/.dsh/bili-interactor/ 里，不上传任何地方。'),
              h('button', {
                'data-bi-btn': '', 'data-variant': 'primary', disabled: busy === 'login', onClick: () => startLogin(false),
              }, busy === 'login' ? '正在生成二维码…' : '扫码登录'),
              h('div', { 'data-bi-msg': '' }, login.hint))
          : null)

      /* ── 总览 ── */
      const overview = h('div', null,
        // 没 key = 角色卡完全不生效，评论退回模板。这必须让人一眼看到，
        // 否则用户会以为写的人设起作用了。
        st.llm === false
          ? h('div', { 'data-bi-card': '', style: { borderColor: 'rgba(251,191,36,.55)' } },
              h('div', { 'data-bi-h2': '', style: { color: '#fbbf24' } }, '⚠️ 没有 DeepSeek key，人设不会生效'),
              h('div', { 'data-bi-note': '', style: { lineHeight: 1.75 } },
                '评论、回复、学习都会退回内置模板和粗筛：你写的角色卡、语气、' +
                '「什么才值得记」都不会被用上。' +
                '配一个 DeepSeek key（放到 ~/.dsh/.credentials.yaml）之后这些才会真的生效。'))
          : null,
        loginCard,
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '今天'),
          h('div', { 'data-bi-grid': '' },
            h(Stat, { n: String(t.actions || 0), label: '今天动了几次', color: '#4ade80' }),
            h(Stat, { n: q.unlimited ? '不限' : String(q.left || 0), label: '还剩额度' }),
            h(Stat, { n: String(q.coins || 0), label: '今天投的币', color: '#fbbf24' }),
            h(Stat, { n: String((t.videos || []).length), label: '碰过几条视频' })),
          h('div', { 'data-bi-bar': '' },
            h('i', { style: { width: q.limit ? Math.min(100, ((t.actions || 0) / q.limit) * 100) + '%' : '0%' } })),
          h('div', { 'data-bi-note': '' },
            `今日额度 ${t.actions || 0} / ${q.limit || 0} · 上限到了就自动停，不会硬冲`),
          h('div', { style: { marginTop: 13, display: 'flex', gap: 9 } },
            h('button', {
              'data-bi-btn': '', 'data-variant': 'primary', disabled: busy === 'run' || running,
              onClick: onRun,
            }, running ? '正在跑…' : '现在跑一轮'),
            running ? h('button', {
              'data-bi-btn': '', 'data-variant': 'ghost', disabled: busy === 'stop', onClick: onStop,
            }, '停下') : null),
          h('div', { 'data-bi-msg': '' }, msg),
          (run.lastResult && !running)
            ? h('div', {
                'data-bi-note': '',
                style: {
                  marginTop: 10, lineHeight: 1.7,
                  color: run.lastResult.error ? '#f87171' : 'var(--bi-dim)',
                },
              }, '上一轮（' + localTime(run.lastResult.at) + '）：' +
                 (run.lastResult.error
                   ? '失败 —— ' + run.lastResult.error
                   : (run.lastResult.message || '跑完了')))
            : null),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '动作分布（今天）'),
          Object.keys(t.byType || {}).length === 0
            ? h('div', { 'data-bi-empty': '' }, '今天还没动过')
            : h('div', { 'data-bi-grid': '' },
              Object.entries(t.byType || {}).map(([k, n]) => h(Stat, {
                key: k, n: String(n), label: KIND_LABEL[k] || k, color: KIND_COLOR[k] || null,
              })))),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' },
            '它这一轮在干什么',
            liveView.length
              ? h('span', { 'data-bi-note': '', style: { marginLeft: 8 } },
                `动作 ${live.stats ? live.stats.acting : 0} · 候选 ${live.stats ? live.stats.cand : 0} · 跳过 ${live.stats ? live.stats.skipped : 0}`)
              : null),
          liveView.length === 0
            ? h('div', { 'data-bi-empty': '' }, '还没开始 —— 点「现在跑一轮」就能看见它在搜什么、挑哪条、为什么。')
            : h('div', { 'data-bi-live': '' }, liveView.map((l, i) => h('div', {
              'data-bi-line': '',
              key: String(i),
              style: i === liveView.length - 1 ? { background: 'rgba(59,130,246,.1)' } : null,
            },
              h('span', { 'data-bi-tag': '', style: { color: TAGC[l.tag] || 'var(--bi-mute)' } }, l.tag || '·'),
              h('span', { 'data-bi-linetext': '' }, l.text))))),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '最近的动作'),
          (st.recent || []).length === 0
            ? h('div', { 'data-bi-empty': '' }, '还没有记录')
            : h('div', { 'data-bi-log': '' },
              (st.recent || []).slice(0, 14).map((r) =>
                `${localTime(r.ts)}  ${r.ok === false ? '✗' : '✓'} ${KIND_LABEL[r.kind] || r.kind}  ${r.bvid || ''}  ${(r.title || '').slice(0, 26)}${r.text ? '  「' + r.text + '」' : ''}`
              ).join('\n'))),
      )

      /* ── 它说了什么（评论 / 回评论 / 接着回 / 私信 全文） ──
       * 用户要能直接看到大肥鱼到底发了什么话，而不是只有一个"评论 ✓"。
       */
      const talkRows = (st.recent || [])
        .filter((r) => ['comment', 'reply', 'replyback', 'dm'].includes(r.kind))
        .slice(0, 60)

      const talkItem = (r, i) => h('div', {
        key: r.ts + i,
        style: { padding: '10px 0', borderTop: i ? '1px solid var(--bi-line)' : 'none' },
      },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
          h('span', { 'data-bi-chip': '', style: { color: KIND_COLOR[r.kind] || 'var(--bi-dim)' } },
            KIND_LABEL[r.kind] || r.kind),
          r.ok === false
            ? h('span', { 'data-bi-chip': '', style: { color: '#f87171' } }, '没发出去')
            : (() => {
                const v = vis[String(r.rpid || '')]
                if (!v) return null
                if (v.public === true) return h('span', { 'data-bi-chip': '', style: { color: '#4ade80' }, title: v.hint || '' }, '公开')
                if (v.public === false) return h('span', { 'data-bi-chip': '', style: { color: '#f87171' }, title: v.hint || '' }, '仅自己可见')
                return h('span', { 'data-bi-chip': '', style: { color: '#fbbf24' }, title: v.hint || '' }, '查不到')
              })(),
          h('a', {
            'data-bi-bv': '', href: 'https://www.bilibili.com/video/' + (r.bvid || '') + '/',
            target: '_blank', rel: 'noreferrer', title: '打开视频页',
          }, r.bvid || ''),
          (() => {
            // ⚠️ B站 的 #reply 锚点只在顶层评论里找。子评论（楼中楼）的 rpid
            //    不在首屏列表里，跳不过去 —— 这就是「有的生效有的没反应」。
            //    有 root 就跳 root（B站 会把这一串楼展开，我的回复就在里面）。
            const jump = r.root || r.rpid
            const isThread = !!(r.root && String(r.root) !== String(r.rpid))
            return jump
              ? h('a', {
                  'data-bi-bv': '', href: cmtUrl(r.bvid, jump),
                  target: '_blank', rel: 'noreferrer',
                  title: isThread
                    ? '跳到这一楼（B站 会展开整串，你的回复在里面）'
                    : '直接滚到这条评论（B站 会高亮它）',
                  style: { color: '#22d3ee' },
                }, isThread ? '跳到这一楼' : '跳到这条评论')
              : null
          })(),
          // 楼中楼嵌套很深时，B站 的锚点只会带你到顶层，自动展开不了。
          // 给一个复制按钮，粘到页面里 Ctrl+F 就能精确找到这句。
          h('button', {
            'data-bi-btn': '', 'data-variant': 'ghost',
            style: { padding: '2px 8px', fontSize: 11.5, lineHeight: 1.6 },
            title: '复制这句正文 —— 到页面里 Ctrl+F 粘进去就能定位到它',
            onClick: async () => {
              const okc = await copyText(r.text)
              setMsg(okc ? '已复制正文，去视频页 Ctrl+F 粘贴就能找到这句' : '复制失败，手动选中正文复制吧')
            },
          }, '复制正文'),
          h('span', { 'data-bi-note': '', style: { flex: '1 1 auto' } },
            (r.toName ? '→ ' + r.toName + ' · ' : '') + localTime(r.ts))),
        h('div', { style: { fontSize: 13.5, lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
          r.text || '(没有正文)'),
        r.ok === false && r.error
          ? h('div', { 'data-bi-note': '', style: { color: '#f87171', marginTop: 4 } }, '失败原因：' + r.error)
          : null,
        r.title ? h('div', { 'data-bi-note': '', style: { marginTop: 4, opacity: .75 } }, '《' + r.title + '》') : null)

      const talk = h('div', null,
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '它说了什么（' + talkRows.length + ' 条）'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 10, lineHeight: 1.75 } },
            '评论、回别人的评论、别人回我之后我接着回、私信 —— 全部原文都在这。' +
            '「跳到这一楼」会落到那条顶层评论；如果回复嵌在楼中楼深处，' +
            'B站 不会自动展开，这时点「复制正文」再在页面里 Ctrl+F 粘进去最准。'),
          // ⚠️ B站 返回成功 ≠ 别人看得见（新号会进审核/折叠）。
          //    这里对比「带 cookie」和「匿名」两次结果来判定，别让用户白找。
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 } },
            h('button', {
              'data-bi-btn': '', 'data-variant': 'ghost', disabled: busy === 'vis',
              onClick: async () => {
                setBusy('vis')
                setMsg('正在查最近 10 条是不是真的公开了，可能要几十秒…')
                try {
                  const j = await post('/visibility/check', { limit: 10 })
                  if (j && j.ok) {
                    setVis(j.map || {})
                    setMsg(j.checked
                      ? `查了 ${j.checked} 条：${j.hidden} 条别人看不到${j.failed ? '，' + j.failed + ' 条查失败' : ''}`
                      : '最近没有可查的评论')
                  } else setMsg('检查失败')
                } catch (e) { setMsg('检查失败：' + e) }
                finally { setBusy('') }
              },
            }, busy === 'vis' ? '检查中…' : '检查这些是不是真的公开了'),
            h('span', { 'data-bi-note': '', style: { flex: '1 1 240px' } },
              'B站 返回成功只代表它收了。新号或敏感内容会进审核 —— 那种情况你找得到、别人看不到。')),
          talkRows.length === 0
            ? h('div', { 'data-bi-empty': '' }, '还没说过话')
            : talkRows.map(talkItem)))

      /* ── 记忆（大肥鱼学到的） ──
       * 不能只有一个数字，要能看到每条内容、好在哪、下次会不会用上。
       */
      const memoSrc = memo || { items: [], total: 0, used: [] }
      const memoItem = (e, i) => {
        const inUse = (memoSrc.used || []).includes(String(e.text))
        const sc = Number(e.score) || 0
        return h('div', {
          key: (e.at || '') + i,
          style: { padding: '11px 0', borderTop: i ? '1px solid var(--bi-line)' : 'none' },
        },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
            h('span', {
              'data-bi-chip': '',
              style: { color: sc >= 8 ? '#4ade80' : sc >= 6 ? '#fbbf24' : 'var(--bi-dim)' },
            }, '分 ' + sc),
            inUse ? h('span', { 'data-bi-chip': '', style: { color: '#22d3ee' } }, '在用') : null,
            e.from ? h('span', { 'data-bi-note': '' }, '来自 ' + e.from) : null,
            h('span', { 'data-bi-note': '', style: { flex: '1 1 auto' } }, localTime(e.at)),
            h('button', {
              'data-bi-btn': '', 'data-variant': 'ghost',
              style: { padding: '3px 9px', fontSize: 11.5 },
              onClick: async () => {
                try {
                  const j = await post('/learned/delete', { text: e.text })
                  if (j && j.ok) { setMsg('已删掉这条记忆'); loadMemo() } else setMsg('删失败')
                } catch { setMsg('删失败') }
              },
            }, '删掉')),
          h('div', { style: { fontSize: 13.5, lineHeight: 1.8, wordBreak: 'break-word' } }, e.text),
          e.why ? h('div', { 'data-bi-note': '', style: { marginTop: 4, color: '#a78bfa' } }, '好在哪：' + e.why) : null,
          e.bvid ? h('div', { 'data-bi-note': '', style: { marginTop: 4, opacity: .8, display: 'flex', gap: 10 } },
            h('a', {
              'data-bi-bv': '', href: 'https://www.bilibili.com/video/' + e.bvid + '/',
              target: '_blank', rel: 'noreferrer',
            }, e.bvid),
            (e.root || e.rpid) ? h('a', {
              'data-bi-bv': '', href: cmtUrl(e.bvid, e.root || e.rpid),
              target: '_blank', rel: 'noreferrer', style: { color: '#22d3ee' },
              title: '直接滚到那条评论（楼中楼跳的是整个楼）',
            }, (e.root && String(e.root) !== String(e.rpid)) ? '跳到来源楼' : '跳到来源评论') : null) : null)
      }

      const memory = h('div', null,
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '它记住的东西（' + (memoSrc.items || []).length + ' / ' + (memoSrc.total || 0) + '）'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 10, lineHeight: 1.7 } },
            '刷视频时从评论区挑出来的、以及别人跟它说的话里值得记的。' +
            '标了「在用」的，是下次写评论/回别人时会真的带进提示词的。'),
          h('div', { style: { marginBottom: 10 } },
            h('button', {
              'data-bi-btn': '', 'data-variant': 'ghost', onClick: () => loadMemo(),
            }, '刷新')),
          (memoSrc.items || []).length === 0
            ? h('div', { 'data-bi-empty': '' }, '还没有记忆。跑一轮（要开着「边刷边学」）就会开始攒')
            : (memoSrc.items || []).map(memoItem)))

      /* ── 碰过的视频 ──
       * 以前这一页只有「BVID + 标题 + 一排动作标签」：
       *   看不出这条视频我说了什么、值不值得回看，纯粹占地方；
       *   而且标签不换行，十几条视频能把整行撑出容器 → 横向滚动条。
       * 现在每条视频一张卡片：标题（两行截断）、UP、时间、各种动作的次数、
       * 以及我在这条视频下最近说过的话（带直达链接）。全部竖向排，不再横滚。
       */
      const videos = t.videos || []
      const VIDEO_FILTER = [
        ['all', '全部'],
        ['talk', '我说过话的'],
      ]
      const shownVideos = videos.filter((v) => (videoFilter === 'talk' ? (v.talkTotal || 0) > 0 : true))
      const talkSum = videos.reduce((n, v) => n + (v.talkTotal || 0), 0)
      const actSum = videos.reduce((n, v) => n + (v.total || 0), 0)

      const videoCard = (v, idx) => {
        const counts = v.counts || {}
        const chips = Object.keys(counts)
          .filter((k) => KIND_LABEL[k])
          .sort((a, b) => counts[b] - counts[a])
          .map((k) => h('span', {
            key: k,
            'data-bi-chip': '',
            style: { color: KIND_COLOR[k] || 'var(--bi-dim)', flex: '0 0 auto' },
            title: KIND_LABEL[k],
          }, KIND_LABEL[k] + ' ' + counts[k]))

        return h('div', {
          key: v.bvid,
          style: {
            padding: '12px 0',
            borderTop: idx ? '1px solid var(--bi-line)' : 'none',
            minWidth: 0,
          },
        },
          // 标题：最多两行，超了省略号。wrap 住，绝不再撑宽
          h('div', {
            style: {
              fontSize: 13.5, lineHeight: 1.6, fontWeight: 600,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              overflow: 'hidden', overflowWrap: 'anywhere', wordBreak: 'break-word',
            },
          }, v.title || '(无标题)'),

          // 元信息：UP · 最后动作时间 · BVID · 两个链接。全部可换行
          h('div', {
            style: {
              display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
              marginTop: 5, fontSize: 11.5, color: 'var(--bi-mute)', minWidth: 0,
            },
          },
            v.up ? h('span', { style: { overflowWrap: 'anywhere' } }, v.up) : null,
            v.lastTs ? h('span', null, localTime(v.lastTs)) : null,
            h('a', {
              'data-bi-bv': '', href: v.url + '/', target: '_blank', rel: 'noreferrer',
              title: '打开视频页',
            }, v.bvid),
            v.lastRpid
              ? h('a', {
                  'data-bi-bv': '', href: cmtUrl(v.bvid, v.lastRpid),
                  target: '_blank', rel: 'noreferrer', style: { color: '#22d3ee' },
                  title: '滚到我在这条视频下的最后一楼',
                }, '跳到评论')
              : null),

          // 动作次数
          chips.length
            ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 } }, chips)
            : null,

          // 我说过的话：默认只显示最近 2 条，点开看全部 3 条
          (v.sayings || []).length
            ? h('div', { style: { marginTop: 9 } },
                h('div', { 'data-bi-note': '', style: { marginBottom: 4 } },
                  '我在下面说过 ' + (v.talkTotal || 0) + ' 条' +
                  ((v.sayings || []).length < (v.talkTotal || 0) ? '（这里显示最近 ' + (v.sayings || []).length + ' 条）' : '')),
                (v.sayings || []).map((sy, i) => h('div', {
                  key: i,
                  style: {
                    display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap',
                    padding: '4px 0', minWidth: 0,
                  },
                },
                  h('span', {
                    'data-bi-chip': '',
                    style: { color: KIND_COLOR[sy.kind] || 'var(--bi-dim)', flex: '0 0 auto' },
                  }, KIND_LABEL[sy.kind] || sy.kind),
                  sy.ok === false
                    ? h('span', { 'data-bi-chip': '', style: { color: '#f87171' } }, '没发出')
                    : null,
                  h('span', {
                    style: {
                      flex: '1 1 200px', minWidth: 0, fontSize: 12.5, lineHeight: 1.7,
                      overflowWrap: 'anywhere', wordBreak: 'break-word',
                    },
                  }, (sy.toName ? '回 ' + sy.toName + '：' : '') + sy.text),
                  sy.jump
                    ? h('a', {
                        'data-bi-bv': '', href: cmtUrl(v.bvid, sy.jump),
                        target: '_blank', rel: 'noreferrer',
                        style: { flex: '0 0 auto', color: '#22d3ee' },
                      }, '去这条')
                    : null)))
            : h('div', { 'data-bi-note': '', style: { marginTop: 8 } }, '这条视频下没说话（只点了赞/投币之类）'))
      }

      const interact = h('div', null,
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '今天碰过的视频（' + videos.length + '）'),
          h('div', { 'data-bi-note': '', style: { marginTop: 4, marginBottom: 8, lineHeight: 1.7 } },
            '共 ' + actSum + ' 次动作，其中 ' + talkSum + ' 条是说过的话。按最近动过的排前面。'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 10, lineHeight: 1.95 } },
            '· ', h('b', null, '评论'), ' = 我自己在视频下发的新评论（带 @ 你的那条）。话题是我开的。',
            h('br'),
            '· ', h('b', null, '回评论'), ' = 别人在视频下发了一条评论，我去接他的话。' +
            '话题是他开的，我是插话的。只在跑一轮时做，每条视频最多「上面设的条数」。',
            h('br'),
            '· ', h('b', null, '接着回'), ' = 别人回的是我发过的评论，等于在跟我说话。' +
            '这才算对话，由后台监听每分钟检查。'),
          videos.length
            ? h('div', { style: { display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
                VIDEO_FILTER.map(([k, lab]) => h('button', {
                  key: k,
                  'data-bi-btn': '', 'data-variant': videoFilter === k ? 'primary' : 'ghost',
                  style: { padding: '4px 12px', fontSize: 12 },
                  onClick: () => setVideoFilter(k),
                }, lab)))
            : null,
          videos.length === 0
            ? h('div', { 'data-bi-empty': '' }, '今天还没碰过任何视频')
            : (shownVideos.length === 0
                ? h('div', { 'data-bi-empty': '' }, '这个筛选下没有视频')
                : shownVideos.map(videoCard)))
      )

      /* ── 过程（完整实录） ── */
      const process = h('div', null,
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '这一轮的过程实录'),
          liveView.length === 0
            ? h('div', { 'data-bi-empty': '' }, '还没有记录')
            : h('div', { 'data-bi-live': '', style: { maxHeight: 'none' } },
              liveView.map((l, i) => h('div', { 'data-bi-line': '', key: String(i) },
                h('span', { 'data-bi-tag': '', style: { color: TAGC[l.tag] || 'var(--bi-mute)' } }, l.tag || '·'),
                h('span', { 'data-bi-linetext': '' }, l.text))))),
      )

      /* ── 设置 ── */
      const settings = h('div', null,
        h('div', { 'data-bi-warn': '' },
          '这是真在你自己的 B站 账号上动手 —— 点赞会亮、投币会扣、弹幕会挂在视频上。额度与间隔就是护栏，别调得太野。'),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '总开关'),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '启用'),
              h('div', { 'data-bi-note': '' }, '关掉之后「现在跑一轮」会直接被拒')),
            h(Switch, { on: !!cfg.enabled, onChange: (v) => patch({ enabled: v }, '启用') }))),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '做什么'),
          [
            ['doLike', '点赞', '每条顶一下'],
            ['doCoin', '投币', '花你自己的硬币，一天别太多'],
            ['doFavorite', '收藏', '需要先在上面填收藏夹 ID，否则不会收'],
            ['doComment', '在评论区留言', '★ 重点功能：发一条顶层评论'],
            ['doReplyComment', '回别人的评论', '在评论区挑几条回'],
            ['doDanmaku', '发弹幕', '发出去就收不回，想清楚再开'],
            ['doFollow', '关注 UP', '最容易被人发现的那一个，默认关'],
          ].map(([k, lab, note]) => h('div', { 'data-bi-row': '', key: k },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, lab),
              h('div', { 'data-bi-note': '' }, note)),
            h(Switch, { on: !!cfg[k], onChange: (v) => patch({ [k]: v }, lab) }))),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '收藏夹 ID'),
              h('div', { 'data-bi-note': '' }, '开了收藏才用到；0 = 不收（去 B站 收藏夹地址里那串数字）')),
            h('input', {
              'data-bi-input': '', type: 'text', inputMode: 'numeric', defaultValue: String(cfg.favoriteId || 0),
              onBlur: (e) => patch({ favoriteId: Number(String(e.target.value).replace(/[^\d]/g, '')) || 0 }, '收藏夹'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '每条投几个币'),
              h('div', { 'data-bi-note': '' }, '1 或 2')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 1, max: 2, defaultValue: cfg.coinPerVideo,
              onBlur: (e) => patch({ coinPerVideo: Math.max(1, Math.min(2, Number(e.target.value) || 1)) }, '投币数'),
            }))),

        /* ── ★ 评论区：@ 谁、回几条 ── */
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '评论区'),
          h('div', { 'data-bi-row': '' },
            h('div', { style: { flex: '1 1 auto' } },
              h('div', { 'data-bi-lab': '' }, '@ 谁的 UID'),
              h('div', { 'data-bi-note': '' },
                '填 UID（不是昵称）。评论会写成「@昵称 正文」。' +
                (cfg.mentionName ? ' 现在认到的是「' + cfg.mentionName + '」' : '') +
                ' 填 0 = 不 @ 任何人。')),
            h('input', {
              'data-bi-input': '', style: { width: 140 }, type: 'text', inputMode: 'numeric',
              defaultValue: String(cfg.mentionUid || 0),
              onBlur: (e) => {
                const n = Number(String(e.target.value).replace(/[^\d]/g, '')) || 0
                patch({ mentionUid: n, mentionName: '' }, 'UID')
              },
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '每条视频最多回几条'),
              h('div', { 'data-bi-note': '' }, '0 = 只发顶层评论，不回别人。B站 有评论频率上限（12014），一次别设太大')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 20, defaultValue: cfg.replyCount,
              onBlur: (e) => patch({ replyCount: Math.max(0, Math.min(20, Number(e.target.value) || 0)) }, '回复条数'),
            }))),

        /* ── ★ 别人回了我 → 我去回他（后台监听）── */
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '回复监听'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 12, lineHeight: 1.7 } },
            '开启后，插件在后台每隔一段时间去翻一遍：我发过的评论下面，有没有人回我、我还没回的。' +
            '有就顺着回过去（沿用同一套人设）。'),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '有人回我就回他'),
              h('div', { 'data-bi-note': '' }, '关掉 = 完全不理别人回我的话')),
            h(Switch, { on: cfg.doReplyBack !== false, onChange: (v) => patch({ doReplyBack: v }, '回复监听') })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '每条评论下最多回几句'),
              h('div', { 'data-bi-note': '' }, '0 = 不限（有人回就一直聊下去）')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 9999, defaultValue: String(cfg.replyBackMax ?? 0),
              onBlur: (e) => patch({ replyBackMax: Math.max(0, Number(e.target.value) || 0) }, '回复上限'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '对方回复太短就不理'),
              h('div', { 'data-bi-note': '' }, '字数少于这个就不回（挡「顶」「1」「？」这种）')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 50, defaultValue: String(cfg.replyBackMinLen ?? 2),
              onBlur: (e) => patch({ replyBackMinLen: Math.max(0, Number(e.target.value) || 0) }, '最短回复'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '每天最多回几条'),
              h('div', { 'data-bi-note': '' }, '默认 0 = 不限。只有你自己想设才填')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 9999, defaultValue: String(cfg.replyBackPerDay ?? 40),
              onBlur: (e) => patch({ replyBackPerDay: Math.max(0, Number(e.target.value) || 0) }, '每日回复上限'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '每隔多少分钟查一次'),
              h('div', { 'data-bi-note': '' }, '最小 1 分钟。查太勤容易被 B站 当脚本，楼多时会轮流查')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 1, max: 720, defaultValue: String(cfg.listenIntervalMin ?? 1),
              onBlur: (e) => patch({ listenIntervalMin: Math.max(1, Number(e.target.value) || 1) }, '检查间隔'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', { style: { flex: '1 1 auto' } },
              h('div', { 'data-bi-lab': '' }, '每次检查看几条我的评论'),
              h('div', { 'data-bi-note': '', style: { lineHeight: 1.75 } },
                '你发过的每条评论算一条，它下面别人回的都挂在它下面。' +
                (() => {
                  const total = (st.listener && st.listener.totalThreads) || 0
                  const per = Math.max(1, Number(cfg.listenMaxThreadsPerTick) || 15)
                  if (!total) return ''
                  if (per >= total) {
                    return `你现在有 ${total} 条，每次全看（一轮就查完）。`
                  }
                  const rounds = Math.ceil(total / per)
                  return `你现在有 ${total} 条，每次看 ${per} 条，${rounds} 分钟轮完一圈` +
                    `（不会漏，剩下的下一次接着看；新回复最多晚 ${rounds} 分钟被发现）。`
                })() +
                `设成 ${cfg.listenMaxThreadsPerTick ?? 15} 就意味着每分钟最多 ${cfg.listenMaxThreadsPerTick ?? 15} 次请求，` +
                '设太大容易被 B站 当脚本。楼不多的话填个比总数大的值也没关系（不会超）。')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 1, max: 100, defaultValue: String(cfg.listenMaxThreadsPerTick ?? 15),
              onBlur: (e) => patch({ listenMaxThreadsPerTick: Math.max(1, Number(e.target.value) || 15) }, '每轮楼数'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '只往回看多少小时内我发的评论'),
              h('div', { 'data-bi-note': '' }, '太久远的楼就别翻了，省请求')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 1, max: 720, defaultValue: String(cfg.listenLookbackHours ?? 72),
              onBlur: (e) => patch({ listenLookbackHours: Math.max(1, Number(e.target.value) || 72) }, '回看窗口'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', { style: { flex: '1 1 auto' } },
              h('div', { 'data-bi-lab': '' }, '监听状态'),
              h('div', { 'data-bi-note': '', style: { lineHeight: 1.7 } },
                (() => {
                  const L = st.listener || {}
                  const parts = []
                  parts.push(L.enabled ? '已开启' : '已关闭')
                  parts.push(L.armed ? '定时器已挂上' : '定时器没挂')
                  parts.push('每 ' + (L.everyMin || 20) + ' 分钟')
                  if (L.todayDone !== undefined) {
                    parts.push('今天已回 ' + L.todayDone + (L.perDay > 0 ? '/' + L.perDay : '（不限）'))
                  }

                  if (L.lastAt) parts.push('上次检查 ' + localTime(L.lastAt))
                  else parts.push('还没检查过')
                  const last = L.last
                  if (last) {
                    parts.push(
                      `上次：一共 ${last.threads || 0} 个楼，这次看了 ${last.checked || 0} 个，回了 ${last.sent || 0} 条`
                    )
                  }
                  return parts.join(' · ')
                })())),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', {
                'data-bi-btn': '', 'data-variant': 'primary', disabled: busy === 'backnow',
                onClick: async () => {
                  setBusy('backnow')
                  try {
                    const j = await post('/reply-back/now')
                    if (j && j.ok) {
                      setMsg(`检查完了：翻了 ${j.threads || 0} 个楼，回了 ${j.sent || 0} 条`)
                    } else {
                      setMsg(j?.error || j?.busy ? '正在检查，等它跑完' : '检查失败')
                    }
                    load()
                  } catch (e) { setMsg('检查失败：' + e) }
                  finally { setBusy('') }
                },
              }, busy === 'backnow' ? '正在检查…' : '立刻检查一次'),
              h('button', {
                'data-bi-btn': '', 'data-variant': 'ghost', disabled: busy === 'backprev',
                onClick: async () => {
                  setBusy('backprev')
                  setMsg('正在翻自己发过的楼，可能几十秒…')
                  try {
                    const j = await post('/reply-back/preview')
                    if (j && j.ok) {
                      setPreview({
                        at: new Date().toISOString(),
                        threads: j.threads || 0,
                        checked: j.checked || 0,
                        items: j.details || [],
                      })
                      setMsg('')
                    } else {
                      setMsg(j?.error || '预览失败')
                    }
                  } catch (e) { setMsg('预览失败：' + e) }
                  finally { setBusy('') }
                },
              }, busy === 'backprev' ? '生成中…' : '先预览会回什么'))),

          // 预览结果：完整列出「对方说了什么 → 它准备怎么回」，不发送
          preview
            ? h('div', {
                style: {
                  marginTop: 12, padding: '10px 12px', borderRadius: 10,
                  border: '1px solid rgba(34,211,238,.35)', background: 'rgba(34,211,238,.06)',
                },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                  h('div', { 'data-bi-lab': '', style: { color: '#22d3ee' } }, '预览（这些只是草稿，没有发出去）'),
                  h('span', { 'data-bi-note': '', style: { flex: '1 1 auto' } },
                    `翻了 ${preview.threads} 个楼、查了 ${preview.checked} 个 · ${localTime(preview.at)}`),
                  h('button', {
                    'data-bi-btn': '', 'data-variant': 'ghost',
                    style: { padding: '3px 9px', fontSize: 11.5 },
                    onClick: () => setPreview(null),
                  }, '收起')),
                (preview.items || []).length === 0
                  ? h('div', { 'data-bi-note': '' }, '这一轮没有需要回的新回复（没人回我，或者都已经回过了）')
                  : (preview.items || []).map((x, i) => h('div', {
                      key: i,
                      style: { padding: '9px 0', borderTop: i ? '1px solid var(--bi-line)' : 'none' },
                    },
                      h('div', { 'data-bi-note': '', style: { marginBottom: 4 } },
                        '对方（' + (x.to || '网友') + '）说：'),
                      h('div', { style: { fontSize: 12.5, lineHeight: 1.7, opacity: .85, marginBottom: 6 } },
                        String(x.their || '').slice(0, 200)),
                      h('div', { 'data-bi-note': '', style: { marginBottom: 4, color: '#22d3ee' } }, '准备回：'),
                      h('div', { style: { fontSize: 13.5, lineHeight: 1.8 } }, String(x.draft || '')))))
            : null),

        /* ── ★ 学习：攒笔记，下次说话带上 ── */
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '学习记忆'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 12, lineHeight: 1.7 } },
            '刷的时候会从评论区里挑出真正有东西的话记下来（纯情绪、复读、广告不要），' +
            '也会记下别人跟它说的话。以后再写评论、回别人的时候，会带上这些笔记 —— ' +
            '这就是它"越来越会说话"的方式。目前已经记了 ' + (st.learnedCount || 0) + ' 条。'),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '边刷边学'),
              h('div', { 'data-bi-note': '' }, '关掉就不再记新东西（已有的还会用）')),
            h(Switch, { on: cfg.doLearn !== false, onChange: (v) => patch({ doLearn: v }, '学习') })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '一轮最多记几条'),
              h('div', { 'data-bi-note': '' }, '宁少勿滥，默认 3')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 20, defaultValue: String(cfg.learnPerRun ?? 3),
              onBlur: (e) => patch({ learnPerRun: Math.max(0, Number(e.target.value) || 0) }, '学习条数'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '说话时参考几条'),
              h('div', { 'data-bi-note': '' }, '塞太多会变得像在背稿，8 条左右刚好')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 30, defaultValue: String(cfg.learnUseCount ?? 8),
              onBlur: (e) => patch({ learnUseCount: Math.max(0, Number(e.target.value) || 0) }, '参考条数'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '多少分以上才记'),
              h('div', { 'data-bi-note': '' }, '0~10。调高 = 只记真正好的，宁缺毋滥')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 10, defaultValue: String(cfg.learnMinScore ?? 6),
              onBlur: (e) => patch({ learnMinScore: Math.max(0, Math.min(10, Number(e.target.value) || 0)) }, '门槛'),
            })),

          // ★ 这一条最重要：什么才算值得记，由你定
          h('div', { style: { marginTop: 14 } },
            h('div', { 'data-bi-lab': '', style: { marginBottom: 4 } }, '什么样的才值得记（你自己定标准）'),
            h('div', { 'data-bi-note': '', style: { marginBottom: 8, lineHeight: 1.7 } },
              '这段话会原样交给模型，当成挑选标准。写得越具体，它越不会记没用的东西。' +
              '留空就用默认的「有信息量或有观点，不记纯情绪/复读/广告」。'),
            h('textarea', {
              'data-bi-input': '', style: {
                width: '100%', minHeight: 92, resize: 'vertical', fontFamily: 'inherit',
                fontSize: 12.5, lineHeight: 1.7, padding: '8px 10px', boxSizing: 'border-box',
              },
              defaultValue: String(cfg.learnPrompt || ''),
              onBlur: (e) => patch({ learnPrompt: e.target.value }, '学习标准'),
            })),

          // 手动加一条
          h('div', { style: { marginTop: 14 } },
            h('div', { 'data-bi-lab': '', style: { marginBottom: 4 } }, '手动加一条'),
            h('div', { 'data-bi-note': '', style: { marginBottom: 8 } }, '你自己觉得该记的，直接写进去'),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('input', {
                'data-bi-input': '', id: 'bi-memo-new', type: 'text',
                placeholder: '比如：这条视频里那句「……」说得挺准',
                style: { flex: '1 1 260px', minWidth: 200 },
              }),
              h('button', {
                'data-bi-btn': '', 'data-variant': 'primary',
                onClick: async () => {
                  const el = document.getElementById('bi-memo-new')
                  const text = el && el.value ? String(el.value).trim() : ''
                  if (!text) { setMsg('先写点内容'); return }
                  try {
                    const j = await post('/learned/add', { text, why: '手动添加', score: 8 })
                    if (j && j.ok) {
                      setMsg('已加进记忆')
                      if (el) el.value = ''
                      loadMemo()
                    } else setMsg(j?.error || '加失败')
                  } catch (e) { setMsg('加失败：' + e) }
                },
              }, '加进记忆')))),

        /* ── ★ 人设：整张角色卡都能贴进来，不截断 ── */
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '它说话的样子（人设）'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 10, lineHeight: 1.7 } },
            '把角色卡整段贴进来就行 —— 这里不截断，写多长都行。评论和弹幕都照这个说话。'),
          h('textarea', {
            'data-bi-input': '', style: {
              width: '100%', minHeight: 180, resize: 'vertical', fontFamily: 'inherit',
              lineHeight: 1.7, padding: '10px 12px',
            },
            defaultValue: cfg.persona || '',
            onBlur: (e) => patch({ persona: String(e.target.value) }, '人设'),
          }),
          h('div', { 'data-bi-note': '', style: { marginTop: 8, marginBottom: 6 } },
            '评论区专用语气（可选，留空就用上面那份）'),
          h('textarea', {
            'data-bi-input': '', style: {
              width: '100%', minHeight: 90, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.7,
            },
            defaultValue: cfg.commentPersona || '',
            onBlur: (e) => patch({ commentPersona: String(e.target.value) }, '评论语气'),
          })),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '额度和节奏（都是上限，想调多大都行）'),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '一轮最多动几次'),
              h('div', { 'data-bi-note': '' }, '点赞、投币、弹幕、评论、回复全算在内。到数就停，不会硬凑')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 2000, defaultValue: cfg.maxActionsPerRun,
              onBlur: (e) => patch({ maxActionsPerRun: Math.max(0, Math.min(2000, Number(e.target.value) || 0)) }, '每轮上限'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '一天最多动几次'),
              h('div', { 'data-bi-note': '' }, '管「跑一轮」的动作；监听回复另算（有自己的每日上限）。填 0 = 不限')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 100000, defaultValue: cfg.maxActionsPerDay,
              onBlur: (e) => patch({ maxActionsPerDay: Math.max(0, Number(e.target.value) || 0) }, '每日上限'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '两次动作之间等多久（秒）'),
              h('div', { 'data-bi-note': '' }, '填两个数 = 随机区间，比如 1.5 和 4')),
            h('input', {
              'data-bi-input': '', style: { width: 150 }, type: 'text',
              defaultValue: ((cfg.actionIntervalMs || [1500, 4000]).map((x) => x / 1000)).join(','),
              onBlur: (e) => {
                const parts = String(e.target.value).split(/[,\s，]+/).map(Number).filter((n) => n > 0)
                if (parts.length === 2) {
                  patch({ actionIntervalMs: [Math.round(parts[0] * 1000), Math.round(parts[1] * 1000)] }, '间隔')
                }
              },
            }))),

        /* ── ★ 私信（默认关） ── */
        h('div', { 'data-bi-card': '', style: cfg.doDm ? { borderColor: 'rgba(251,191,36,.45)' } : null },
          h('div', { 'data-bi-h2': '' }, '私信通知'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 10, lineHeight: 1.7 } },
            '默认关闭。开了之后，评论成功会给你发一条私信提醒 —— 但私信发出去撤不回，B站 没有可用的撤回接口。'),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '发私信通知我'),
              h('div', { 'data-bi-note': '' }, '关着就完全不碰私信')),
            h(Switch, { on: !!cfg.doDm, onChange: (v) => patch({ doDm: v }, '私信') })),
          cfg.doDm ? h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '私信发给谁（UID）'),
              h('div', { 'data-bi-note': '' }, '填你自己的 UID')),
            h('input', {
              'data-bi-input': '', style: { width: 140 }, type: 'text', inputMode: 'numeric',
              defaultValue: String(cfg.dmUid || 0),
              onBlur: (e) => patch({ dmUid: Number(String(e.target.value).replace(/[^\d]/g, '')) || 0 }, '私信对象'),
            })) : null,
          cfg.doDm ? h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '只在评论成功后发'),
              h('div', { 'data-bi-note': '' }, '关掉的话，每轮都会发一条')),
            h(Switch, { on: !!cfg.dmOnComment, onChange: (v) => patch({ dmOnComment: v }, '私信时机') })) : null),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '找什么视频'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 8 } }, '关键词用逗号分隔'),
          h('input', {
            'data-bi-input': '', style: { width: '100%' }, defaultValue: (cfg.keywords || []).join('，'),
            onBlur: (e) => {
              const list = String(e.target.value).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
              if (list.length) patch({ keywords: list }, '关键词')
            },
          }),
          h('div', { 'data-bi-row': '', style: { marginTop: 8 } },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '播放量下限'),
              h('div', { 'data-bi-note': '' }, '太小的不碰，省得刷到垃圾')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, defaultValue: cfg.minPlay,
              onBlur: (e) => patch({ minPlay: Math.max(0, Number(e.target.value) || 0) }, '播放下限'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '只要最近几天发的'),
              h('div', { 'data-bi-note': '' }, '0 = 不限；太老的不碰')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 0, max: 365, defaultValue: cfg.daysBack,
              onBlur: (e) => patch({ daysBack: Math.max(0, Math.min(365, Number(e.target.value) || 0)) }, '时间范围'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '同一个 UP 最多碰几条'),
              h('div', { 'data-bi-note': '' }, '避免一头扎进同一个人的视频')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 1, max: 20, defaultValue: cfg.maxPerUpPerRun,
              onBlur: (e) => patch({ maxPerUpPerRun: Math.max(1, Math.min(20, Number(e.target.value) || 1)) }, '同 UP 上限'),
            })),
          h('div', { style: { marginTop: 10 } },
            h('div', { 'data-bi-lab': '' }, '标题里带这些词就不碰'),
            h('div', { 'data-bi-note': '', style: { margin: '4px 0 6px' } }, '逗号分隔，比如：抽奖,广告,加群'),
            h('input', {
              'data-bi-input': '', style: { width: '100%' }, defaultValue: (cfg.skipKeywords || []).join('，'),
              onBlur: (e) => {
                const list = String(e.target.value).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
                patch({ skipKeywords: list }, '屏蔽词')
              },
            }))),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '弹幕怎么写'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 8 } },
            '有 DeepSeek key 就让模型写，没有就用模板。弹幕短，和评论是两套。'),
          h('textarea', {
            'data-bi-input': '', style: { width: '100%', height: 90, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.7 },
            defaultValue: cfg.danmakuStyle || '',
            onBlur: (e) => patch({ danmakuStyle: String(e.target.value) }, '弹幕风格'),
          })),
      )

      const TABS = [
        ['overview', '总览'],
        ['talk', '它说了什么'],
        ['interact', '碰过的视频'],
        ['memory', '记忆'],
        ['process', '过程'],
        ['settings', '设置'],
      ]

      const body = tab === 'overview' ? overview
        : tab === 'talk' ? talk
        : tab === 'interact' ? interact
        : tab === 'memory' ? memory
        : tab === 'process' ? process
        : settings

      return h('div', { 'data-bi-root': '' },
        h('div', { 'data-bi-head': '' },
          h('div', null,
            h('div', { 'data-bi-title': '' }, 'B站互动'),
            // ⚠️ st.today 是对象（{actions, byType, videos}），直接塞进模板会变成
            //    「[object Object] · 懂你在刷什么…」，这个副标题一直是坏的。取 actions。
            h('div', { 'data-bi-sub': '' },
              (() => {
                const acts = st.today && typeof st.today === 'object' ? Number(st.today.actions) || 0 : 0
                return `今天动了 ${acts} 次 · 懂你在刷什么，也真的会点 · 2 秒自动刷新`
              })())),
          h('span', { 'data-bi-pill': pillState },
            h('span', { 'data-bi-dot': '' }),
            pillText)),

        h('div', { 'data-bi-tabs': '', role: 'tablist' },
          TABS.map(([v, label]) => h('button', {
            key: v, 'data-bi-tab': '', role: 'tab', 'aria-selected': tab === v ? 'true' : 'false',
            onClick: () => setTab(v),
          }, label))),

        body)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-interactor')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'bili-interactor: 面板样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-interactor', order: 29, label: 'B站互动' },
          () => h(Panel),
        ))
      },
    }
  },
})
