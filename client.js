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
    const API = '/api/bili-interactor'

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
    const KIND_LABEL = { like: '点赞', coin: '投币', favorite: '收藏', danmaku: '弹幕', follow: '关注', comment: '评论' }
    const KIND_COLOR = { like: '#f472b6', coin: '#fbbf24', favorite: '#38bdf8', danmaku: '#a78bfa', follow: '#34d399', comment: '#fb923c' }
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
      const [err, setErr] = React.useState('')
      const [tab, setTab] = React.useState('overview')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [login, setLogin] = React.useState({ img: '', state: '', hint: '', name: '' })
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
      const startLogin = async () => {
        setBusy('login')
        setLogin({ img: '', state: 'loading', hint: '正在生成二维码…', name: '' })
        try {
          const j = await post('/login/qr')
          if (j && j.ok && j.image) {
            setLogin({ img: j.image, state: 'wait', hint: '用 B站 App 扫这张码，然后在手机上点「确认登录」', name: '' })
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

      // 二维码显示着的时候，每 2 秒问一次「扫了没」
      React.useEffect(() => {
        if (!login.img || login.state === 'done') return undefined
        let alive = true
        const t = setInterval(async () => {
          try {
            const r = await fetch(API + '/login/poll', { credentials: 'same-origin' })
            const j = await r.json()
            if (!alive) return
            if (j && j.done) {
              setLogin({ img: '', state: 'done', hint: '登录成功', name: j.name || '' })
              setMsg('登录成功：' + (j.name || j.uid || ''))
              load()
            } else if (j && j.state === 'timeout') {
              setLogin((s) => ({ ...s, state: 'timeout', hint: '二维码过期了，重新生成一张' }))
            } else if (j && j.state === 'conf') {
              setLogin((s) => ({ ...s, state: 'conf', hint: '扫到了，等你在手机上点确认' }))
            }
          } catch { /* 轮询失败就下一轮再试 */ }
        }, 2000)
        return () => { alive = false; clearInterval(t) }
      }, [login.img, login.state])

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

      /* ── 登录卡：没登录时必须先看到它，不然点「跑一轮」只会收到一句报错 ── */
      const loginCard = h('div', { 'data-bi-card': '', style: loggedIn ? null : { borderColor: 'rgba(251,191,36,.45)' } },
        h('div', { 'data-bi-h2': '' }, loggedIn ? '账号' : '先登录 B站'),
        !loggedIn && !login.img
          ? h('div', null,
            h('div', { 'data-bi-note': '', style: { marginBottom: 12, fontSize: 12.5, lineHeight: 1.7 } },
              '点赞、投币、弹幕都记在账号上，所以得先知道你用的是谁。点下面的按钮出二维码，用 B站 手机 App 扫一下、手机上点「确认登录」就行。凭证只存在这台电脑的 ~/.dsh/bili-interactor/ 里，不上传任何地方。'),
            h('button', {
              'data-bi-btn': '', 'data-variant': 'primary', disabled: busy === 'login', onClick: startLogin,
            }, busy === 'login' ? '正在生成…' : '扫码登录'),
            h('div', { 'data-bi-msg': '' }, login.hint))
          : null,

        // 二维码
        login.img
          ? h('div', { style: { display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('img', {
              src: login.img, alt: '登录二维码', width: 176, height: 176,
              style: { borderRadius: 10, background: '#fff', padding: 8, flex: '0 0 auto' },
            }),
            h('div', { style: { flex: '1 1 220px', minWidth: 200 } },
              h('div', { 'data-bi-note': '', style: { fontSize: 12.5, lineHeight: 1.8 } }, login.hint),
              h('div', { 'data-bi-note': '', style: { marginTop: 10 } },
                login.state === 'wait' ? '每 2 秒自动检查一次…' :
                login.state === 'conf' ? '手机点了确认就成功了' :
                login.state === 'timeout' ? '过期了就点下面重新生成' : ''),
              h('div', { style: { marginTop: 12, display: 'flex', gap: 8 } },
                h('button', { 'data-bi-btn': '', 'data-variant': 'ghost', onClick: startLogin }, '重新生成'))))
          : null,

        // 已登录
        loggedIn && !login.img
          ? h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
            h('div', null,
              h('div', { 'data-bi-lab': '', style: { fontSize: 13.5 } },
                login.name ? login.name : '已登录'),
              h('div', { 'data-bi-note': '' }, '凭证在本机，随时可以退出')),
            h('button', {
              'data-bi-btn': '', 'data-variant': 'ghost', disabled: busy === 'logout', onClick: doLogout,
            }, busy === 'logout' ? '退出中…' : '退出登录'))
          : null)

      /* ── 总览 ── */
      const overview = h('div', null,
        loginCard,
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '今天'),
          h('div', { 'data-bi-grid': '' },
            h(Stat, { n: String(t.actions || 0), label: '今天动了几次', color: '#4ade80' }),
            h(Stat, { n: String(q.left || 0), label: '还剩额度' }),
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
          h('div', { 'data-bi-msg': '' }, msg)),

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

      /* ── 互动（今天碰过的视频） ── */
      const videos = t.videos || []
      const interact = h('div', null,
        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '今天碰过的视频（' + videos.length + '）'),
          videos.length === 0
            ? h('div', { 'data-bi-empty': '' }, '今天还没碰过任何视频')
            : videos.map((v) => h('div', { 'data-bi-item': '', key: v.bvid },
                h('a', { 'data-bi-bv': '', href: v.url, target: '_blank', rel: 'noreferrer' }, v.bvid),
                h('div', { 'data-bi-vt': '' },
                  h('div', null, v.title || '(无标题)'),
                  h('div', { 'data-bi-vup': '' }, v.up || '')),
                (v.acts || []).map((a, i) => h('span', {
                  'data-bi-chip': '', key: i, style: { color: KIND_COLOR[a] || 'var(--bi-dim)' },
                }, KIND_LABEL[a] || a))
              ))
        )
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
            ['doFavorite', '收藏', '需要有收藏夹 ID（下面填）'],
            ['doDanmaku', '发弹幕', '发出去就收不回，想清楚再开'],
            ['doFollow', '关注 UP', '最容易被人发现的那一个，默认关'],
          ].map(([k, lab, note]) => h('div', { 'data-bi-row': '', key: k },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, lab),
              h('div', { 'data-bi-note': '' }, note)),
            h(Switch, { on: !!cfg[k], onChange: (v) => patch({ [k]: v }, lab) }))),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '每条投几个币'),
              h('div', { 'data-bi-note': '' }, '1 或 2')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 1, max: 2, defaultValue: cfg.coinPerVideo,
              onBlur: (e) => patch({ coinPerVideo: Math.max(1, Math.min(2, Number(e.target.value) || 1)) }, '投币数'),
            }))),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '额度和节奏'),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '一轮最多动几条'),
              h('div', { 'data-bi-note': '' }, '上限，不是任务量')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 1, max: 100, defaultValue: cfg.maxActionsPerRun,
              onBlur: (e) => patch({ maxActionsPerRun: Math.max(1, Math.min(100, Number(e.target.value) || 20)) }, '每轮上限'),
            })),
          h('div', { 'data-bi-row': '' },
            h('div', null,
              h('div', { 'data-bi-lab': '' }, '一天最多动几次'),
              h('div', { 'data-bi-note': '' }, '到点自动停')),
            h('input', {
              'data-bi-input': '', type: 'number', min: 1, max: 500, defaultValue: cfg.maxActionsPerDay,
              onBlur: (e) => patch({ maxActionsPerDay: Math.max(1, Math.min(500, Number(e.target.value) || 120)) }, '每日上限'),
            }))),

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
            }))),

        h('div', { 'data-bi-card': '' },
          h('div', { 'data-bi-h2': '' }, '弹幕怎么写'),
          h('div', { 'data-bi-note': '', style: { marginBottom: 8 } },
            '有 DeepSeek key 就让模型写，没有就用模板。写出来会先显示在「过程」里给你看。'),
          h('textarea', {
            'data-bi-input': '', style: { width: '100%', height: 68, resize: 'vertical', fontFamily: 'inherit' },
            defaultValue: cfg.danmakuStyle || '',
            onBlur: (e) => patch({ danmakuStyle: String(e.target.value).slice(0, 300) }, '弹幕风格'),
          })),
      )

      const TABS = [
        ['overview', '总览'],
        ['interact', '互动'],
        ['process', '过程'],
        ['settings', '设置'],
      ]

      const body = tab === 'overview' ? overview : tab === 'interact' ? interact : tab === 'process' ? process : settings

      return h('div', { 'data-bi-root': '' },
        h('div', { 'data-bi-head': '' },
          h('div', null,
            h('div', { 'data-bi-title': '' }, 'B站互动'),
            h('div', { 'data-bi-sub': '' },
              `${st.today || ''} · 懂你在刷什么，也真的会点 · 2 秒自动刷新`)),
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
