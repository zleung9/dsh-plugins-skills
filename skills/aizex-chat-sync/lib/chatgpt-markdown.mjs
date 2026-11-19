/**
 * chatgpt-markdown.mjs — 把 ChatGPT 会话 JSON 转成 Obsidian 友好的 Markdown
 *
 * 与站内「导出对话」的差异（有意为之）：
 *   1. 站内导出只保留首条用户消息（引用块），后续用户消息直接丢；
 *      这里每一轮用户消息都保留成「### 👤」小节，完整存档。
 *   2. 模型思考过程（thoughts / reasoning_recap）折进 <details>，默认收起。
 *   3. frontmatter 记录元数据；时间统一成 ISO —— 列表接口给 ISO 串，
 *      详情接口给 Unix 秒（浮点），两边必须归一才能比对。
 *   4. 正文不打 H1 大标题（Obsidian 里文件名就是标题）。
 *
 * 会话 JSON 形状（实测）：
 *   mapping: {nodeId: {parent, children[], message: {author:{role}, content:{content_type, parts?, thoughts?}}}}
 *   current_node 指向最后一条消息；沿 parent 回溯到根即对话主线。
 */

/** 思考过程这类「非正文」节点类型。 */
const NON_TEXT = new Set(['thoughts', 'reasoning_recap']);

/**
 * 沿 current_node → parent 回溯主线，取用户/助手正文轮次。
 * 思考类节点不算独立轮次，而是挂到其后第一条正文轮次的 thoughts 字段（按树结构精确归属）。
 */
export function extractTurns(convo) {
  const mapping = convo?.mapping ?? {};
  const path = [];
  let id = convo?.current_node;
  const guard = new Set();
  while (id && mapping[id] && !guard.has(id)) {
    guard.add(id);
    path.push(id);
    id = mapping[id].parent;
  }
  path.reverse();

  const turns = [];
  let pendingThoughts = [];
  for (const nodeId of path) {
    const msg = mapping[nodeId]?.message;
    if (!msg) continue;
    const role = msg?.author?.role;
    const ctype = msg?.content?.content_type;

    if (role === 'assistant' && NON_TEXT.has(ctype)) {
      const c = msg.content;
      const chunks = [];
      if (Array.isArray(c.thoughts)) for (const t of c.thoughts) if (t?.summary) chunks.push(t.summary);
      if (typeof c.content === 'string' && c.content.trim()) chunks.push(c.content);
      const text = chunks.join('\n\n').trim();
      if (text) pendingThoughts.push(text);
      continue;
    }

    if (role !== 'user' && role !== 'assistant') continue;
    if (role === 'assistant' && ctype !== 'text') continue;

    const parts = msg?.content?.parts;
    const text = Array.isArray(parts)
      ? parts.filter((p) => typeof p === 'string').join('\n').trim()
      : '';
    if (!text) continue;

    turns.push({
      role, contentType: ctype, text, nodeId,
      thoughts: pendingThoughts.length ? pendingThoughts.join('\n\n') : null,
    });
    pendingThoughts = [];
  }
  return turns;
}

/** 时间归一：数字按 Unix 秒，字符串按 ISO 解析，统一输出 ISO 串；解析不了原样返回。 */
export function toIsoTime(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  const t = Date.parse(v);
  return Number.isNaN(t) ? String(v) : new Date(t).toISOString();
}

/** 规范化标题：去路径分隔符与控制字符，压空白，限长。 */
export function slugify(title, fallback = '未命名对话') {
  const t = String(title ?? '').replace(/[\x00-\x1f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return (t || fallback).slice(0, 80);
}

/** 主入口：会话 JSON → { markdown, frontmatter, body, turns, title }。 */
export function conversationToMarkdown(convo, { syncedAt = new Date().toISOString() } = {}) {
  const title = slugify(convo?.title);
  const turns = extractTurns(convo);
  const lines = [];

  // 首条用户消息截一行做引子（正文里仍完整出现，不丢内容）
  const firstUser = turns.find((t) => t.role === 'user');
  if (firstUser) {
    const flat = firstUser.text.replace(/\s+/g, ' ');
    lines.push('> ' + flat.slice(0, 160) + (flat.length > 160 ? ' …' : ''), '');
  }

  for (const t of turns) {
    if (t.role === 'user') {
      lines.push('### 👤 ' + t.text.split('\n')[0].slice(0, 60), '', t.text, '');
    } else {
      if (t.thoughts) {
        lines.push('<details><summary>💭 思考过程</summary>', '', t.thoughts, '', '</details>', '');
      }
      lines.push(t.text, '');
    }
  }

  const fm = [
    '---',
    'type: chatgpt-chat',
    'title: "' + title.replace(/"/g, '\\"') + '"',
    'conversation_id: ' + (convo?.conversation_id ?? convo?.id ?? ''),
    'create_time: ' + toIsoTime(convo?.create_time),
    'update_time: ' + toIsoTime(convo?.update_time),
    'model: ' + (convo?.default_model_slug ?? ''),
    'messages: ' + turns.length,
    'starred: ' + Boolean(convo?.is_starred),
    'archived: ' + Boolean(convo?.is_archived),
    'synced_at: ' + syncedAt,
    'source: aizex',
    '---',
    '',
  ].join('\n');

  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return { markdown: fm + body + '\n', frontmatter: fm, body, turns, title };
}

/** 首条用户消息摘要，用作去重指纹的一部分。 */
export function fingerprint(convo) {
  const turns = extractTurns(convo);
  const first = turns.find((t) => t.role === 'user')?.text ?? '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 200);
}
