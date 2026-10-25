# dsh-bili-interactor

DSH 插件。让 AI 替你逛 B站 并**真的产生互动**：点赞、投币、收藏、发弹幕、评论、回评论，以及别人回你之后接着聊。

> ⚠️ 用的是你自己的账号。点赞会亮、投币会扣、评论会挂在视频下、关注会被人看见。额度和间隔是护栏，默认值刻意保守，别拿去刷量。

---

## 功能

- **刷视频**：按关键词搜，粗筛掉广告/抽奖类，同一个 UP 限条数
- **互动**：点赞 / 投币 / 收藏 / 发弹幕 / 关注，每步独立成败
- **评论**：发顶层评论，可按 UID 反查昵称 `@` 你
- **回评论**：只回「值得接话」的（模型先挑，纯复读/纯情绪不选，挑不出来就不回）
- **回复监听**：后台定时翻自己发过的楼，别人回我就接着回，条数可设上限或不限
- **学习记忆**：从评论区和自己收到的回复里挑有内容的存下来，下次说话带上
- **面板**：设置 → B站互动，六个页签（总览 / 它说了什么 / 碰过的视频 / 记忆 / 过程 / 设置）

---

## 安装

```bash
# 1. Python 依赖
~/.dsh/bili-duty/.venv/Scripts/pip install bilibili-api-python httpx qrcode pillow

# 2. 装进 profile
cd ~/.dsh/profiles/desktop
pnpm add link:<本仓库路径>

# 3. 让 profile 认识它（cordis.patch.yml 末尾追加）
#    - insert:
#        - id: bili-interactor
#          name: dsh-bili-interactor
```

装完重启 DSH 一次（首次建 bundle 用），之后改代码只需刷新页面。

---

## 第一次用

1. 打开 **设置 → B站互动**
2. 点 **扫码登录**，页面里直接出二维码
3. 手机 B站 App → 右上角扫一扫 → 点「确认登录」
4. 面板显示「已登录 + 退出登录」就成了

二维码有效期 180 秒，前台会显示倒计时；没扫完离开页面不影响，宿主在后台继续轮询。

登录成功会写两份凭证：

- `~/.dsh/bili-interactor/credential.json`（本插件自己用）
- `~/.dsh/bili-duty/bili_credential.json`（给 `dsh-bili-scroll` 共用，只写不删）

---

## 面板

| 页签 | 内容 |
|---|---|
| 总览 | 今天动了几次 / 剩余额度 / 投币数 / 上一轮结果，可手动「现在跑一轮」 |
| 它说了什么 | 评论、回评论、回我、私信的全部原文，带「跳到这条评论」链接 |
| 碰过的视频 | 今天碰过的视频和动作标签，带「跳到评论」 |
| 记忆 | 学到的每条内容、分数、好在哪、来源；可单条删除、可手动添加 |
| 过程 | 这一轮在搜什么、挑了哪条、为什么跳过 |
| 设置 | 全部开关和限额 |

跳转用的是 B站 的 `#reply<rpid>` 锚点，会滚到对应评论并高亮。楼中楼跳的是楼层根评论（B站 只认顶层评论锚点）。

---

## 配置

配置存在 `~/.dsh/bili-interactor/config.json`，也可以直接在面板「设置」里改。

**额度**

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxActionsPerRun` | `20` | 一轮最多动几次 |
| `maxActionsPerDay` | `120` | 一天上限，`0` = 不限 |

**动作**

| 键 | 默认 | 说明 |
|---|---|---|
| `doLike` / `doCoin` / `doFavorite` / `doDanmaku` / `doFollow` | 见默认配置 | 各类动作开关 |
| `coinPerVideo` | `1` | 每条投几个币（1 或 2） |
| `favoriteId` | `0` | 收藏夹 ID，`0` = 不收 |
| `actionIntervalMs` | `[1500, 4000]` | 两次动作之间随机等待 |

**选视频**

| 键 | 默认 | 说明 |
|---|---|---|
| `keywords` | `["恐怖游戏","游戏解说"]` | 搜什么 |
| `order` | `click` | `click` 按播放 / `pubdate` 按最新 / `totalrank` 综合 |
| `daysBack` | `7` | 太老的不碰，`0` = 不限 |
| `minPlay` | `1000` | 播放量下限 |
| `maxPerUpPerRun` | `2` | 同一个 UP 一轮最多碰几条 |
| `skipKeywords` | 广告/抽奖/… | 标题命中就不碰 |

**评论**

| 键 | 默认 | 说明 |
|---|---|---|
| `doComment` | `true` | 发顶层评论 |
| `doReplyComment` | `true` | 回别人的评论 |
| `replyCount` | `2` | 每条视频最多回几条（0 = 不回，只发顶层） |
| `mentionUid` | `0` | `@` 谁，填 UID，`0` = 不 `@` |
| `persona` / `commentPersona` | — | 人设，写多长都行，不截断 |

**回复监听**

| 键 | 默认 | 说明 |
|---|---|---|
| `doReplyBack` | `true` | 别人回我就回他 |
| `replyBackMax` | `0` | 每条评论下最多回几句，`0` = 不限 |
| `listenIntervalMin` | `1` | 每几分钟查一次 |
| `listenMaxThreadsPerTick` | `15` | 每轮最多查几个楼（楼多时轮流） |
| `listenLookbackHours` | `72` | 只往回看多少小时内自己发的评论 |
| `replyBackMinLen` | `2` | 对方回复太短就不理 |

**学习**

| 键 | 默认 | 说明 |
|---|---|---|
| `doLearn` | `true` | 开关 |
| `learnPerRun` | `3` | 一轮最多记几条 |
| `learnUseCount` | `8` | 说话时参考几条 |
| `learnMinScore` | `6` | 低于这个分不记（0~10） |
| `learnPrompt` | 见默认配置 | **你自己定的挑选标准**，会原样塞进模型提示词 |

---

## 数据文件

```
~/.dsh/bili-interactor/
├── credential.json   登录凭证（含 SESSDATA，别外传）
├── config.json       配置
├── ledger.jsonl      一行一个动作，append-only
├── learned.jsonl     记忆，一行一条，带分数/理由/来源
├── replied.json      已经回过的子评论 rpid（防重复回）
├── daily.json        当日计数（额度靠它）
├── live.md           过程实录（面板直接读这个）
├── interact.log      运行日志
└── login.json        未扫完的二维码快照（key + 图，成功后删）
```

`ledger.jsonl` 每行：

```json
{"ts":"2026-10-25T01:00:00.000Z","kind":"comment","ok":true,"bvid":"BV1xxx","text":"…","rpid":"318129595649"}
```

---

## 命令行

`py/interact.py` 可以单独跑，全部输出 JSON：

```bash
PY=~/.dsh/bili-duty/.venv/Scripts/python

$PY py/interact.py whoami
$PY py/interact.py search   --keyword 恐怖游戏 --order click --limit 10
$PY py/interact.py info     --bvid BV1xxxxxxx
$PY py/interact.py act      --bvid BV1xxxxxxx --like --coin 1 --danmaku "这波可以"
$PY py/interact.py comment  --bvid BV1xxxxxxx --text "……"
$PY py/interact.py comments --bvid BV1xxxxxxx --order time --limit 20
$PY py/interact.py sub-replies --bvid BV1xxxxxxx --rpid 123456
```

> 扫码登录走宿主（`lib/login.mjs`），凭证在响应头里，python 侧不再参与登录。

---

## 结构

```
lib/index.js     宿主：路由、调度、监听器、记账
lib/login.mjs    扫码登录（Node，从 Set-Cookie 取凭证）
lib/targets.js   搜索、粗筛、挑目标
lib/danmaku.js   文案生成（有 DeepSeek key 用模型，否则模板）
lib/learn.js     记忆的读写与淘汰
lib/state.js     配置、账本、日额度
py/interact.py   执行层：只调 B站 接口，只干活不判断
client.js        设置页面前端
```

写盘全部在 Node 侧，python 只负责联网 —— DSH 沙箱下子进程写不进 `~/.dsh/<插件名>`，这条边界由 `tests/test_login.py` 断言。

---

## 测试

```bash
node smoke.mjs                       # 客户端渲染、六个页签、跳转链接
node smoke-host.mjs                  # 宿主路由、状态、各类拒绝路径
node tests/test_login_flow.mjs       # 扫码→自动登录→凭证落盘→界面变已登录
node tests/test_cookie_parse.mjs     # Set-Cookie 取凭证
node tests/test_qr_ttl.mjs           # 二维码时间预算
node tests/test_scan_then_expire.mjs # 扫了没确认就过期
node tests/test_proactive_refresh.mjs
node tests/test_reply_pick.mjs       # 「值得接话」的筛选
node tests/test_learn_mention.mjs    # @ 去重、记忆读写
python tests/test_comment_result.py  # 评论结果判定
python tests/test_login.py           # python 侧零写盘
```

---

## 已知限制

- **弹幕不可撤回**（B站 限制：2 分钟内、每天 5 条），写歪了只能手动删
- **评论可能进审核**：新号评论公开列表里可能暂时看不到，但 `code: 0` 就是发出去了
- **有风控**：短时间密集写操作会返回 `-412` / `-352`，命中后这一轮直接停
- **不"看"视频**：只按标题/简介/播放量判断，没有真实观看时长
- **凭证是明文 cookie**：拿到 `credential.json` 就等于拿到登录态，别提交进仓库

---

## License

MIT
