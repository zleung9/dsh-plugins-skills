#!/usr/bin/env node
/**
 * sync.mjs — 把 aizex 网页上的聊天记录增量同步到本地目录
 *
 * 用法：
 *   node sync.mjs --out <目录> [选项]
 *
 * 选项：
 *   --out <dir>          输出目录（必填）
 *   --state <file>       去重账本路径（默认 <out 上级目录>/.aizex-sync-state.json；
 *                        自动化场景建议显式放到插件 dataDir 之类的地方，别落在 vault 里）
 *   --limit <n>          本次最多导出多少条（默认 20；全量给大数，如 400）
 *   --since <ISO>        只同步 update_time >= 该时间的会话
 *   --throttle <ms>      相邻两次详情请求的间隔，防限流（默认 200；0 = 关闭）
 *   --include-archived   连归档会话一起同步（默认只拉未归档）
 *   --dry-run            只报告计划，不写任何文件
 *   --write-json         同时保存原始 JSON（默认只写 Markdown）
 *   --port <n>           Chrome CDP 端口（默认 9222）
 *   --json               结果以一行 JSON 输出（给程序调用；此时不打印进度）
 *
 * 退出码（集成方必须区分 2 和 0）：
 *   0  成功（0 条新增也算成功）
 *   2  登录态失效 —— 绝不能伪装成「没有新内容」
 *   3  其它失败（含部分会话导出失败；已成功部分与账本均已保存，下次只重试失败的）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFileSync as readFile } from 'node:fs';
import {
  AizexError, CHAT_HOST, DEFAULT_PORT, checkSession, connectChat, getConversation, listAllConversations,
} from '../lib/aizex-api.mjs';
import { conversationToMarkdown, fingerprint } from '../lib/chatgpt-markdown.mjs';

const CLOSED_TARGET = /Target closed|Session closed|detached|Cannot find context|Evaluation failed/i;

function printUsage() {
  console.log(readFile(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?|\*\/?$/g, '').trim());
}

function parseArgs(argv) {
  const a = {
    out: null, state: null, limit: 20, since: null, throttle: 200,
    includeArchived: false, dryRun: false, writeJson: false, port: DEFAULT_PORT, json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new AizexError(k + ' 缺少参数值', 'BAD_ARGS');
      return argv[++i];
    };
    if (k === '--out') a.out = next();
    else if (k === '--state') a.state = next();
    else if (k === '--limit') a.limit = Number(next());
    else if (k === '--since') a.since = next();
    else if (k === '--throttle') a.throttle = Number(next());
    else if (k === '--include-archived') a.includeArchived = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--write-json') a.writeJson = true;
    else if (k === '--port') a.port = Number(next());
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') { printUsage(); process.exit(0); }
    else throw new AizexError('未知参数：' + k, 'BAD_ARGS');
  }
  return a;
}

function loadState(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && s.conversations && typeof s.conversations === 'object') return s;
  } catch { /* 首次运行或账本损坏：从零开始 */ }
  return { version: 1, conversations: {} };
}

/** 原子落盘：先写临时文件再 rename（iCloud/Obsidian 观察到的永远是完整文件）。 */
function saveState(file, state) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  renameSync(tmp, file);
}

function writeAtomic(target, content) {
  const tmp = target + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, target);
}

/**
 * 账本丢了也能续上：扫磁盘上已有的 .md，从 frontmatter 里读 conversation_id，
 * 恢复「会话 → 文件名」映射。同一个会话继续写同一个文件，不会重复建副本。
 */
function seedFromDisk(outDir) {
  const byId = new Map();
  const taken = new Set();
  if (!existsSync(outDir)) return { byId, taken };
  for (const f of readdirSync(outDir)) {
    if (!f.endsWith('.md')) continue;
    taken.add(f);
    try {
      const head = readFileSync(join(outDir, f), 'utf8').slice(0, 2000);
      const m = head.match(/^conversation_id:\s*(\S+)/m);
      if (m) byId.set(m[1], f);
    } catch { /* 读不了的文件只当作名字被占用 */ }
  }
  return { byId, taken };
}

/** 标题转文件名；撞名时用 UUID 前 8 位消歧。 */
function fileNameFor(title, id, taken) {
  const base = (title || '未命名对话').slice(0, 80);
  let name = base + '.md';
  if (taken.has(name)) name = base + ' (' + String(id).slice(0, 8) + ').md';
  let n = 2;
  while (taken.has(name)) name = base + ' (' + String(id).slice(0, 8) + '-' + n + ').md';
  return name;
}

const ARGS = parseArgs(process.argv.slice(2));
const log = (...xs) => { if (!ARGS.json) console.log(...xs); };

/** 尽力关掉聊天站标签页（冻结页 evaluate 会卡，必须换新页；各步都限时不等它）。 */
async function discardChatPages(chat) {
  try {
    const pages = await Promise.race([
      chat.browser.pages(),
      new Promise((r) => setTimeout(() => r([]), 5000)),
    ]);
    for (const p of pages) {
      if (!p.url().includes(CHAT_HOST)) continue;
      await Promise.race([p.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    }
  } catch { /* 尽力而为 */ }
}

/** 详情拉取：标签页被关（Target closed）或页面冻结（TIMEOUT）时，换新页重试一次。 */
async function fetchWithReconnect(chatRef, id) {
  try {
    return await getConversation(chatRef.chat, id);
  } catch (e) {
    if (e?.code !== 'TIMEOUT' && !CLOSED_TARGET.test(String(e?.message))) throw e;
    log('  … 标签页失效/冻结，换新页重试（' + String(id).slice(0, 8) + '）');
    await discardChatPages(chatRef.chat); // 不关旧页的话 connectChat 会把冻结页原样拿回来
    await chatRef.chat.close();
    chatRef.chat = await connectChat({ port: ARGS.port });
    const sess = await checkSession(chatRef.chat);
    if (!sess.loggedIn) throw new AizexError('重连后登录态失效', 'NOT_LOGGED_IN', sess);
    return await getConversation(chatRef.chat, id);
  }
}

async function main() {
  if (!ARGS.out) throw new AizexError('缺少 --out <目录>', 'BAD_ARGS');
  const outDir = ARGS.out.replace(/\/+$/, '');
  const stateFile = ARGS.state ?? join(dirname(outDir), '.aizex-sync-state.json');

  const result = {
    ok: false, dryRun: ARGS.dryRun, outDir, stateFile,
    listed: 0, toSync: 0, exported: [], skipped: 0, failed: [], overflow: 0,
  };

  const chatRef = { chat: await connectChat({ port: ARGS.port }) };
  try {
    // 1) 登录态检查 —— 「没登录」必须在这里就被抓住，不能流到后面变成「0 条」
    const sess = await checkSession(chatRef.chat);
    result.session = sess;
    if (!sess.loggedIn) {
      throw new AizexError('aizex 登录态已失效：请用采集 profile 的 Chrome 打开 aizex 人工登录一次', 'NOT_LOGGED_IN', sess);
    }

    // 2) 全量列表（主列表 + 置顶；置顶会话不在主列表里，实测会漏）
    const list = await listAllConversations(chatRef.chat, { includeArchived: ARGS.includeArchived });
    result.listed = list.length;

    // 3) 增量筛选
    const state = loadState(stateFile);
    const sinceMs = ARGS.since ? Date.parse(ARGS.since) : null;
    const jobs = [];
    for (const it of list) {
      const rec = state.conversations[it.id];
      if (rec && rec.update_time === it.update_time) { result.skipped += 1; continue; }
      if (sinceMs && it.update_time && Date.parse(it.update_time) < sinceMs) continue;
      jobs.push({ ...it, isNew: !rec });
    }
    result.toSync = jobs.length;
    jobs.sort((a, b) => String(b.update_time).localeCompare(String(a.update_time)));
    const todo = jobs.slice(0, ARGS.limit);
    result.overflow = jobs.length - todo.length;

    if (ARGS.dryRun) {
      result.ok = true;
      result.plan = todo.map((j) => ({ id: j.id, title: j.title, action: j.isNew ? 'create' : 'update' }));
      return result;
    }

    // 4) 逐条导出
    mkdirSync(outDir, { recursive: true });
    const disk = seedFromDisk(outDir);
    for (const rec of Object.values(state.conversations)) {
      if (rec.file) { disk.taken.add(rec.file); if (!disk.byId.has(rec.key)) disk.byId.set(rec.key, rec.file); }
    }

    let done = 0;
    for (const j of todo) {
      if (ARGS.throttle > 0 && done > 0) await new Promise((r) => setTimeout(r, ARGS.throttle));
      try {
        const convo = await fetchWithReconnect(chatRef, j.id);
        const md = conversationToMarkdown(convo, { syncedAt: new Date().toISOString() });
        const prev = state.conversations[j.id];
        const fileName = prev?.file ?? disk.byId.get(j.id) ?? fileNameFor(md.title, j.id, disk.taken);
        disk.taken.add(fileName);
        writeAtomic(join(outDir, fileName), md.markdown);
        if (ARGS.writeJson) writeAtomic(join(outDir, fileName.replace(/\.md$/, '.json')), JSON.stringify(convo, null, 2));
        state.conversations[j.id] = {
          title: md.title, file: fileName,
          update_time: j.update_time, create_time: j.create_time,
          messages: md.turns.length, fingerprint: fingerprint(convo),
          synced_at: new Date().toISOString(),
        };
        saveState(stateFile, state); // 每条都落账：中途挂掉，已完成的下次不用返工
        result.exported.push({ id: j.id, title: md.title, file: fileName, action: prev ? 'update' : 'create', messages: md.turns.length });
        done += 1;
        if (done % 25 === 0) log('  … ' + done + '/' + todo.length);
      } catch (e) {
        if (e instanceof AizexError && e.code === 'NOT_LOGGED_IN') throw e;
        result.failed.push({ id: j.id, title: j.title, error: String(e?.message ?? e).slice(0, 300) });
      }
    }

    state.last_run = new Date().toISOString();
    state.outDir = outDir;
    saveState(stateFile, state);
    result.ok = result.failed.length === 0;
    if (!result.ok) result.code = 'PARTIAL';
    return result;
  } finally {
    await chatRef.chat.close();
  }
}

try {
  const res = await main();
  if (ARGS.json) {
    console.log(JSON.stringify(res));
  } else {
    log('列表 ' + res.listed + ' 条；待同步 ' + res.toSync + ' 条；'
      + '本次导出 ' + res.exported.length + '，已是最新 ' + res.skipped + '，失败 ' + res.failed.length);
    for (const e of res.exported) log('  [' + e.action + '] ' + e.file + ' (' + e.messages + ' 条消息)');
    for (const f of res.failed) log('  [失败] ' + f.title + '：' + f.error);
    if (res.overflow > 0) log('  还有 ' + res.overflow + ' 条留到下次（--limit 控制）');
    if (res.dryRun) log('（dry-run，未写任何文件）');
  }
  process.exit(res.ok ? 0 : 3);
} catch (e) {
  const notLoggedIn = e instanceof AizexError && e.code === 'NOT_LOGGED_IN';
  const payload = { ok: false, code: e?.code ?? 'ERROR', message: e?.message ?? String(e) };
  if (ARGS.json) console.log(JSON.stringify(payload));
  else console.error('[' + payload.code + '] ' + payload.message);
  process.exit(notLoggedIn ? 2 : 3);
}
