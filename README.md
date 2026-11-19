# DSH Plugins and Skills

Browse the [skills](skills/) or the [paper reader and downloader plugin](plugins/dsh-paper-downloader/).

Each skill lives in its own directory with a `SKILL.md` file (YAML frontmatter with `name` and `description`, plus the skill instructions).

## Shared toolchain (dependencies live outside this repo)

For the skills, Node dependencies and browser profiles live in a **cross-agent
neutral root** at `~/.agents/`, shared by pi, Claude Code and Codex alike:

```
~/.agents/
  node_modules/          # one copy of playwright / puppeteer-core / cheerio / jsdom / …
  backup/                # pre-refactor backups of profiles and removed junk
  skills/                # symlinks into this repo (30 entries)
  browser-profiles       # -> ~/email-assistant/browser-profiles (compat symlink)
```

Persistent Chromium profiles live in the `~/email-assistant` workspace (see
below); `~/.agents/browser-profiles` is kept as a symlink for compatibility.

**Calling convention — two mechanisms, because Node resolves them differently:**

1. **Libraries** (`import { chromium } from "playwright"`) are found by walking
   *upward* from the script dir. Each consuming skill therefore has a
   `node_modules` **symlink** pointing at the shared root:

   ```
   skills/research/x-digest/node_modules      -> ~/.agents/node_modules
   skills/web-tools/x-login/node_modules      -> ~/.agents/node_modules
   skills/web-tools/web-search-chrome/node_modules -> ~/.agents/node_modules
   skills/web-tools/browser-tools/node_modules     -> ~/.agents/node_modules
   skills/web-tools/youtube-transcript/node_modules -> ~/.agents/node_modules
   ```

   Install / upgrade everything once with `npm install --prefix ~/.agents`.
   **Never run `npm install` inside a skill dir** — that replaces the symlink
   with a local copy and puts the weight back into the synced folder.

   > `NODE_PATH` is *not* an option here: Node's ESM resolver ignores it
   > entirely (only CommonJS `require()` honours it), and these scripts are ESM.

2. **CLI tools** (`getnote`, `codex`, `claude`, `mcporter`, `defuddle`, `ntn`,
   `ob`) resolve through `PATH` and are installed with `npm install -g`, which
   is what `npm -g` is actually designed for.

Browser profiles are addressed by an absolute path with an env override, e.g.
in `pw-common.mjs`:

```js
export const X_PROFILE =
  process.env.X_PROFILE_DIR ||
  join(homedir(), "email-assistant", "browser-profiles", "x-digest");
```

They are deliberately kept out of this repo: they are live Chrome user-data
dirs that would otherwise be re-uploaded by Nutstore on every run. Each
profile's `Default/Cache`, `Default/Code Cache` and `Default/Service Worker`
can be deleted at any time to reclaim space **without** losing the login.

## Runtime records live in `~/email-assistant` (also a DSH workspace)

Daily-growing output (captured feeds, generated digests, dedup stores, email
archive, long-term memory, Chromium profiles) is **not** kept here either. It
lives in a separate data workspace, `~/email-assistant`, documented in its own
README:

```
~/email-assistant/
  x-digest/data/               feeds, digests, seen.json
  nature-digest/data/          candidates, digests, seen.json
  archive/                     one dir per processed email
  memory/                      interests.jsonl, topics.json, dream.py
  browser-profiles/x-digest/   Playwright profile (keeps X login)
  browser-profiles/x-login/    Playwright profile for the login skill
```

`~/email-assistant` doubles as a **DSH workspace root**: DSH's native
scheduled tasks (「自动化任务」, `@deepseek-ai/dsh-experimental-schedule-bundle`)
run *inside* a session and are confined by that session's sandbox, whose
writable boundary is the session's workspace. Rooting the workspace at
`~/email-assistant` therefore lets an automation session write all of the paths
above. The old `~/agent-data/*` locations and `~/.agents/browser-profiles` are
kept as symlinks pointing here.

Each script resolves its data root from an env var with a default pointing
there, so this repo holds **no runtime state at all**:

| Skill | Env var | Default |
|---|---|---|
| x-digest | `X_DIGEST_DATA_DIR` | `~/email-assistant/x-digest/data` |
| nature-digest | `NATURE_DIGEST_DATA_DIR` | `~/email-assistant/nature-digest/data` |
| email-assistant (archive) | `MAIL_ARCHIVE_ROOT` | `~/email-assistant/archive` |
| email-assistant (memory) | `EMAIL_ASSISTANT_MEMORY` | `~/email-assistant/memory` |
| x-digest / x-login (browser) | `X_PROFILE_DIR` | `~/email-assistant/browser-profiles/<skill>` |

`data/`, `memory/` and `pi-mail-archive/` are listed in `.gitignore` as a guard
against regression — a skill writing to a bare `data/…` path inside its own
directory is a bug.

## Categories

- [Administration](#administration) (1)
- [AI Development](#ai-development) (24)
- [AI Infrastructure](#ai-infrastructure) (5)
- [Communications](#communications) (4)
- [Creative & Design](#creative--design) (23)
- [Documents](#documents) (11)
- [Education](#education) (1)
- [GitHub](#github) (6)
- [Obsidian](#obsidian) (6)
- [Productivity](#productivity) (12)
- [Research](#research) (14)
- [Utilities](#utilities) (9)
- [Web Tools](#web-tools) (21)

## Administration

### `pi-lab-ai-resume-screening`

[skills/pi-lab-ai-resume-screening/](skills/pi-lab-ai-resume-screening/)

面向厦门大学π-Lab人工智能背景研究生候选人简历初筛，输出S/A/B/C字母等级 + ≤60字理由 + 真实性风险。用于转发推荐前的非C过滤。

## AI Development

### `claude-code`

[skills/claude-code/](skills/claude-code/)

Delegate coding to Claude Code CLI (features, PRs).

### `test-driven-development`

[skills/test-driven-development/](skills/test-driven-development/)

TDD: enforce RED-GREEN-REFACTOR, tests before code.

### `systematic-debugging`

[skills/systematic-debugging/](skills/systematic-debugging/)

4-phase root cause debugging: understand bugs before fixing.

### `kanban-worker`

[skills/kanban-worker/](skills/kanban-worker/)

Pitfalls, examples, and edge cases for Hermes Kanban workers. The lifecycle itself is auto-injected into every worker's system prompt as KANBAN_GUIDANCE (from agent/prompt_builder.py); this skill is what you load when you want deeper detail on specific scenarios.

### `jupyter-live-kernel`

[skills/jupyter-live-kernel/](skills/jupyter-live-kernel/)

Iterative Python via live Jupyter kernel (hamelnb).

### `openai-docs`

[skills/codex-openai-docs/](skills/codex-openai-docs/)

Use when the user asks how to build with OpenAI products or APIs, asks about Codex itself or choosing Codex surfaces, needs up-to-date official documentation with citations, help choosing the latest model for a use case, latest/current/default-model prompting guidance, or model upgrade and prompt-upgrade guidance; use OpenAI docs MCP tools for non-Codex docs questions, use the Codex manual helper first for broad Codex self-knowledge, and restrict fallback browsing to official OpenAI domains.

### `plan`

[skills/plan/](skills/plan/)

Plan mode: write an actionable markdown plan to .hermes/plans/, no execution. Bite-sized tasks, exact paths, complete code.

### `claude-api`

[skills/claude-api/](skills/claude-api/)

Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration. TRIGGER — read BEFORE opening the target file; don't skip because it "looks like a one-liner" — whenever: the prompt names Claude/Anthropic in any form (Claude, Anthropic, Fable, Opus, Sonnet, Haiku, `anthropic`, `@anthropic-ai`, `claude-*`, `us.anthropic.*`, `[1m]`); the user asks about an LLM (pricing/model choice/limits/caching) — never answer from memory; OR the task is LLM-shaped with provider unstated (agent/MCP/tool-definition/multi-agent/RAG/LLM-judge/computer-use; generate/summarize/extract/classify/rewrite/converse over NL; debugging refusals/cutoffs/streaming/tool-calls/tokens). SKIP only when another provider is being worked on (overrides all triggers): OpenAI/GPT/Gemini/Llama/Mistral/Cohere/Ollama named in the query; OR `grep -rE 'openai|langchain_openai|google.generativeai|genai|mistralai|cohere|ollama'` over the project hits (run this grep FIRST if no provider named — don't Read the file).

### `codex`

[skills/codex/](skills/codex/)

Delegate coding to OpenAI Codex CLI (features, PRs).

### `plugin-creator`

[skills/codex-plugin-creator/](skills/codex-plugin-creator/)

Create and scaffold plugin directories for Codex with a required `.codex-plugin/plugin.json`, optional plugin folders/files, valid manifest defaults, and personal-marketplace entries by default. Use when Codex needs to create a new personal plugin, add optional plugin structure, generate or update marketplace entries for plugin ordering and availability metadata, or update an existing local plugin during development with the CLI-driven cachebuster and reinstall flow.

### `review-agent`

[skills/codex-review-agent/](skills/codex-review-agent/)

Perform a read-only, defect-first review of a specified code change and return every actionable finding. Use when another agent delegates review of uncommitted changes, a base-branch diff, a commit, or custom review instructions.

### `kanban-orchestrator`

[skills/kanban-orchestrator/](skills/kanban-orchestrator/)

Decomposition playbook + anti-temptation rules for an orchestrator profile routing work through Kanban. The "don't do the work yourself" rule and the basic lifecycle are auto-injected into every kanban worker's system prompt; this skill is the deeper playbook when you're specifically playing the orchestrator role.

### `skill-creator`

[skills/ai-development/skill-creator/](skills/ai-development/skill-creator/)

Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.

### `mcporter`

[skills/mcporter/](skills/mcporter/)

Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly (HTTP or stdio), including ad-hoc servers, config edits, and CLI/type generation.

### `native-mcp`

[skills/native-mcp/](skills/native-mcp/)

MCP client: connect servers, register tools (stdio/HTTP).

### `skill-creator`

[skills/codex-skill-creator/](skills/codex-skill-creator/)

Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations.

### `writing-plans`

[skills/writing-plans/](skills/writing-plans/)

Write implementation plans: bite-sized tasks, paths, code.

### `spike`

[skills/spike/](skills/spike/)

Throwaway experiments to validate an idea before build.

### `requesting-code-review`

[skills/requesting-code-review/](skills/requesting-code-review/)

Pre-commit review: security scan, quality gates, auto-fix.

### `simplify-code`

[skills/simplify-code/](skills/simplify-code/)

Parallel 3-agent cleanup of recent code changes.

### `vscode`

[skills/vscode/](skills/vscode/)

VS Code integration for viewing diffs and comparing files. Use when showing file differences to the user.

### `mcp-builder`

[skills/mcp-builder/](skills/mcp-builder/)

Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK).

### `subagent-driven-development`

[skills/subagent-driven-development/](skills/subagent-driven-development/)

Execute plans via delegate_task subagents (2-stage review).

### `skill-installer`

[skills/codex-skill-installer/](skills/codex-skill-installer/)

Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos).

## AI Infrastructure

### `huawei-campus-endpoints`

[skills/ai-infra/huawei-campus-endpoints/](skills/ai-infra/huawei-campus-endpoints/)

华为园区网大模型代理端点 — 4 个 vLLM 代理模型（Qwen3.6, DeepSeek-V4, GLM-5, Intern-S2）的连通性和使用方法。端点通过校园网 10.26.15.52:30081 暴露，不需要代理。

### `deploy-qwen3`

[skills/deploy-qwen3/](skills/deploy-qwen3/)

Deploy and serve Qwen3 / Qwen3.5 MoE and other GDN / hybrid-linear-attention models (gated delta net, Mamba-style) on Huawei Ascend 910B / 910B4 NPUs with vLLM + vllm-ascend under CANN — for inference serving, not training or fine-tuning. Use this skill whenever deploying, troubleshooting, or optimizing an LLM for inference on Ascend NPUs: CANN 8.x vs 9.x version mismatches, torch_npu / vllm-ascend compatibility, triton-ascend setup, tensor-parallel (TP) sizing for GDN models, HBM leaks after killing workers, FULL graph capture, single-request throughput tuning, or building a container image for Ascend NPU inference. Trigger when the work is on Ascend / CANN / NPU and involves aclnn op errors, GEInitializeV2, libhccl.so, platform_config, npu-smi, 910B, vLLM-ascend startup failures, or scatter_ / graph-capture issues. Do not trigger for NVIDIA / CUDA (A100, H100, nvidia-smi, VRAM) or for fine-tuning / training questions.

### `huggingface-hub`

[skills/huggingface-hub/](skills/huggingface-hub/)

HuggingFace hf CLI: search/download/upload models, datasets.

### `ascend-npu-llm-deploy`

[skills/ascend-npu-llm-deploy/](skills/ascend-npu-llm-deploy/)

Deploy LLM models on Huawei Ascend NPU with OpenAI-compatible FastAPI server

### `huawei-report-update`

[skills/huawei-report-update/](skills/huawei-report-update/)

Refresh the Huawei server weekly report site at http://10.26.15.53:18788. Pulls slurm job records from hpc (10.26.15.51), aggregates per-user per-day core-hours over the last 30 days, and pushes JSON to the report folder so the frontend (Chart.js) renders the chart. Use when user says 更新华为周报 / 刷新报告 / huawei report update / 拉slurm数据 / 更新核时图.

## Communications

### `himalaya`

[skills/himalaya/](skills/himalaya/)

Himalaya CLI: IMAP/SMTP email from terminal.

### `wechat-dialogue-to-article`

[skills/wechat-dialogue-to-article/](skills/wechat-dialogue-to-article/)

将讨论、访谈、聊天记录、会议对话或多轮问答整理成适合微信公众号发布的中文文章，提炼主线、重组素材并形成偏深度的洞察，同时保持真诚、克制、有观点和有个人声音的表达。用于用户要求把一段对话“整理成文章”“改成公众号”“写成长文”“提炼观点”，或希望从讨论记录中生成标题、导语和公众号正文时。

### `wechat-article-extractor`

[skills/wechat-article-extractor/](skills/wechat-article-extractor/)

从微信公众号文章链接中提取正文内容（文字+图片）并转换为 Markdown 文档。 **当以下情况时使用此 Skill**： (1) 用户发来微信公众号文章链接，要求"保存"、"下载"、"转成文档" (2) 用户发来微信文章链接，要求"提取内容" (3) 用户说"把这个网页转成 markdown"且链接是 mp.weixin.qq.com **NOT for**： - 非微信公众号内容（用 web_fetch 或其他方式） - 需要登录才能访问的内容 - 视频号内容（不同格式）

### `email`

[skills/email/](skills/email/)

Use this skill whenever the user wants to send, receive, read, draft, or manage email — sending messages via SMTP, saving drafts to an IMAP mailbox, listing or reading inbox messages, downloading attachments, or sending emails with file attachments. Trigger on phrases like "发邮件", "send an email", "save a draft", "check my inbox", "read my email", "抄送/密送", "群发", or any request that names recipients, subjects, CC/BCC, or a mail body. Use this skill even when the user doesn't explicitly say "email" but describes a workflow that clearly needs sending or reading mail (e.g. "把这个发给我导师", "把摘要群发给列表里的人"). Do NOT use for instant messaging, SMS, push notifications, or in-app chat. Configured out of the box for 163 (zleung9@163.com) and XMU (zliang8@xmu.edu.cn) accounts via msmtp + IMAP.

## Creative & Design

### `ideation`

_Legacy catalog entry_

Generate project ideas via creative constraints.

### `theme-factory`

[skills/theme-factory/](skills/theme-factory/)

Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly.

### `comfyui`

_Legacy catalog entry_

Generate images, video, and audio with ComfyUI — install, launch, manage nodes/models, run workflows with parameter injection. Uses the official comfy-cli for lifecycle and direct REST/WebSocket API for execution.

### `baoyu-infographic`

_Legacy catalog entry_

Infographics: 21 layouts x 21 styles (信息图, 可视化).

### `songwriting-and-ai-music`

_Legacy catalog entry_

Songwriting craft and Suno AI music prompts.

### `ascii-video`

_Legacy catalog entry_

ASCII video: convert video/audio to colored ASCII MP4/GIF.

### `imagegen`

_Legacy catalog entry_

Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when Codex should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.

### `touchdesigner-mcp`

_Legacy catalog entry_

Control a running TouchDesigner instance via twozero MCP — create operators, set parameters, wire connections, execute Python, build real-time visuals. 36 native tools.

### `claude-design`

[skills/claude-design/](skills/claude-design/)

Design one-off HTML artifacts (landing, deck, prototype).

### `ascii-art`

_Legacy catalog entry_

ASCII art: pyfiglet, cowsay, boxes, image-to-ascii.

### `algorithmic-art`

_Legacy catalog entry_

Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists' work to avoid copyright violations.

### `design-md`

_Legacy catalog entry_

Author/validate/export Google's DESIGN.md token spec files.

### `canvas-design`

_Legacy catalog entry_

Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art, design, or other static piece. Create original visual designs, never copying existing artists' work to avoid copyright violations.

### `baoyu-comic`

_Legacy catalog entry_

Knowledge comics (知识漫画): educational, biography, tutorial.

### `slack-gif-creator`

_Legacy catalog entry_

Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like "make me a GIF of X doing Y for Slack."

### `popular-web-designs`

[skills/popular-web-designs/](skills/popular-web-designs/)

54 real design systems (Stripe, Linear, Vercel) as HTML/CSS.

### `manim-video`

_Legacy catalog entry_

Manim CE animations: 3Blue1Brown math/algo videos.

### `frontend-design`

[skills/frontend-design/](skills/frontend-design/)

Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.

### `baoyu-article-illustrator`

_Legacy catalog entry_

Article illustrations: type × style × palette consistency.

### `p5js`

_Legacy catalog entry_

p5.js sketches: gen art, shaders, interactive, 3D.

### `architecture-diagram`

_Legacy catalog entry_

Dark-themed SVG architecture/cloud/infra diagrams as HTML.

### `sketch`

_Legacy catalog entry_

Throwaway HTML mockups: 2-3 design variants to compare.

### `web-artifacts-builder`

[skills/web-artifacts-builder/](skills/web-artifacts-builder/)

Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or shadcn/ui components - not for simple single-file HTML/JSX artifacts.

## Documents

### `nano-pdf`

[skills/nano-pdf/](skills/nano-pdf/)

Edit PDF text/typos/titles via nano-pdf CLI (NL prompts).

### `pdf-to-markdown`

[skills/pdf-to-markdown/](skills/pdf-to-markdown/)

Convert scientific papers from PDF to Markdown using MinerU API. Use when user provides a PDF file path and wants it converted to Markdown with extracted figures. Triggers on phrases like: "convert paper", "PDF to markdown", "convert this paper", "extract paper to markdown", or any request involving PDF-to-Markdown conversion for academic papers.

### `doc-coauthoring`

[skills/doc-coauthoring/](skills/doc-coauthoring/)

Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc works for readers. Trigger when user mentions writing docs, creating proposals, drafting specs, or similar documentation tasks.

### `mineru-pdf`

[skills/mineru-pdf/](skills/mineru-pdf/)

Convert documents (PDF, DOCX, PPTX, images, HTML) to Markdown using the MinerU cloud API. Produces markdown text with extracted figures. Use when the user wants to parse, convert, or extract content from PDF papers or other supported document formats.

### `xlsx`

[skills/xlsx/](skills/xlsx/)

Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .xltx, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like "the xlsx in my downloads") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved.

### `pdf`

[skills/pdf/](skills/pdf/)

Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.

### `pptx`

[skills/pptx/](skills/pptx/)

Use this skill any time a .pptx or .potx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx or .potx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates (.potx), layouts, speaker notes, or comments. Trigger whenever the user mentions "deck," "slides," "presentation," or references a .pptx or .potx filename, regardless of what they plan to do with the content afterward. If a .pptx or .potx file needs to be opened, created, or touched, use this skill.

### `humanizer`

[skills/humanizer/](skills/humanizer/)

Humanize text: strip AI-isms and add real voice.

### `ocr-and-documents`

[skills/ocr-and-documents/](skills/ocr-and-documents/)

Extract text from PDFs/scans (pymupdf, marker-pdf).

### `docx`

[skills/docx/](skills/docx/)

Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files) or Word templates (.dotx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', '.dotx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx or .dotx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation.

### `文档分析器`

[skills/document-analyzer/](skills/document-analyzer/)

深度分析文档结构和内容。当用户需要分析文档结构、提取关键信息、识别文档类型、进行内容质量评估、或理解文档组织方式时使用此技能。

## Education

### `openmaic-classroom`

_Legacy catalog entry_

将 RAG 检索结果、文档块或知识图谱概念转换为 OpenMAIC 互动课程。当用户要求将知识库内容、检索到的文档片段、上传的文档、或知识图谱中的概念批量转换为教学课件/互动课堂时使用此技能。支持纯需求生成、基于 PDF 内容的课程生成、和基于概念图遍历的批量课堂生成。

## GitHub

### `github-auth`

[skills/github-auth/](skills/github-auth/)

GitHub auth setup: HTTPS tokens, SSH keys, gh CLI login.

### `github-repo-management`

[skills/github-repo-management/](skills/github-repo-management/)

Clone/create/fork repos; manage remotes, releases.

### `github-pr-workflow`

[skills/github-pr-workflow/](skills/github-pr-workflow/)

GitHub PR lifecycle: branch, commit, open, CI, merge.

### `auto-review-maintenance`

[skills/auto-review-maintenance/](skills/auto-review-maintenance/)

Maintain the openclaw-reviewer distribution repo at git@git.xmu.edu.cn:liangzhu/auto-review.git — check issues, apply fixes, update README / persona files / docker image, push. Handles the XMU GitLab specifics (SSH config quirk, Git LFS for the 340MB tar).

### `github-code-review`

[skills/github-code-review/](skills/github-code-review/)

Review PRs: diffs, inline comments via gh or REST.

### `github-issues`

[skills/github-issues/](skills/github-issues/)

Create, triage, label, assign GitHub issues via gh or REST.

## Obsidian

### `obsidian`

[skills/core/](skills/core/)

Read, search, create, and edit notes in the Obsidian vault.

### `obsidian-markdown`

[skills/obsidian-markdown/](skills/obsidian-markdown/)

Create and edit Obsidian Flavored Markdown with wikilinks, embeds, callouts, properties, and other Obsidian-specific syntax. Use when working with .md files in Obsidian, or when the user mentions wikilinks, callouts, frontmatter, tags, embeds, or Obsidian notes.

### `obsidian-bases`

[skills/obsidian-bases/](skills/obsidian-bases/)

Create and edit Obsidian Bases (.base files) with views, filters, formulas, and summaries. Use when working with .base files, creating database-like views of notes, or when the user mentions Bases, table views, card views, filters, or formulas in Obsidian.

### `llm-wiki`

[skills/llm-wiki/](skills/llm-wiki/)

Karpathy's LLM Wiki: build/query interlinked markdown KB.

### `obsidian-cli`

[skills/obsidian-cli/](skills/obsidian-cli/)

Interact with Obsidian vaults using the Obsidian CLI to read, create, search, and manage notes, tasks, properties, and more. Also supports plugin and theme development with commands to reload plugins, run JavaScript, capture errors, take screenshots, and inspect the DOM. Use when the user asks to interact with their Obsidian vault, manage notes, search vault content, perform vault operations from the command line, or develop and debug Obsidian plugins and themes.

### `json-canvas`

[skills/json-canvas/](skills/json-canvas/)

Create and edit JSON Canvas files (.canvas) with nodes, edges, groups, and connections. Use when working with .canvas files, creating visual canvases, mind maps, flowcharts, or when the user mentions Canvas files in Obsidian.

## Productivity

### `expense`

[skills/expense/](skills/expense/)

报销管理系统：以 Trip（行程）为单位管理所有报销记录，支持机票、酒店、餐饮等各类发票附件，自动生成报销单。

### `tasks`

[skills/tasks/](skills/tasks/)

任务/日程管理：使用 SQLite DB (task/tasks.db) + Markdown (task/task.md) 双重存储。支持待办事项和日历日程两种类型。

### `dida365`

[skills/dida365/](skills/dida365/)

Dida365 (TickTick) 任务管理 API 集成。从 Dida365 读取任务，同步到 GOALS.md 格式。

### `goals`

[skills/goals/](skills/goals/)

目标与待办管理系统：以 `$WORKSPACE/GOALS.md` 为主文件，按时间维度（年度→季度→月度→周→今日）和优先级维度（重要/紧急四象限，🔴🟡🟢⚪）组织目标与任务，支持添加待办、更新完成状态、查看今日清单、每日回顾与归档历史记录，并可在每日心跳时主动询问今日待办完成情况。

### `linear`

[skills/linear/](skills/linear/)

Linear: manage issues, projects, teams via GraphQL + curl.

### `Get笔记`

[skills/getnote/](skills/getnote/)

Get笔记 - 保存、搜索、管理个人笔记和知识库。 **当以下情况时使用此 Skill**： (1) 用户要保存内容到笔记：发链接、发图片、说「记一下」「存到笔记」「保存」「收藏」 (2) 用户要搜索或查看笔记：「搜一下」「找找笔记」「最近存了什么」「看看原文」 (3) 用户要管理知识库或标签：「加到知识库」「建知识库」「加标签」「删标签」 (4) 用户要配置 Get笔记：「配置笔记」「连接 Get笔记」

### `notion`

[skills/notion/](skills/notion/)

Notion API + ntn CLI: pages, databases, markdown, Workers.

### `apple-reminders`

[skills/apple-reminders/](skills/apple-reminders/)

Apple Reminders via remindctl: add, list, complete.

### `knowledge-base`

[skills/knowledge-base/](skills/knowledge-base/)

个人知识库管理：添加、搜索、移除知识库条目；定期扫描 workspace 自动入库。 **当以下情况时使用此 Skill**： (1) 用户说「存到知识库」「收藏」「加入 KB」「记一下」 (2) 用户说「搜一下知识库」「知识库里有没有」 (3) 用户说「从知识库移除」 (4) 用户说「知识库统计」「看看知识库」 (5) 定时触发：定期扫描 workspace 文件并通知用户新增内容 **NOT for**：长期记忆、个人偏好（用 MEMORY.md）

### `google-workspace`

[skills/google-workspace/](skills/google-workspace/)

Gmail, Calendar, Drive, Docs, Sheets via gws CLI or Python.

### `apple-notes`

[skills/apple-notes/](skills/apple-notes/)

Manage Apple Notes via memo CLI: create, search, edit.

### `vault`

[skills/vault/](skills/vault/)

🔐 加密密码保险库。使用 AES-256-GCM + PBKDF2 加密，所有敏感数据（密码/用户名/URL）密文存储，Master Password 不落盘。查看密码需解锁。

## Research

### `引用生成器`

[skills/citation-generator/](skills/citation-generator/)

自动生成规范引用格式。当用户需要生成参考文献、引用来源、标注知识库内容出处、或要求提供引用信息时使用此技能。

### `manuscript-iteration-loop`

[skills/manuscript-iteration-loop/](skills/manuscript-iteration-loop/)

Use when the user wants to iteratively polish a high-stakes manuscript (journal paper, grant proposal, important report, critical email, etc.) using a disciplined multi-model, human-in-the-loop workflow. Triggers include: any mention of '论文迭代', 'manuscript iteration', 'polish for Nature/Science/top journal', 'compare what several AIs wrote', '让多个模型背靠背评分', 'V1/V2/V3 writing versions', 'lock down the logic/sentence/wording', or any situation where the user wants to fuse outputs from several AI models into one best version through staged, critique-driven refinement. This is domain-agnostic — works for any field whose final artifact is a piece of persuasive or scholarly prose.

### `research-committee`

[skills/research-committee/](skills/research-committee/)

研究思想孵化委员会 — 将模糊的研究野心转化为具体的、可发表顶刊的研究问题

### `web-research-browser`

[skills/web-research-browser/](skills/web-research-browser/)

Web research using browser_navigate + browser_snapshot when no web_search tool is available. Tested approach discovered through trial and error.

### `数据处理器`

[skills/data-processor/](skills/data-processor/)

数据处理与分析技能。当用户需要对知识库检索结果进行数据分析、统计计算、格式转换、数据提取或生成报告时使用此技能。支持 Python 脚本执行进行高级数据处理。

### `geng-academic-integrity-audit`

[skills/academic-integrity/](skills/academic-integrity/)

Academic-integrity self-audit skill inspired by Geng Tongxue for manuscripts, revisions, post-publication concerns, and internal lab review, including Nature/Nature Portfolio submissions. Use when the user asks for 耿同学 skill, 学术诚信自查, 自查自纠, 学术造假/数据造假/图片造假/统计异常/论文打假筛查, PubPeer/retraction concern triage, manuscript correction planning, or whether a manuscript may contain fabrication, falsification, image manipulation, duplicate publication, reporting gaps, or other research-integrity risks.

### `web-search-academic`

[skills/research/web-search-academic/](skills/research/web-search-academic/)

Academic and reference web search via free JSON APIs — Crossref (papers/DOIs), Semantic Scholar (papers with citation counts), Wikipedia (encyclopedia entries), and DuckDuckGo Instant Answer. Use for scholarly lookups, finding research papers, DOIs, citation counts, or encyclopedia entries — especially when the built-in WebSearch is unavailable (US-only, hangs from China). For general/everyday web searches (products, news, how-to, anything you'd Google) prefer the web-search-chrome skill instead. Trigger on phrases like "找关于 X 的论文", "search for papers on X", "X 的 DOI/引用数", "查一下 X 的百科", or any academic/reference lookup.

### `arxiv`

[skills/arxiv/](skills/arxiv/)

Search arXiv papers by keyword, author, category, or ID.

### `academic-literature-search`

[skills/academic-literature-search/](skills/academic-literature-search/)

Academic literature search tool integrating Semantic Scholar, Crossref, arXiv, and PubMed. Use when: user asks to search for academic papers, research articles, or scientific literature. NOT for: non-academic web searches, full-text PDF downloads requiring subscriptions. Supports natural language queries, Boolean operators (AND/OR/NOT), field filters (title:, author:, year:), citation sorting, and multiple output formats (Markdown, JSON, CSV, BibTeX).

### `paper-download`

[skills/paper-download/](skills/paper-download/)

Download the PDF of a research paper given a DOI or URL. Tries open-access sources first (Unpaywall, OpenAlex, arXiv, ChemRxiv, PMC, author pages), then falls back to institutional subscription access via a real Chrome (Playwright) session that exports cookies and curls the publisher's PDF endpoint. Use when the user asks to fetch/download a paper, article, or PDF by DOI/URL. Avoids shadow libraries (Sci-Hub/LibGen).

### `nature-digest`

[skills/research/nature-digest/](skills/research/nature-digest/)

Daily automated digest of Nature papers about AI agents / LLM agents and AI for Science. Fetches Nature RSS feeds, filters new relevant papers, writes Chinese summaries, maintains a dedup store, and emails a daily digest. Run headless via `pi -p "/skill:nature-digest"`.

### `proxy-network-access`

[skills/proxy-network-access/](skills/proxy-network-access/)

Terminal network access via with_proxy() function — accessing crossref, nobelprize, arxiv etc. from Mac terminal with ClashX proxy

### `reviewer-persona`

[skills/reviewer-persona/](skills/reviewer-persona/)

审稿人 — Research Lifecycle Orchestrator. 学术研究的全生命周期管家：创意孵化→文献调研→论文撰写→同行评审回复。管理多项目组合、阶段机、模式切换。

### `research-paper-writing`

[skills/research-paper-writing/](skills/research-paper-writing/)

Write ML papers for NeurIPS/ICML/ICLR: design→submit.

## Utilities

### `openhue`

[skills/openhue/](skills/openhue/)

Control Philips Hue lights, scenes, rooms via OpenHue CLI.

### `godmode`

[skills/godmode/](skills/godmode/)

Jailbreak LLMs: Parseltongue, GODMODE, ULTRAPLINIAN.

### `yuanbao`

[skills/yuanbao/](skills/yuanbao/)

Yuanbao (元宝) groups: @mention users, query info/members.

### `discernment-nudge`

[skills/discernment-nudge/](skills/discernment-nudge/)

After you give a substantive answer or draft that the user may act on — advice or recommendations, drafted artifacts such as goals, plans, pitches, proposals, or emails, estimates or projections, analysis or interpretation of data, factual claims they may rely on, or a multi-step argument — invoke this skill BEFORE finalizing your reply and then, if it applies, append 2-3 short follow-up questions, each tied to something specific in what you just produced, that help the user check key facts, probe the reasoning or assumptions, and notice missing context. Do this at most once per conversation. Skip it when the user asked a trivial how-to or simple lookup, wants a purely educational explanation, asked you only to format, convert, or assemble a file from content they provided, is writing code they will run, is doing creative writing or casual chat, or already asked you to double-check, cite, or review — the skill file explains these boundaries and the exact output format.

### `spotify`

[skills/spotify/](skills/spotify/)

Spotify: play, search, queue, manage playlists and devices.

### `find-skills`

[skills/find-skills/](skills/find-skills/)

Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.

### `grill-me`

[skills/grill-me/](skills/grill-me/)

A relentless interview to sharpen a plan or design.

### `grilling`

[skills/grilling/](skills/grilling/)

Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.

### `academy-guide`

[skills/academy-guide/](skills/academy-guide/)

Stop and check this skill before finishing any reply to a question about how to use Claude or a Claude product — it recommends matching courses, tutorials, and use cases from Claude Academy (academy.claude.com), Anthropic's learning hub. Trigger on: "how do I", "how can I", "getting started with", "what can Claude do", "teach me", "learn to use"; questions about artifacts, projects, skills, plugins, connectors, MCP; requests about rolling Claude out to a team, class, or organization; and any ask for training materials, onboarding content, or learning resources. Use it when the user is learning how to use a feature or product — not when they are mid-task and just want the task done. This skill composes with other skills: after consulting product documentation to answer how a Claude feature works, also check here for a matching course or tutorial — a docs-grounded answer and an Academy recommendation belong together. Only recommend on a strong match; never invent Academy content.

## Web Tools

### `maps`

[skills/maps/](skills/maps/)

Geocode, POIs, routes, timezones via OpenStreetMap/OSRM.

### `youtube-content`

[skills/youtube-content/](skills/youtube-content/)

YouTube transcripts to summaries, threads, blogs.

### `defuddle`

[skills/defuddle/](skills/defuddle/)

Extract clean markdown content from web pages using Defuddle CLI, removing clutter and navigation to save tokens. Use instead of WebFetch when the user provides a URL to read or analyze, for online documentation, articles, blog posts, or any standard web page. Do NOT use for URLs ending in .md — those are already markdown, use WebFetch directly.

### `fun-asr`

_Legacy catalog entry_

转写音频文件为文本（阿里云百炼 Fun-ASR / Paraformer）。当用户发来音频文件需要转成文字时使用，支持中文（含方言）、英文、日韩等多语种。阿里云百炼异步接口，需要公网可访问的音频 URL。

### `blogwatcher`

[skills/blogwatcher/](skills/blogwatcher/)

Monitor blogs and RSS/Atom feeds via blogwatcher-cli tool.

### `blog`

[skills/blog/](skills/blog/)

Create an HTML blog post and publish it. Generates a styled HTML page from the user's content, saves it to ~/blog-server/blog/, regenerates manifest.json, rsyncs to claw server, and git-pushes to GitHub. Use when user says blog this / publish blog / add to blog / post blog / 写博客 / 发博客.

### `macos-computer-use`

[skills/macos-computer-use/](skills/macos-computer-use/)

Drive the macOS desktop in the background — screenshots, mouse, keyboard, scroll, drag — without stealing the user's cursor, keyboard focus, or Space. Works with any tool-capable model. Load this skill whenever the `computer_use` tool is available.

### `webapp-testing`

[skills/webapp-testing/](skills/webapp-testing/)

Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.

### `youtube-downloader`

[skills/youtube-downloader/](skills/youtube-downloader/)

Download YouTube videos with customizable quality and format options. Use this skill when the user asks to download, save, or grab YouTube videos. Supports various quality settings (best, 1080p, 720p, 480p, 360p), multiple formats (mp4, webm, mkv), and audio-only downloads as MP3.

### `weather`

[skills/weather/](skills/weather/)

Get current weather and forecasts via wttr.in or Open-Meteo. Use when: user asks about weather, temperature, or forecasts for any location. NOT for: historical weather data, severe weather alerts, or detailed meteorological analysis. No API key needed.

### `findmy`

_Legacy catalog entry_

Track Apple devices/AirTags via FindMy.app on macOS.

### `songsee`

[skills/songsee/](skills/songsee/)

Audio spectrograms/features (mel, chroma, MFCC) via CLI.

### `find-nearby`

_Legacy catalog entry_

Find nearby places (restaurants, cafes, bars, pharmacies, etc.) using OpenStreetMap. Works with coordinates, addresses, cities, zip codes, or Telegram location pins. No API keys needed.

### `computer-use`

[skills/computer-use/](skills/computer-use/)

Drive the user's desktop in the background — clicking, typing, scrolling, dragging — without stealing the cursor, keyboard focus, or switching virtual desktops / Spaces. Cross-platform: macOS, Windows, Linux. Works with any tool-capable model. Load this skill whenever the `computer_use` tool is available.

### `web-search-chrome`

[skills/web-tools/web-search-chrome/](skills/web-tools/web-search-chrome/)

General-purpose web search using a real Chrome browser and Google, via the Chrome DevTools Protocol. Returns organic search results (title, URL, snippet) as JSON. Use this for everyday web lookups — facts, products, news, documentation, people, "how to" questions, or anything you'd type into Google — especially when the built-in WebSearch tool is unavailable (it's US-only and hangs from China). For scholarly lookups (papers, DOIs, citation counts) use the web-search-academic skill instead. Trigger on phrases like "搜索/查一下/搜一下 X", "search the web for X", "google X", "look up X online", or any request needing current information from the general web.

### `transcribe`

[skills/transcribe/](skills/transcribe/)

Local speech-to-text transcription on Apple Silicon macOS. Supports wav directly and other audio formats via ffmpeg.

### `funasr`

[skills/funasr/](skills/funasr/)

阿里云 FunASR 语音识别 — 录音文件转写、说话人分离，支持 Fun-ASR / Paraformer / SenseVoice 模型。

### `faster-whisper`

_Legacy catalog entry_

Local speech-to-text using faster-whisper. 4-6x faster than OpenAI Whisper with identical accuracy; GPU acceleration enables ~20x realtime transcription. SRT/VTT/TTML/CSV subtitles, speaker diarization, URL/YouTube input, batch processing with ETA, transcript search, chapter detection, per-file language map.

### `dogfood`

[skills/dogfood/](skills/dogfood/)

Exploratory QA of web apps: find bugs, evidence, reports.

### `youtube-transcript`

[skills/web-tools/youtube-transcript/](skills/web-tools/youtube-transcript/)

Fetch transcripts from YouTube videos for summarization and analysis.

### `browser-tools`

[skills/web-tools/browser-tools/](skills/web-tools/browser-tools/)

Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
