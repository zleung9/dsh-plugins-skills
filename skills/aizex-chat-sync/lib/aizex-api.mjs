/**
 * aizex-api.mjs — 通过 CDP 复用已登录的 Chrome，调用 aizex 聊天后端的 JSON API
 *
 * 为什么要走 API 而不是点页面上的「导出对话」按钮：
 *   - 按钮方案依赖合成事件 + blob 下载重定向，链路长、易碎；
 *   - 侧栏列表每次只渲染 28 条，要滚动才有更多；列表顺序还会被点击行为改变；
 *   - 而 `/backend-api/conversations` 直接给出 offset/limit 分页 + update_time，
 *     分页稳定（实测 limit 上限 100），是天然的增量爬取入口。
 *
 * 仍然需要浏览器，因为接口鉴权靠会话 Cookie，而 Cookie 在 Chrome 的
 * 持久化 profile 里（重新登录一次可以管很久）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CHAT_HOST = 'leopard-x.memofun.net';
export const CHAT_ORIGIN = `https://${CHAT_HOST}`;

export const DEFAULT_PROFILE = process.env.AIZEX_CHROME_PROFILE
  ?? join(homedir(), 'personal-agent', '.chrome-profile');
export const DEFAULT_PORT = Number(process.env.AIZEX_CDP_PORT ?? 9222);

/** 采集器专用错误：带 code，方便调用方区分「登录失效」和「只是没新内容」。 */
export class AizexError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.name = 'AizexError';
    this.code = code;
    this.detail = detail;
  }
}

/** puppeteer-core 的绝对路径（不和插件进程共享依赖）。 */
export const PUPPETEER_PATH = process.env.AIZEX_PUPPETEER
  ?? join(homedir(), '.agents', 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer-core.js');

export async function loadPuppeteer() {
  if (!existsSync(PUPPETEER_PATH)) {
    throw new AizexError(`找不到 puppeteer-core：${PUPPETEER_PATH}（可用 AIZEX_PUPPETEER 覆盖）`, 'NO_PUPPETEER');
  }
  return (await import(PUPPETEER_PATH)).default;
}

/** CDP 端点是否活着。 */
export async function cdpAlive(port = DEFAULT_PORT, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

/** 启动一个带调试端口的 Chrome（用采集专用 profile，登录态持久化）。 */
export function launchChrome({ profile = DEFAULT_PROFILE, port = DEFAULT_PORT } = {}) {
  const bin = process.env.AIZEX_CHROME_BIN
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-features=ChromeWhatsNewUI',
  ];
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/** 轮询等待 CDP 就绪。 */
export async function waitForCdp({ port = DEFAULT_PORT, timeoutMs = 30000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cdpAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 连上 Chrome，返回一个「在聊天站点同源下执行 fetch」的句柄。
 * 优先复用已有的聊天标签页；没有就去开一个。
 */
export async function connectChat({ port = DEFAULT_PORT, profile = DEFAULT_PROFILE, autoLaunch = true } = {}) {
  const puppeteer = await loadPuppeteer();
  if (!(await cdpAlive(port))) {
    if (!autoLaunch) throw new AizexError(`CDP 未就绪：127.0.0.1:${port}`, 'NO_CDP');
    launchChrome({ profile, port });
    if (!(await waitForCdp({ port }))) throw new AizexError('启动 Chrome 后 CDP 仍未就绪', 'NO_CDP');
  }

  const browser = await puppeteer.connect({ browserURL: `http://localhost:${port}`, defaultViewport: null });
  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes(CHAT_HOST));
  if (!page) {
    page = await browser.newPage();
    await page.goto(CHAT_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  /**
   * 在页面里发同源请求，返回 {status, json|text}。
   * ⚠️ 必须带超时：页面被 Chrome 冻结（Mac 睡眠、后台标签挂起）时 evaluate 永不返回，
   * 实测整晚挂死在 300/330 —— 定时任务不能赌唤醒后自愈。
   */
  const api = async (path, init, { timeoutMs = 60000 } = {}) => {
    let timer = null;
    try {
      return await Promise.race([
        page.evaluate(async (p, i) => {
          const res = await fetch(p, { credentials: 'include', ...(i || {}) });
          const ct = res.headers.get('content-type') || '';
          const body = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
          return { status: res.status, contentType: ct, body };
        }, path, init ?? null),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new AizexError('接口请求超时（' + timeoutMs + 'ms）：' + path, 'TIMEOUT')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const close = async () => { try { await browser.disconnect(); } catch { /* ignore */ } };
  return { browser, page, api, close };
}

/** 登录态检查。未登录时 /backend-api/me 不会返回 200 + email。 */
export async function checkSession(chat) {
  const { status, body } = await chat.api('/backend-api/me');
  if (status === 401 || status === 403) {
    return { ok: false, loggedIn: false, code: 'NOT_LOGGED_IN', detail: `HTTP ${status}` };
  }
  const email = body?.email ?? null;
  const ok = status === 200 && Boolean(email);
  return { ok, loggedIn: ok, code: ok ? null : 'NOT_LOGGED_IN', email, detail: `HTTP ${status}` };
}

/** 拉一个分段（固定 is_archived / is_starred 过滤），内部翻页。 */
async function listSegment(chat, {
  pageSize = 100, maxPages = 50, order = 'updated', archived = false, starred = false, onPage,
} = {}) {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const qs = new URLSearchParams({
      offset: String(offset), limit: String(pageSize), order,
      is_archived: String(archived), is_starred: String(starred),
    });
    const { status, body } = await chat.api(`/backend-api/conversations?${qs}`);
    if (status === 401 || status === 403) {
      throw new AizexError('拉取会话列表时鉴权失败，登录态已失效', 'NOT_LOGGED_IN', { status });
    }
    if (status !== 200) throw new AizexError(`拉取会话列表失败：HTTP ${status}`, 'LIST_FAILED', { status, archived, starred });
    const items = body?.items ?? [];
    for (const it of items) {
      if (!it?.id || seen.has(it.id)) continue;
      seen.add(it.id);
      all.push(it);
    }
    onPage?.({ segment: { archived, starred }, page, offset, got: items.length, total: all.length });
    if (items.length < pageSize) break;
  }
  return all;
}

/**
 * 全量列表 = 主列表（未归档未置顶）+ 置顶 + 归档（可选），按 id 去重合并。
 * ⚠️ 实测主列表（is_starred=false）不包含置顶会话 —— 只拉主列表会漏掉置顶那几条，
 *    所以置顶必须单独拉一段再合并。置顶/归档分段失败（接口波动）不挡主列表，
 *    但登录失效（NOT_LOGGED_IN）必须向上抛。
 */
export async function listAllConversations(chat, {
  pageSize = 100, maxPages = 50, order = 'updated', includeArchived = false, onPage,
} = {}) {
  const byId = new Map();
  const merge = (items) => { for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it); };

  merge(await listSegment(chat, { pageSize, maxPages, order, archived: false, starred: false, onPage }));

  try {
    merge(await listSegment(chat, { pageSize, maxPages: 5, order, archived: false, starred: true, onPage }));
  } catch (e) {
    if (e?.code === 'NOT_LOGGED_IN') throw e;
    // 置顶分段挂了不该挡住主列表
  }

  if (includeArchived) {
    try {
      merge(await listSegment(chat, { pageSize, maxPages, order, archived: true, starred: false, onPage }));
      merge(await listSegment(chat, { pageSize, maxPages: 5, order, archived: true, starred: true, onPage }));
    } catch (e) {
      if (e?.code === 'NOT_LOGGED_IN') throw e;
    }
  }
  return [...byId.values()];
}

/** 拉单个会话的完整 JSON（含 mapping）。 */
export async function getConversation(chat, id) {
  const { status, body } = await chat.api(`/backend-api/conversation/${id}`);
  if (status === 401 || status === 403) {
    throw new AizexError('拉取会话详情时鉴权失败，登录态已失效', 'NOT_LOGGED_IN', { status, id });
  }
  if (status !== 200 || !body?.mapping) {
    throw new AizexError(`拉取会话详情失败：HTTP ${status}`, 'DETAIL_FAILED', { status, id });
  }
  return body;
}
