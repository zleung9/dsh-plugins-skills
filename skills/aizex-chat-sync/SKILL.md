---
name: aizex-chat-sync
description: 把 aizex（leopard-x.memofun.net 上的 ChatGPT 镜像）的网页聊天记录增量同步成本地 Markdown 文件。当用户说「同步/备份/爬取 aizex 或 ChatGPT 聊天记录」「把网页对话存到知识库」「聊天记录归档」时使用。也用于排查 aizex 采集失败（登录失效、Chrome 调试端口没开、导出按钮点不动）。
platforms: [macos]
---

# aizex 聊天记录同步

把网页上的 ChatGPT 对话增量拉到本地目录，产出 Obsidian 友好的 Markdown。
可人工跑，也可交给定时任务（见「定时任务」一节）。

## 快速使用

```bash
# 1) 先做健康检查（把「登录失效」这种静默失败暴露出来）
node scripts/health.mjs

# 2) 看一遍打算做什么，不写文件
node scripts/sync.mjs --out "<输出目录>" --limit 5 --dry-run

# 3) 真同步
node scripts/sync.mjs --out "<输出目录>" --limit 20
```

常用参数：`--limit <n>` 单次上限（默认 20）、`--since <ISO>` 只同步更新过的、
`--throttle <ms>` 相邻请求间隔防限流（默认 200）、`--include-archived` 连归档一起、
`--write-json` 同时存原始 JSON、`--json` 输出给程序读、`--port <n>` CDP 端口、
`--state <file>` 账本路径（自动化场景必须显式指定，别落进 Vault）。

**退出码**：`0` 成功（0 条新增也是成功）/ `2` **登录态失效** / `3` 其它失败。
`2` 必须单独处理 —— 把所有失败都当成「没新内容」是最容易犯的错。

## 关键设计：走 JSON API，不要点导出按钮

页面上确实有「导出对话」入口（右侧悬浮条里 `div#sidebar-export`，提示「导出对话」，
点开是五选一的格式弹窗：文本文档 / Markdown / 长截图 / 手机长截图 / JSON），
但**自动化不要用它**：

| | 点导出按钮 | 调 JSON API |
|---|---|---|
| 交互链 | 合成事件 → 格式弹窗 → blob 下载 → 下载重定向 | 一个 fetch |
| 列表来源 | 侧栏只渲染 28 条，要滚动才更多 | `offset/limit` 分页，一次 100 条 |
| 顺序稳定性 | 点会话会重排「最近」列表 | 与界面无关 |
| 增量依据 | 无 | `update_time` 直接可比 |

实测可用接口（同源，靠会话 Cookie 鉴权）：

```
GET /backend-api/conversations?offset=0&limit=100&order=updated&is_archived=false&is_starred=false
    → { items: [{ id, title, create_time, update_time, is_starred, ... }], has_missing_conversations }
      ⚠️ limit 上限就是 100：传 200 也只回 100，必须翻页
      ⚠️ is_starred=false 的「主列表」不包含置顶会话 —— 置顶要单独拉一段
GET /backend-api/conversations?...&is_starred=true   → 置顶分段（实测 6 条，全不在主列表里）
GET /backend-api/conversations?...&is_archived=true  → 归档分段（实测 0 条，接口存在）
GET /backend-api/conversation/<uuid>     → 完整会话 JSON（含 mapping）
GET /backend-api/me                      → 登录态（200 + 有用户字段才算登录）
```

**全量 = 主列表 + 置顶 + 归档，按 UUID 去重合并**（`listAllConversations` 已封装；
置顶/归档分段失败不挡主列表，但登录失效必须抛出）。实测主列表 323 条 + 置顶 6 条
= **329 条**，而侧栏只渲染 28~32 条 —— 只看页面会漏置顶，只拉主列表也会漏，
两个坑都实测踩过。

## 仍然需要浏览器

鉴权靠 Cookie，Cookie 在 Chrome 的持久化 profile 里。所以流程是：
连上带调试端口的 Chrome → 在聊天站点同源下发 `fetch`。

```
--remote-debugging-port=9222
--user-data-dir=<采集专用 profile>     # 登录一次可管很久
--no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run
```

脚本会自动连；端口没监听时会自己拉一个 Chrome（可用 `AIZEX_CHROME_PROFILE`、
`AIZEX_CDP_PORT`、`AIZEX_CHROME_BIN` 覆盖默认值）。

**登录失效了怎么办**：用采集 profile 打开一个可见窗口，人工登录一次 aizex（
从 aizex.me 的「点此一键使用」进聊天页），之后 Cookie 会留在 profile 里。

## 去重（增量）怎么做

账本是一份 JSON（默认写在输出目录**外面**，不污染 Vault），键是会话 UUID：

```json
{ "version": 1,
  "conversations": {
    "<uuid>": { "title": "…", "file": "….md", "update_time": "2026-10-21T09:52:48.593+08:00",
                "create_time": "…", "messages": 7, "fingerprint": "首条用户消息…", "synced_at": "…" } },
  "last_run": "…", "outDir": "…" }
```

判定规则：**UUID 已存在且 `update_time` 没变 → 跳过**；变了 → 覆盖同一个文件（不新建）。
三点注意：

1. 用 UUID 做键，**不要用标题** —— 标题会重复（实测有两篇都叫「Tailscale DNS故障排查」），
   也会被网页端自动改写。
2. 文件名冲突时加 UUID 前 8 位后缀（`标题 (abcd1234).md`），并且一旦定下就记进账本复用，
   避免同一条会话在两次运行里落到不同文件名。
3. **每导出一条就落一次账**（原子写）—— 329 条跑到一半挂掉，已完成的下次不返工。
4. 账本丢了也不怕：启动时扫输出目录的 .md，从 frontmatter 的 `conversation_id`
   恢复「会话 → 文件名」映射，同一会话继续写同一个文件，不会翻倍。

## 输出格式

```markdown
---
type: chatgpt-chat
title: "…"
conversation_id: <uuid>
create_time: 2026-10-16T14:27:00.249Z   # 统一成 ISO（列表接口给 ISO 串、详情给 Unix 秒，必须归一）
update_time: 2026-10-16T14:29:17.027Z
model: gpt-6-thinking
messages: 5
starred: false
archived: false
synced_at: …
source: aizex
---
> 首条用户消息（截 160 字做引子）

### 👤 <用户消息摘要>

<用户原话>

<details><summary>💭 思考过程</summary>

<模型思考>

</details>

<模型正文>
```

会话 JSON 的形状（沿 `current_node` → `parent` 回溯即对话主线）：

```json
mapping: { "<nodeId>": { "parent": "<id|null>", "children": ["<id>"],
                          "message": { "author": {"role": "user|assistant|tool"},
                                       "content": { "content_type": "text|thoughts|reasoning_recap|…",
                                                    "parts": ["…"] | "thoughts": [{"summary": "…"}] } } } }
```

- 只保留 `role` 是 user/assistant、且 `content_type === "text"` 的节点；
  `thoughts` / `reasoning_recap` 按树结构挂到其后第一条正文上，折进 `<details>`；`tool` 节点丢弃。
- `parts` 里可能混有非字符串（图片、附件引用），只取字符串部分。
- 正文不打 H1 大标题（Obsidian 里文件名就是标题）；与站内「导出对话」不同，
  **每一轮用户消息都保留**（站内导出会把首条之后的用户消息丢掉）。

## 定时任务

**首选路径：已做进 personal-kb 插件**（采集器 `lib/collectors/aizex.mjs`）。配置里
`aizexEnabled: true` 即可，每轮 pass 自动先跑同步；`aizexMode: write` 让聊天文件夹一直
真同步（不受 pass 的 dryRun 影响）；退出码 2 会以 `NOT_LOGGED_IN` 进健康报告，绝不伪装成
「没有新内容」。脚本目录默认 `~/.agents/skills/aizex-chat-sync/scripts`（环境变量
`KB_AIZEX_SCRIPTS` 可覆盖）；账本固定在插件 dataDir 的 `aizex-sync-state.json`。
退路是 `~/.local/cron/run-0300.sh` 的 `JOBS` 列表（**别与插件同时启用**，会重复导出）：

```sh
aizex-sync|node $HOME/.agents/skills/aizex-chat-sync/scripts/sync.mjs \
  --out "<Vault>/aizex-sync" --state "<插件dataDir>/aizex-sync-state.json" --limit 30 --json
```

注意：macOS 的 cron 不补跑睡眠期间错过的任务；`run-0300.sh` 有心跳总开关
（主 agent 不在线就跳过）。要求实时性更高可以改用每小时跑一次 `--limit 10`。
全量初始化给 `--limit 400`（当前 329 条；列表上限 100/页，脚本自动翻页）。

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| 退出码 `2` / `NOT_LOGGED_IN` | Cookie 过期。打开采集 profile 的 Chrome 人工登录一次 |
| 退出码 `3` / `NO_CDP` | 9222 端口没监听，脚本会自动拉 Chrome；仍失败看 profile 路径是否存在、是否被别的 Chrome 占用 |
| 列表数突然变小 | 账号切了工作区，或 `is_archived` 过滤没传对；用 `--json` 看 `listed` |
| 有会话没同步到 | 看 `toSync` 与 `overflow`：单次 `--limit` 卡住了，调大或再跑一次；置顶会话不在主列表里，确认走的是合并列表 |
| 标题乱码 / 带斜杠 | 文件名已做 `/ : * ? " < > |` 替换与长度截断 |
| 跑到一半长时间不动 | 页面被 Chrome 冻结（Mac 睡眠/后台挂起），fetch 永不返回；已加 60s 超时+换新页重试。账本逐条落盘，重跑即续，实测挂一夜数据也没坏 |

## 复用到的既有经验

- puppeteer-core 走绝对路径引用（`~/.agents/node_modules/...`），不在技能目录里 `npm install`。
- 「没登录」必须当成健康问题抛出来，不能当成「没有新内容」—— 同样是 `x.mjs` 采集器
  和 `yt-dlp` 退出码 0 返回 0 条那类静默失败的教训。
- 写 Vault 用「先写临时文件再 rename」，避免 iCloud 同步拿到半个文件；账本同样原子写。
- 请求间加 200ms 节流防限流；标签页被关（Target closed）时重连一次再续跑。
