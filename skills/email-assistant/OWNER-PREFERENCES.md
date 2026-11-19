# Owner Preferences — email-assistant

持久化记录 owner 对 email-assistant 的偏好。每次运行应读取本文件并遵循。

## 回复格式 / 风格（2026-09-15 确定）

**偏好**：owner 喜欢「调研结果：Dario Amodei《We Must Pace the Frontier》」
那一封回复的页面格式与风格，要求**以后所有 email-assistant 回复统一采用
该样式**。

- 参考归档：`~/email-assistant/archive/2026-09/2026-09-14-1501-5680EBD7-调研X帖子-Dario-on-slowing-down-the-AI-resea/reply.html`
- 可复用模板：`reply-style-template.html`（与本文件同目录）
  - 内含该样式完整的 `<style>` 块 + 结构骨架 + 每一块用途的 HTML 注释。
  - **Stage 2 生成 reply.html 时，复制其 `<style>` 整段原样使用**，
    不要改色板 / 字号 / 容器宽度 / 间距——这些就是 owner 认可的样子。
  - 按 <body> 骨架组织内容：H1 标题 + .meta + .rule 短横线 → 「过程（我做了什么）」
    <ol> → <hr> → 「一、二、三」H2 大节 / H3 小节 / blockquote 引文 / table →
    <hr> → .callout「一句话总结」→ .signoff 署名行。
- 短回复（单段、无结构、无数学）仍可跳过 HTML，直接 `--text` 发 reply.md。

### 该样式的关键视觉特征（owner 认可点）

- 单列居中白底容器，max-width 664px，淡灰页面背景 `#f5f6f8`。
- 正文 15.5px / 行高 1.78，中文优先字体栈（PingFang SC 在前）。
- 标题 H1 25px 加粗，下方一条 46px 强调色短横线 `.rule`。
- 标题下 `.meta` 行：作者·日期·来源，12.5px 浅灰。
- 层级靠字号/字重建立，不靠色块：H2 18.5px 带下边框，H3 16px。
- 引文用左侧竖线 blockquote（斜体浅灰）；表格带细边框、表头浅底。
- 「一句话总结」用 `.callout`（左强调色竖条 + 浅底 + 小标签）。
- 配色克制：墨色正文 + 单一强调色 `#355c7d`（蓝灰），无渐变、无图标、无花哨。

## 邮件引用与会话归组（2026-10-24 提出，2026-10-26 落实）

- 新回复放前面，末尾附“此前对话”，像普通邮件往来一样保留来信及已有引用。
- 同一线程的更早归档可用时，按从新到旧补充，避免重复；不编造缺失历史。
- 在 `reply.md` 中保留引用正文，再渲染为安全转义的 HTML blockquote。
- 发送时填写 `In-Reply-To` 和 `References`，并保留 `X-Source` 标记。
- 运行提示 `~/.local/cron/prompts/email-assistant.md` 已同步此要求。

## 运行模型：email-assistant 专属 profile（2026-09-25 确定）

**偏好**：owner **不要全家桶**。只把 email-assistant 切到 DeepSeek-V4.1，
两个 digest（x-digest / nature-digest）继续用 glm-5.3。

**落地方式**（已实现，勿随意改动）：

- 新建独立 dsh profile `email`：`~/.dsh/profiles/email/`，是 `headless`
  的克隆，但 `cordis.patch.yml` 把 `settings` 插件的 `path` 重定向到
  `~/.dsh/email-assistant-settings.yaml`（该文件把 `agent-default-model`
  设为 `huawei/deepseek-v4.1-flash`）。
- 为什么必须独立 profile：`dsh` 所有 entry point 共用 `$DSH_HOME`，而
  `~/.dsh/settings.yaml` 的 `agent-default-model` 会**压过** profile 树
  （`dsh-agent-default-model` 安装该 settings section 并替换 source）。
  所以单纯给 `headless` 打 patch 赢不了它；必须换 settings 文档。
- poller：`poll_inbox.py` 的 `DSH_PROFILE`（默认 `email`）决定用哪个 profile；
  `run_dsh()` 用 `[DSH_BIN, "--profile", DSH_PROFILE, ...]`。
- `~/.dsh/settings.yaml` 保持 `glm-5.3`（digests 用）。
- 回滚：把 `poll_inbox.py` 的 `DSH_PROFILE` 改回 `headless` 即可；
  profile 目录留着无害。

## 记忆系统：memory folder + 做梦 + 加强/减弱（2026-09-25 确定）

**偏好**：owner 同意建 memory folder，并要求 (a) 一个**做梦机制**——把
当天关注点与过去记忆抽取成文件存进 **Obsidian**、文件间建立关联；
(b) 一个**加强/减弱机制**——反复关注的话题加强、其他减弱。

**落地方式**（详见 `memory/DREAM-DESIGN.md`）：

- 存储：`memory/interests.jsonl`（无损日志）+ `memory/topics.json`
  （主题簇/权重）+ `memory/INDEX.md`（每轮读的短工作记忆）。
- 做梦：`memory/dream.py`，**每晚 03:00** 由
  `~/.local/cron/dream-run.sh` 跑（纯脚本，非 LLM 任务——避免 cron 沙箱问题）。
- Obsidian 落点：vault `06-Memory/`（主题笔记 + `DREAMS/` + `_Memory.md` MOC）。
  vault 路径 = `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/llm-wiki`
  （iCloud，非 Nutstore；以 obsidian.json 里 open 的 vault 为准）。
- 加强：$w \leftarrow \min(1, w + 0.25(1-w))$（饱和，收益递减）。
- 减弱：$w \leftarrow w \cdot e^{-0.05\Delta t}$（半衰期 ~13.9 天）。
- 关联：主题共现（实体重叠）时互相加 `[[wikilink]]` +0.1。
- 每轮运行：先读 `INDEX.md`（§2b），回复后 append 0–3 条兴趣项（§5b）。
- owner 说「做个梦 / 整理记忆」→ 手动 `dream.py --force`。
