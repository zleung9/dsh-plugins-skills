#!/usr/bin/env node
/**
 * health.mjs — 采集健康检查
 *
 * 用途：在定时任务里先跑它，把「登录失效」这种静默失败暴露出来。
 *   node health.mjs [--port 9222] [--json]
 *
 * 退出码：0 健康 / 2 登录失效 / 3 Chrome 或 CDP 不可用
 */

import { connectChat, checkSession, listAllConversations, cdpAlive, DEFAULT_PORT, AizexError } from '../lib/aizex-api.mjs';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || DEFAULT_PORT;
const asJson = args.includes('--json');
const out = { ok: false, cdp: false, loggedIn: false, code: null, message: null, conversations: 0, newest: null };

try {
  out.cdp = await cdpAlive(port);
  if (!out.cdp) throw new AizexError(`Chrome 调试端口 ${port} 未监听`, 'NO_CDP');

  const chat = await connectChat({ port });
  try {
    const sess = await checkSession(chat);
    out.loggedIn = sess.loggedIn;
    out.session = sess;
    if (!sess.loggedIn) {
      out.code = 'NOT_LOGGED_IN';
      out.message = '登录态失效：需要打开采集 profile 的 Chrome 手动登录 aizex';
      console.log(asJson ? JSON.stringify(out) : `✗ ${out.message}`);
      process.exit(2);
    }
    const list = await listAllConversations(chat, { pageSize: 100, maxPages: 5 });
    out.conversations = list.length;
    out.newest = list[0] ? { id: list[0].id, title: list[0].title, update_time: list[0].update_time } : null;
    out.ok = true;
    console.log(asJson ? JSON.stringify(out) : `✓ 健康：共 ${out.conversations} 条会话，最新「${out.newest?.title ?? '-'}」`);
    process.exit(0);
  } finally { await chat.close(); }
} catch (e) {
  out.code = e?.code ?? 'ERROR';
  out.message = e?.message ?? String(e);
  console.log(asJson ? JSON.stringify(out) : `✗ [${out.code}] ${out.message}`);
  process.exit(e?.code === 'NO_CDP' ? 3 : (e?.code === 'NOT_LOGGED_IN' ? 2 : 3));
}