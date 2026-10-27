# dsh-bili-interactor

让 AI 替你在 B站 上真的产生互动 —— 刷视频、点赞、投币、发弹幕、发评论、回评论，以及别人回你之后接着聊。

一个 [DSH](https://github.com/deepseek-ai)（DeepSeek Harness）插件。在 **设置 → B站互动** 里操作，不用另开网页。

> **用的是你自己的账号。** 点赞会亮、投币会扣、评论会挂在视频下、关注会被人看见。
> 默认参数刻意保守，请自己控制量 —— 大量重复操作很可能被 B站 判定为异常并折叠、限流或封禁。
> 详见文末的[风险与免责](#风险与免责)。

---

## 它做什么

- **刷视频**：按关键词搜索，粗筛掉广告/抽奖类内容，同一个 UP 主一轮内限量
- **互动**：点赞 / 投币 / 收藏 / 发弹幕 / 关注，每项独立成败，互不影响
- **发评论**：给视频发一条新评论，可以 `@` 指定的人
- **读内容再说话**：先取视频的 B站 AI 字幕（没有就本地转写，再没有就看弹幕），所以评论说的是视频里真正讲了什么
- **回评论**：从别人的评论里挑「值得接话」的回 —— 挑之前也会先看一遍视频内容，判断才准；纯情绪、复读、广告不选，挑不出来就不回
- **接着回**：后台定时检查自己发过的评论，有人回了就接着聊 —— 条数可设上限，也可设成不限
- **聊太多就撤**：跟同一个人在同一个视频下来回聊到一定轮数，会先「审查」这段对话有没有营养、对方像不像真人。判定没营养（比如两边都是 AI 在互相捧场）就发最后一句表明不再聊，之后在这个视频下不再回复他
- **跳过刷过的**：记住刷过哪些视频，之后不再重复推同一条（可关）
- **学习说话规律**：不是抄别人的句子，而是从真人评论里总结「怎么说话才像真人」的可执行规律，跑得越多 AI 味越淡
- **都看得见**：面板里能查到它说过什么、在哪些视频下说过、哪些评论真的被别人看到了、有多少条别人根本刷不到

三种「说」要分清，面板里也这么标：

| 标签 | 含义 | 谁先开口 |
|---|---|---|
| **评论** | 我在视频下发的新评论 | 我 |
| **回评论** | 别人发了评论，我去接他的话 | 别人 |
| **接着回** | 别人回的是我发过的评论，我接着聊 | 别人（冲我来的） |

> 设置里改任何一项都是**立刻保存、立刻生效**的，不需要重启 DSH。设置页顶部有一条常驻状态条告诉你存没存上。
> 「现在跑一轮」如果正好撞上后台监听在跑，会**排队**等它结束再自动开始，不用你反复点。


---

## 截图

> 图里是演示数据，不是真实账号内容。

**总览** —— 今天动了多少次、额度用了多少、这一轮在干什么

![总览](assets/shots/01-overview.png)

**它说了什么** —— 每条原文都在，可跳到对应楼层、可检查是否真的公开

![它说了什么](assets/shots/02-talk.png)

**碰过的视频** —— 每条视频下我说过什么，带直达链接

![碰过的视频](assets/shots/03-videos.png)

<details>
<summary>另外三页（记忆 / 过程 / 设置）</summary>

**记忆** —— 学到了什么、几分、为什么记、从哪来

![记忆](assets/shots/04-memory.png)

**过程** —— 这一轮的实时实录，包括为什么跳过某条

![过程](assets/shots/05-process.png)

**设置** —— 全部开关和限额

![设置](assets/shots/06-settings.png)

</details>

---

## 环境要求

| 需要什么 | 必须吗 | 用途 | 大小 |
|---|---|---|---|
| **DSH**（Desktop 版，带插件系统） | 必须 | 宿主 | — |
| **Python 3.10+** + `bilibili-api-python httpx qrcode pillow` | 必须 | 调 B站 接口、渲染登录二维码 | ~100MB |
| 一个 B站 账号（建议小号） | 必须 | 干活的那个号 | — |
| **DeepSeek API key** | 可选 | 有 key 才按人设说话；没有就退回内置模板 | — |
| **本地转写环境**（Whisper） | **绝大多数人不需要** | 只有连 AI 字幕都没有的视频才用得上 | 700MB~1.5GB |

### 关于「它怎么知道视频在说什么」

**它读的是文字，不是画面**：模型拿到的是视频的字幕文本，不解码画面、不听声音。

好消息是——**大多数视频都有字幕，不需要下载任何东西**。B站的 AI 字幕（`ai-zh`）覆盖很广，
插件调 `player/info` 接口就能拿到，实测 4 个不同类型的视频全都有：

| 视频 | 字幕条数 | 语言 |
|---|---|---|
| 部署教程 | 1 | `ai-zh` 中文 |
| 官方 MV | 12 | `zh-CN` / `zh-Hans` / `zh-Hant` … |
| 748 集课程 | 1 | `ai-zh` 中文 |
| 大肥鱼整活 | 8 | `ai-zh` / `ai-en` / `ai-ja` |

四层降级：

| 层 | 手段 | 条件 | 要装东西吗 |
|---|---|---|---|
| ① | **B站 字幕**（`ai-zh` 优先） | 大多数视频都有 | **不要** |
| ② | **本地 Whisper 转写**（`py/asr.py`） | 连 AI 字幕都没生成的极少数视频 | 要，~500MB 模型 |
| ③ | **弹幕池** | 永远可用。观众会把重点和坑打在屏幕上 | 不要 |
| ④ | 只有标题/简介 | 上面都没有时。过程实录里会写明「只有标题」 | 不要 |

**默认只用 ①③④，不下载任何东西。** 第 ② 层是给你想覆盖「连字幕都没有」那种视频时用的，
默认关闭，不装也完全不影响正常使用。

DeepSeek API key 是**可选**的：有 key 时评论/回复由模型按你的人设生成；没有 key 会退回内置模板，人设不生效（面板顶部会提示）。

---

## 安装

### 从插件市场装（推荐）

在 DSH 的插件市场里搜 `B站互动` 或 `dsh-bili-interactor`，点安装。

或者直接一条命令：

```bash
dsh plugin --profile desktop add github:acttk/dsh-bili-interactor
```

> 市场条目里**没有锁版本** —— 安装时直接 clone 仓库的 `main` 分支，
> 所以你拿到的是**安装那一刻的最新代码**。

### 装完第一件事：让它自己检查环境

面板顶部会**自动**做一次环境自检，缺什么直接列出来，带一个「一键装依赖」按钮
（会自动建虚拟环境并 pip install，不用你手动敲命令）。

如果你更喜欢手动：

```bash
cd ~/.dsh
python -m venv bili-interactor/.venv
# Windows:
bili-interactor/.venv/Scripts/pip install bilibili-api-python httpx qrcode pillow
# macOS / Linux:
bili-interactor/.venv/bin/pip install bilibili-api-python httpx qrcode pillow
```

> 插件按这个顺序找解释器：配置项 `pythonPath` → `~/.dsh/bili-interactor/.venv`
> → `~/.dsh/bili-duty/.venv`（和另一个插件共用的兼容路径） → `PATH` 上的 `python`。
> **正常情况下你不用管这个**，自检会告诉你找到的是哪个。

### 可选：装本地转写（**大多数人不用装**）

先看情况再决定：

- 视频有 B站 字幕（**大多数都有**，包括 AI 字幕）→ **什么都不用装**，插件直接读
- 视频连 AI 字幕都没有（纯音乐、无声录屏、少数冷门视频）→ 才需要这一层

要装的话：

```bash
# 在仓库根目录跑，会自动建 ~/.dsh/bili-interactor/.venv-asr 并预热模型
# Windows:
powershell -ExecutionPolicy Bypass -File scripts/setup-asr.ps1
# macOS / Linux:
bash scripts/setup-asr.sh

# 想更准可以换模型（tiny / base / small / medium，默认 small）
powershell -ExecutionPolicy Bypass -File scripts/setup-asr.ps1 medium
```

装完去设置里打开 **「没字幕才本地转写」**。

> 模型走 `hf-mirror.com` 国内镜像，不用梯子。第一次跑会加载模型（几十秒），之后就是本地读。
> 如果本机已经装了「刷B站」插件，它的转写环境会被自动复用，不用重复装。

### 手动装进 profile（只有从源码开发时才需要）

从市场装的话**跳过这一节**。

```bash
# 2. 装进 profile
cd ~/.dsh/profiles/desktop
pnpm add link:<本仓库路径>

# 3. 让 profile 加载它：cordis.patch.yml 末尾加上
#    - insert:
#        - id: bili-interactor
#          name: dsh-bili-interactor
```

装完**重启一次 DSH**（首次要构建前端 bundle），之后改代码只需刷新页面。

---

## 第一次用

1. 打开 **设置 → B站互动**
2. 点 **扫码登录**，面板里会直接出二维码
3. 手机 B站 App → 右上角扫一扫 → 点「确认登录」
4. 面板变成「已登录」，就能用了

二维码 180 秒有效，面板里有倒计时。没扫完就离开页面也没关系，宿主在后台继续轮询，扫上了会自动变成已登录。

登录成功的凭证存在 `~/.dsh/bili-interactor/credential.json`（含 SESSDATA，别外传、别提交）。

---

## 面板

| 页签 | 能看什么 |
|---|---|
| **总览** | 今天动了几次、剩多少额度、投币数、上一轮结果；**可见性告警**（有多少条别人看不到）；可以手动「现在跑一轮」；按时间范围批量查可见性 |
| **它说了什么** | 评论、回评论、接着回、私信的全部原文；带「跳到这一楼」和「复制正文」；每条都标了「公开 / 仅自己可见 / 查不到」 |
| **碰过的视频** | 今天碰过的视频卡片：标题、UP、各种动作次数、我在这条下说过的话（带直达）；可筛「我说过话的」 |
| **不再回复的人** | 聊太多被判定没营养之后记下来的人：名字、聊了几轮、原因、视频链接；可逐个「恢复回复」或全部清空 |
| **记忆** | 学到的**说话规律**（不是别人原话）、分数、为什么记、来源；可单条删除、可手动添加 |
| **过程** | 这一轮的实时实录：在搜什么、挑了哪条、为什么跳过、失败原因、审查结果 |
| **设置** | 全部开关和限额；顶部有常驻保存状态条 |

> 可见性检查按**楼**分组查，不是按条查 —— 一个楼只发 2 次请求就能判断这个楼里我所有评论的可见性，
> 比按条查省 6 倍请求，不容易触发风控。

---

## 配置

配置存在 `~/.dsh/bili-interactor/config.json`，也可以直接在面板「设置」里改。所有上限填 `0` 都是**不限**。

### 额度

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxVideosPerRun` | `5` | **一轮刷几条视频**（你真正想调的那个） |
| `maxActionsPerRun` | `20` | **一轮最多动几次**（点赞/投币/弹幕/评论/回复全算），是护栏 |
| `maxActionsPerDay` | `120` | 一天最多动几次（管「跑一轮」，不含监听回复） |

> 三个数字别搞混：`maxVideosPerRun × (2 + replyCount)` 才是一轮大约的动作数。
> 比如每轮刷 5 条、每条跟 2 个人搭话 → 一条视频约 4 个动作 → 一轮约 20 个，
> 正好等于 `maxActionsPerRun`。超了就会被护栏拦住，「刷几条视频」根本轮不完 ——
> 设置页会直接把这两个数算给你看，超了变黄字提醒。

### 动作

| 键 | 默认 | 说明 |
|---|---|---|
| `doLike` / `doCoin` / `doDanmaku` | `true` | 点赞 / 投币 / 发弹幕 |
| `doDigest` | `true` | 先摘视频内容（字幕/弹幕）再说话，评论才不会只吐槽标题 |
| `doTranscribe` | `false` | 没字幕时用本地 Whisper 转写（准但慢，一条 1~2 分钟，需装转写环境） |
| `doWatch` | `false` | 上报观看进度。**这是在刷播放数据，默认关，容易被识别** |
| `watchStyle` | `fast` | `fast` 几秒上报完；`real` 按真实节奏走完（更慢但更像真人） |
| `doFavorite` / `favoriteId` | `false` / `0` | 收藏，需要填收藏夹 ID |
| `doFollow` | `false` | 关注 UP（最容易被人发现，默认关） |
| `coinPerVideo` | `1` | 每条投几个币 |
| `actionIntervalMs` | `[1500, 4000]` | 两次动作之间的随机间隔 |

### 选视频

| 键 | 默认 | 说明 |
|---|---|---|
| `keywords` | `["恐怖游戏","游戏解说"]` | 搜什么 |
| `order` | `click` | `click` 按播放 / `pubdate` 按最新 / `totalrank` 综合 |
| `daysBack` | `7` | 太老的不碰，`0` = 不限。**服务端筛，不是本地事后过滤** |
| `minPlay` | `1000` | 播放量下限 |
| `maxPerUpPerRun` | `2` | 同一个 UP 一轮最多碰几条 |
| `skipKeywords` | 见默认值 | 标题命中就跳过 |
| `skipSeenVideos` | `true` | 跳过刷过的视频，不再重复推同一条 |

> **`daysBack` 交给 B站 服务端筛**（`time_start` / `time_end`），不是下载 42 条再本地砍。
> 这点很关键：按播放排序返回的天然是历史爆款，本地砍完必然剩 0 —— 会表现为「这轮空手」。
> 另外 `time_range` 参数筛的是**视频时长**，不是发布时间，别搞混。

### 评论

| 键 | 默认 | 说明 |
|---|---|---|
| `doComment` | `true` | 发新评论 |
| `doReplyComment` / `replyCount` | `true` / `2` | 回别人的评论；**每条视频最多跟几个人搭话**（是人数，不是句数） |
| `mentionUid` | `0` | `@` 谁（填 UID），`0` = 不 `@` |
| `persona` / `commentPersona` | 见默认值 | 人设提示词，写多长都行 |

### 接着回（回复监听）

| 键 | 默认 | 说明 |
|---|---|---|
| `doReplyBack` | `true` | 开关 |
| `replyBackMax` | `0` | 每条评论下最多回几句，`0` = 不限 |
| `replyBackPerDay` | `0` | 一天最多回几条，`0` = 不限 |
| `replyBackMinLen` | `2` | 对方回复太短就不理 |
| `listenIntervalMin` | `1` | 每几分钟查一次 |
| `listenMaxThreadsPerTick` | `15` | 每次最多看几条「我发过的评论」（多了轮流） |
| `listenLookbackHours` | `72` | 只往回看多少小时内自己发的评论 |
| `deepTalkLimit` | `10` | 跟同一个人在同一视频下来回聊到这么多轮就**审查**；判定没营养就发最后一句后不再回复他。`0` = 关掉 |

> `listenMaxThreadsPerTick` 直接决定请求频率：填 20 就是每分钟最多 20 次请求。
> 楼很多时它会轮流看，几轮转完一圈，不会漏。
>
> **「查几楼」和「隔几分钟」要一起调**：两个乘起来决定「多久能发现新回复」，
> 除起来决定「每分钟发多少请求」。楼多了之后建议 20 楼 / 5 分钟，
> 一圈约 1 小时、每分钟 4 次请求 —— 比 50 楼 / 2 分钟（每分钟 25 次）稳得多。

### 学习

| 键 | 默认 | 说明 |
|---|---|---|
| `doLearn` | `true` | 开关 |
| `learnPerRun` | `3` | 一轮最多记几条 |
| `learnUseCount` | `8` | 说话时参考几条 |
| `learnMinScore` | `6` | 低于这个分不记（0~10） |
| `learnPrompt` | 见默认值 | **你自己写的标准**，会原样交给模型 |

**它记的是规律，不是别人的原话。** 分两类：

| 类型 | 是什么 | 怎么用 |
|---|---|---|
| **规律**（rule） | 可执行的写法，如「先甩结论再补理由，别铺垫」 | 下次写评论时**必须照着做** |
| **例句**（quote） | 别人的原话 | 只用来感受语感，**一个字都不许照抄** |

为什么这样设计：以前是「从评论区挑出说得好的句子存起来」，结果模型只会模仿那些句子，
写出缝合怪 —— 记的是「别人说了什么」，不是「怎么说话」。现在改成从真人评论里提炼
「怎么说话才像真人」的可执行规律（真人的回复短、有情绪、会跑题、只说半句；
AI 的回复工整、面面俱到、爱总结、爱升华），跑得越多 AI 味越淡。

> 旧数据（没有 `kind` 字段）会自动当成「例句」处理，不会丢。

---

## 数据文件

全部在 `~/.dsh/bili-interactor/`：

```
credential.json   登录凭证（含 SESSDATA，别外传）
config.json       配置
ledger.jsonl      一行一个动作（超过 3MB 自动只留最近 2000 行）
learned.jsonl     学到的规律/例句，一行一条
replied.json      已回过的子评论（防重复回）
seen.json         刷过的视频（跳过用，最多留 3000 条）
ignored.json      不再回复的人（按 视频+用户 记）
visibility.json   哪些评论是「别人能看到」的
daily.json        当日计数
live.md           过程实录
interact.log      运行日志
```

---

## 命令行

`py/interact.py` 可以单独用，全部输出 JSON：

```bash
PY=~/.dsh/bili-interactor/.venv/Scripts/python   # macOS/Linux: .venv/bin/python3

$PY py/interact.py whoami
$PY py/interact.py search    --keyword 恐怖游戏 --order click --limit 10
$PY py/interact.py comments  --bvid BV1xxxxxxx --order time --limit 20
$PY py/interact.py act       --bvid BV1xxxxxxx --like --coin 1 --danmaku "这波可以"
$PY py/interact.py comment   --bvid BV1xxxxxxx --text "……"
$PY py/interact.py sub-replies --bvid BV1xxxxxxx --rpid 123456
$PY py/interact.py visible   --bvid BV1xxxxxxx --rpid 123456
$PY py/interact.py digest    --bvid BV1xxxxxxx      # 摘视频内容（字幕/弹幕/简介）
$PY py/interact.py transcribe --bvid BV1xxxxxxx     # 本地转写（慢，要装转写环境）
$PY py/interact.py watch     --bvid BV1xxxxxxx      # 上报观看（会产生观看记录）
```

登录走宿主（`lib/login.mjs`），凭证在 `Set-Cookie` 响应头里。

---

## 代码结构

```
lib/index.js     宿主：HTTP 路由、调度、回复监听、审查、记账
lib/login.mjs    扫码登录（Node 侧，从 Set-Cookie 取凭证）
lib/targets.js   搜索、粗筛、挑目标
lib/danmaku.js   文案生成（评论/回复/弹幕/审查/告别）、学习提炼
lib/learn.js     说话规律的读写、去重、淘汰
lib/seen.js      刷过的视频（跳过用）
lib/ignore.js    不再回复的人（纯本地，不做任何 B站 拉黑）
lib/state.js     配置、账本、当日额度、本地时间
py/interact.py   执行层：只调 B站 接口，只干活不判断
py/asr.py        本地转写（Whisper，把没字幕的视频读成文字）
client.js        设置页面前端
```

写盘全部在 Node 侧，Python 只负责联网 —— DSH 沙箱下子进程往往写不进 `~/.dsh/<插件名>`。
这条边界由 `tests/test_login.py` 断言（它会监视每一次写盘尝试）。

---

## 测试

```bash
node smoke.mjs                          # 前端渲染、七个页签、跳转链接
node smoke-host.mjs                     # 宿主路由、状态、拒绝路径

# 契约与界面规则（这几条是踩过坑之后补的，别删）
node tests/test_state_serializable.mjs   # /state 必须永远能序列化（Timer 会挂死接口）
node tests/test_hooks_strict.mjs         # 真 React 的 hooks 顺序（放错位置整块面板崩）
node tests/test_hooks_order.mjs          # hooks 不能在提前 return 之后
node tests/test_backnow.mjs              # 「立刻检查一次」的返回契约
node tests/audit_contract.mjs            # 全量交叉检查：配置项/接口/开关有没有没闭环的

# 功能
node tests/test_no_reply.mjs            # 聊太多不再回复（作用域、轮数统计）
node tests/test_visibility_scan.mjs     # 可见性按楼分组、时间窗过滤
node tests/test_vis_busy.mjs            # 可见性扫描的忙判断（查过一次还能再查）
node tests/test_seen.mjs                # 跳过刷过的视频
node tests/test_reply_select.mjs        # 挑评论兜底：按信息量不按字数
node tests/test_reply_pick.mjs          # 「值得接话」的筛选
node tests/test_learn_rule.mjs          # 学习：规律去重、例句不挤掉规律
node tests/test_learn_mention.mjs       # @ 去重、记忆读写
node tests/test_dedupe.mjs              # 同一个楼不重复回
node tests/test_digest.mjs              # 视频内容摘取
node tests/test_login_flow.mjs          # 扫码 → 自动登录 → 凭证落盘 → 界面变已登录
node tests/test_cookie_parse.mjs        # 从 Set-Cookie 取凭证
node tests/test_qr_ttl.mjs              # 二维码有效期预算
node tests/test_scan_then_expire.mjs    # 扫了没确认就过期
node tests/test_proactive_refresh.mjs   # 主动换码

python tests/test_comment_result.py     # 评论结果判定（含 12014 频率上限）
python tests/test_login.py              # Python 侧零写盘

# 需要插件正在运行（真实端到端）
python tests/probe_endpoints.py http://127.0.0.1:<端口>
python tests/probe_userpath.py  http://127.0.0.1:<端口>
```

---

## 已知限制

- **弹幕收不回**（B站 限制：发出后 2 分钟内、每天 5 条），写歪了只能手动删
- **评论可能只有你自己看得见**：`code: 0` 只代表 B站 收下了。新号、敏感内容、短时间大量评论会被折叠或送审 ——
  面板的「可见性」卡片就是查这个：选个时间范围（1 小时 / 24 小时 / 3 天 / 全部），
  立刻把这段时间里所有评论的可见性过一遍，列出哪些别人根本刷不到。别以为发出去了别人就能看到
- **被折叠多半是内容问题，不是频率问题**：实测被折叠的评论几乎都是攻击性言论。
  降频率救不了这个，改内容才行 —— 毒舌可以，骂人不行
- **有频率上限**：短时间内发太多评论会返回 `12014`，这一轮会自动停下
- **有风控**：密集写操作可能返回 `-412` / `-352` / `-101`
- **它"看"视频的方式是读字幕文本，不是看画面**：拿 B站 字幕（`ai-zh` 优先）当材料，
  没有字幕时可以用本地 Whisper 转写，再没有就靠弹幕池 —— 它不会解码画面、也不听声音
- **它不上报观看**（默认）：不会给视频刷播放量。开了「上报观看」才会，那属于刷数据，风险自担
- **没有定时「跑一轮」**：只有手动触发和回复监听（写操作要你亲手按）
- **圈子刷久了会干**：同一个小圈子（比如某个关键词）就那么几条视频，刷过之后
  「跳过刷过的」会把它们全筛掉，表现为「这轮空手」。这不是 bug ——
  加新关键词、把「只看最近几天」调大、或清掉已刷记录就能解决

---

## 风险与免责

- 这是**非官方**工具，使用的是网页端接口。B站 可能随时调整接口或提高风控等级。
- **请不要用它刷量、发广告、引战、批量骚扰**。这类行为违反 B站 社区规则，可能导致账号被限制或封禁。
- 自动化操作本身就有被判定为异常的风险。**建议用小号**，并且把各项上限设在合理范围。
- 使用者需自行承担使用本工具的一切后果。作者不对账号受限、内容被删、数据丢失等任何损失负责。
- 项目仅供学习和个人研究使用。

---

## License

MIT
