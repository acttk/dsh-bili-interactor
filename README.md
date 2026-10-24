# dsh-bili-interactor

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件：**替你逛 B站，并且真的产生互动** ——
点赞、投币、收藏、发弹幕、关注，带一块可视化面板，进度和判断过程全都摊开给你看。

> ⚠️ 它用的是**你自己的账号**。点赞会亮、投币会扣、弹幕会挂在视频上、关注会被人看见。
> 额度与间隔就是护栏，默认值刻意保守。别拿去刷量。

---

## 第一次用：先扫码登录

装完之后打开 **设置 → B站互动**，第一眼看到的就是登录卡：

```
┌─────────────────────────────────────────────┐
│ 先登录 B站                                   │
│ 点赞、投币、弹幕都记在账号上，所以得先知道你  │
│ 用的是谁。点下面按钮出二维码，用 B站 手机 App │
│ 扫一下、手机上点「确认登录」。凭证只存在这台  │
│ 电脑的 ~/.dsh/bili-interactor/ 里，不上传。   │
│                                             │
│ [ 扫码登录 ]                                 │
└─────────────────────────────────────────────┘
```

点了之后：

1. 页面里直接出现二维码（不用切窗口、不用手机助手）
2. 手机 B站 App → 右上角扫一扫 → 扫它
3. 手机上点「确认登录」
4. 面板每 2 秒自己查一次，成功后变成「已登录 + 退出登录」

**没有独立网页、没有端口、没有地址要记。** 二维码直接在设置页里显示。

登录态存在 `~/.dsh/bili-interactor/credential.json`。
如果之前装过 `dsh-bili-scroll`（刷视频那个），它会把 `~/.dsh/bili-duty/bili_credential.json` 当备用凭证直接用 —— **不用重登**。

### 扫码登录是怎么实现的

不用 `bilibili_api.QrCodeLogin`：它把 `qrcode_key` 藏在私有属性里，
一个进程生成的码另一个进程查不了状态；而「重新生成」还会换一张新码，让手机上扫的那张作废。

自己按同一套接口走：

```
GET passport.bilibili.com/x/passport-login/web/qrcode/generate   → url + qrcode_key
GET passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=…
      code: 86101 未扫 / 86090 已扫待确认 / 86038 过期 / 0 成功
成功时 cookie 在返回的 url 查询串里：SESSDATA / bili_jct / DedeUserID / refresh_token
```

宿主把 `qrcode_key` 存在内存里，poll 时带回去 —— **始终是同一张码**。

---

## 它跟「刷B站」有什么不一样

| | dsh-bili-scroll（刷视频） | **dsh-bili-interactor（本插件）** |
|---|---|---|
| 核心动作 | 搜索 → 读字幕 → 挑值得看的 | 搜索 → 粗筛 → **真的点下去** |
| 产出 | 一份日报，告诉你今天看什么 | 一串动作，你的账号里真的多了几个赞 |
| 判断 | 模型读内容，写理由 | 关键词 + 播放量 + 限流策略 |
| 风险 | 基本没有（只读） | 有（写操作，动的是你的账号） |

两个插件**共用同一套登录**（`~/.dsh/bili-duty/bili_credential.json`），
所以刷视频那个插件扫码登录过一次，这边就不用再登。

---

## 面板长什么样

设置 → 左侧「**B站互动**」，四个标签页：

- **总览** —— 今天动了几次 / 还剩多少额度 / 投了几个币 / 碰过几条视频，
  外加**这一轮的过程实录**（它在搜什么、挑了哪条、为什么跳过）和最近动作流水
- **互动** —— 今天碰过的每条视频，点了什么（点赞/投币/弹幕各自一个彩色标签）
- **过程** —— 完整的过程实录，不做截断
- **设置** —— 开关、额度、关键词、弹幕风格，改完即时生效

过程实录是**中文**的，写在 `live.md` 里，每秒刷新一次。

---

## 原理（三层）

```
┌─────────────────────────────────────────────┐
│ 宿主半边 lib/index.js                        │
│  · 搜关键词 → 粗筛 → 挑目标（lib/targets.js）│
│  · 生成弹幕文案（lib/danmaku.js，有 key 用 LLM）│
│  · 记账（ledger.jsonl）、算额度（daily.json）│
│  · 挂 /api/bili-interactor/* 给面板用        │
└──────────────────┬──────────────────────────┘
                   │ spawn + JSON（只传数据，不传文件）
┌──────────────────▼──────────────────────────┐
│ 执行器 py/interact.py                        │
│  · login / login-poll / whoami / search      │
│  · info / act / run / comment                │
│  · 用 bilibili_api 和 passport 真调 B站 接口 │
│  · 只干活不判断，失败返回 {"ok":false} 不抛栈 │
└──────────────────┬──────────────────────────┘
                   │ HTTPS + cookie
┌──────────────────▼──────────────────────────┐
│ 你的 B站 账号                                │
└─────────────────────────────────────────────┘
```

**为什么拆成 Node + Python 两层**：
判断要模型、要策略、要能改，那是 Node 的活；
动作要确定性、要重试、要一个明确的 error code，那是 Python + `bilibili_api` 的活。
中间用 JSON 对话，两边都能单独跑、单独测。

**为什么写盘全在 Node 那边**：
DSH 会在沙箱里跑子进程，`~/.dsh/<插件名>` 这类目录子进程往往写不进去。
所以 python 只负责联网取数据，`credential.json` / `qr.png` / 账本一律由宿主写 ——
这条边界被 `tests/test_login.py` 钉死了（它监视每一次写盘尝试，有就失败）。

---

## 安装

```bash
# 1. 依赖（复用「刷B站」插件的 venv）
~/.dsh/bili-duty/.venv/Scripts/pip install bilibili-api-python httpx qrcode pillow

# 2. 装插件
cd ~/.dsh/profiles/desktop
pnpm add link:<本仓库路径>

# 3. 让 profile 认识它（cordis.patch.yml 末尾）
#    - insert:
#        - id: bili-interactor
#          name: dsh-bili-interactor
```

然后**重启 DSH**（客户端 bundle 是启动时建图的，光刷新页面不够）。
重启后打开设置，登录卡会直接让你扫码。

---

## 命令行（不装插件也能用）

`py/interact.py` 是独立的，直接跑：

```bash
PY=~/.dsh/bili-duty/.venv/Scripts/python

$PY py/interact.py login                          # 出二维码 base64
$PY py/interact.py login-poll --key <qrcode_key>   # 查扫码状态
$PY py/interact.py logout
$PY py/interact.py whoami
$PY py/interact.py search --keyword 恐怖游戏 --order click --limit 10
$PY py/interact.py info   --bvid BV1xxxxxxx
$PY py/interact.py act    --bvid BV1xxxxxxx --like --coin 1 --danmaku "这波可以"
$PY py/interact.py run    --plan plan.json
$PY py/interact.py comment --bvid BV1xxxxxxx --text "……"
```

> 命令行下 `login` 只吐 base64，看图自己解码：
> `... | jq -r .image | sed 's/^data:image\/png;base64,//' | base64 -d > qr.png`

全部输出 JSON：

```json
{"ok": true, "bvid": "BV1xxx", "done": [{"kind":"like","ok":true}], "failed": []}
```

---

## 配置（`~/.dsh/bili-interactor/config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxActionsPerRun` | `20` | 一轮最多动几次（**上限，不是任务量**） |
| `maxActionsPerDay` | `120` | 一天最多动几次 |
| `doLike` | `true` | 点赞 |
| `doCoin` | `true` | 投币 |
| `coinPerVideo` | `1` | 每条投几个（1 或 2） |
| `doFavorite` | `false` | 收藏（需要 `favoriteId`） |
| `doDanmaku` | `true` | 发弹幕 |
| `doFollow` | `false` | 关注 UP（**最容易被人发现，默认关**） |
| `keywords` | `["恐怖游戏","游戏解说"]` | 搜什么 |
| `order` | `click` | `click` 按播放 / `pubdate` 按最新 / `totalrank` 综合 |
| `daysBack` | `7` | 太老的不碰，`0` = 不限 |
| `minPlay` | `1000` | 播放量下限 |
| `maxPerUpPerRun` | `2` | 同一个 UP 一轮最多碰几条 |
| `actionIntervalMs` | `[1500,4000]` | 两次动作之间随机等多久 |
| `danmakuStyle` | … | 弹幕风格提示词 |
| `persona` | … | 人设，喂给写弹幕的模型 |

---

## 账本

```
~/.dsh/bili-interactor/
├── credential.json  登录凭证（含 SESSDATA，别外传）
├── qr.png           当前二维码（登录成功后自动删）
├── config.json      配置
├── ledger.jsonl     一行一个动作，append-only（好查、好删、好对账）
├── daily.json       当日计数（额度靠它）
├── live.md          过程实录（面板直接读这个）
└── interact.log     运行日志
```

`ledger.jsonl` 里每一行长这样：

```json
{"ts":"2026-10-25T01:00:00.000Z","kind":"like","ok":true,"bvid":"BV1xxx","title":"…","up":"…"}
```

**先记账再发**：发失败的那条也会留下 `ok:false` 和错误码，所以对得上账。

---

## 测试

```bash
node smoke.mjs                # 客户端：骨架、登录卡（未登录/已登录两态）、四页签渲染
node smoke-host.mjs           # 宿主：路由、state/config、未登录拦截、额度上限、总开关
python tests/test_login.py    # 登录链路：状态机、cookie 解析、不写盘的架构边界
```

`tests/test_login.py` 会监视每一次写盘尝试，断言 py 这半边**一次都没写** —— 这是架构约束，不是风格偏好。

---

## 已知限制

- **弹幕不可撤回**。写歪了就只能去 B站 手动删，或者等它过期。
- **没有真实观看时长**。它不会"看"视频，点完就走 —— 所以别指望它被认为是个活跃观众。
- **风控存在**。短时间的密集写操作会被限流（返回 `-412` / `-352`），届时这一轮会记 failed 并停下。
- **没有定时任务**。只有手动「现在跑一轮」。要不要加 cron 由你自己决定 ——
  涉及写操作的自动化，我倾向于让你每次都亲手按一下。
- **凭证是明文 cookie**。跟所有这类工具一样，`credential.json` 拿到就等于拿到你的登录态，别提交进仓库（`.gitignore` 已排除）。

---

## License

MIT
