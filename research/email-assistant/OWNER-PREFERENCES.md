# Owner Preferences — email-assistant

持久化记录 owner 对 email-assistant 的偏好。每次运行应读取本文件并遵循。

## 回复格式 / 风格（2026-09-15 确定）

**偏好**：owner 喜欢「调研结果：Dario Amodei《We Must Pace the Frontier》」
那一封回复的页面格式与风格，要求**以后所有 email-assistant 回复统一采用
该样式**。

- 参考归档：`pi-mail-archive/2026-09/2026-09-14-1501-5680EBD7-调研X帖子-Dario-on-slowing-down-the-AI-resea/reply.html`
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
