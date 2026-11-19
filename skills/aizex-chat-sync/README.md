# aizex-chat-sync

把 aizex 网页上的 ChatGPT 聊天记录增量同步成本地 Markdown 文件。

## 安装成技能

技能目录在沙箱外，需要你手动放置（或在放开权限的会话里执行）。**注意用 rsync**：
目标目录已存在时 `cp -R` 会往里嵌套一层，重装时踩过这个坑：

```bash
mkdir -p ~/.agents/skills
rsync -a --delete ~/personal-agent/packages/aizex-chat-sync/ ~/.agents/skills/aizex-chat-sync/
```

装完用 `node ~/.agents/skills/aizex-chat-sync/scripts/health.mjs` 验证。

## 用法

```bash
node scripts/health.mjs                                    # 健康检查
node scripts/sync.mjs --out "<输出目录>" --limit 5 --dry-run  # 先看计划
node scripts/sync.mjs --out "<输出目录>" --limit 30          # 真同步
```

详见 [SKILL.md](./SKILL.md)。

## 目录结构

```
SKILL.md                      技能说明（给人和给 agent 看）
lib/aizex-api.mjs             CDP 连接 + JSON API 封装
lib/chatgpt-markdown.mjs      会话 JSON → Obsidian 友好 Markdown
scripts/sync.mjs              主入口：增量同步
scripts/health.mjs            健康检查（区分「登录失效」与「没新内容」）
```

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（0 条新增也算成功） |
| 2 | 登录态失效，需要人工登录一次 |
| 3 | 其它失败（含 CDP 不可用） |

## 插件集成（personal-kb）

personal-kb 插件内置采集器 `lib/collectors/aizex.mjs`：配置 `aizexEnabled: true` 后，
每轮 pass 自动跑本技能的 `sync.mjs`，把新会话写进 `<vault>/aizex-sync/`；`aizexMode: write`
可让聊天文件夹一直同步而记忆 pass 仍只预览。退出码 2（登录失效）会作为 `NOT_LOGGED_IN`
健康错误上报。详见 SKILL.md「定时任务」。
