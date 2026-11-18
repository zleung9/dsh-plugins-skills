import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs, constants } from 'node:fs';

const TERMINAL = new Set(['completed', 'failed']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SUPPLEMENT = /supplement|supporting[\s_-]*(?:information|material)|appendi(?:x|ces)|附件|补充材料/i;
const PDF_HINT = /\.pdf(?:[?#]|$)|\/pdf(?:[/?#]|$)|[?&](?:format|type)=pdf/i;
const PDF_LABEL = /(?:view|download|read|open|get|full[ -]?text)\s*(?:the\s*)?(?:article\s*)?pdf|pdf\s*(?:download|full[ -]?text)|下载\s*(?:全文|PDF)|查看\s*PDF|^\s*PDF\s*$/i;
const MAX_RUN_MS = 55_000;
const MAX_STEPS = 8;
const MAX_CANDIDATES = 12;
const isPDF = (body) => body.length >= 5 && body.subarray(0, 5).toString('ascii') === '%PDF-';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeURL = (value, base) => {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};
const cleanName = (name) => String(name || 'paper').replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 100) || 'paper';

/** A single-user, single-active-job browser downloader. No HTTP requests outside Chromium. */
export class PaperDownloader {
  constructor({ dataDir, channel = 'chrome', headless = false, navigationTimeoutMs = 20000, settleMs = 2500 } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('dataDir is required');
    for (const [name, value] of Object.entries({ navigationTimeoutMs, settleMs })) {
      if (!Number.isFinite(value) || value < 0 || (name === 'navigationTimeoutMs' && value === 0)) throw new TypeError(`${name} must be a finite positive timeout`);
    }
    this.dataDir = path.resolve(dataDir);
    this.channel = channel;
    this.headless = Boolean(headless);
    this.navigationTimeoutMs = Math.min(navigationTimeoutMs, 20000);
    this.settleMs = Math.min(settleMs, 5000);
    this._context = null;
    this._launch = null;
    this._active = null;
    this._busy = false;
    this._closing = false;
    this._generation = 0;
    this._pages = new Set();
    this._listeners = [];
    this._pending = new Set();
    this._writes = Promise.resolve();
    this._ready = null;
    this._token = null;
    this._accepting = false;
  }

  async _init() {
    if (!this._ready) this._ready = (async () => {
      for (const dir of [this.dataDir, this._dir('jobs'), this._dir('downloads'), this._dir('browser-profile'), this._dir('download-staging')]) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.chmod(dir, 0o700);
      }
      const jobs = await this._readJobs();
      this._active = jobs.find((job) => !TERMINAL.has(job.status)) || null;
      if (this._active?.status === 'running') {
        this._active.status = 'needs_attention';
        this._active.message = '上次运行已中断，请恢复任务。';
        await this._persist(this._active);
      }
    })();
    return this._ready;
  }

  async withReadingBrowser(operation) {
    if (this._busy || this._closing) throw new Error('浏览器正在处理其他任务，请稍后重试');
    this._busy = true;
    try {
      await this._init();
      return await operation(await this._browser());
    } finally { this._busy = false; }
  }

  excludeReadingPage(page) {
    // Reading must never satisfy or replace a pending download from another tab.
    this._pages.delete(page);
  }

  _dir(name) { return path.join(this.dataDir, name); }
  _snapshot(job) {
    // Explicit allowlist: never serialize browser state, cookies, or raw errors.
    const result = {};
    for (const key of ['id', 'url', 'status', 'path', 'title', 'message', 'createdAt', 'updatedAt', 'attempts']) {
      if (job[key] !== undefined) result[key] = job[key];
    }
    return result;
  }

  _persist(job) {
    job.updatedAt = new Date().toISOString();
    const content = JSON.stringify(this._snapshot(job), null, 2) + '\n';
    const filename = path.join(this._dir('jobs'), `${job.id}.json`);
    const operation = this._writes.then(async () => {
      const handle = await fs.open(filename, 'w', 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
    });
    this._writes = operation.catch(() => {});
    return operation;
  }

  async _readJob(id) {
    if (!UUID.test(String(id))) throw new TypeError('Invalid job id');
    const job = JSON.parse(await fs.readFile(path.join(this._dir('jobs'), `${id}.json`), 'utf8'));
    if (job.id !== id || !safeURL(job.url) || !['running', 'needs_attention', 'completed', 'failed'].includes(job.status)) throw new Error('Invalid job record');
    return this._snapshot(job);
  }

  async _readJobs() {
    const names = await fs.readdir(this._dir('jobs'));
    const jobs = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
      try { jobs.push(await this._readJob(name.slice(0, -5))); } catch { /* A partial/corrupt record must not hide other jobs. */ }
    }
    return jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async status(id) {
    await this._init();
    await this._writes;
    if (id !== undefined) return this._active?.id === id ? this._snapshot(this._active) : this._readJob(id);
    return (await this._readJobs()).slice(0, 20);
  }

  async start(url) {
    const normalized = safeURL(url);
    if (!normalized) throw new TypeError('url must be an HTTP(S) URL without embedded credentials');
    if (this._busy || this._closing) throw new Error('A task operation is already running');
    this._busy = true;
    try {
      await this._init();
      if (this._active && !TERMINAL.has(this._active.status)) throw new Error(`Active task ${this._active.id} must be resumed first`);
      this._accepting = false;
      this._active = { id: randomUUID(), url: normalized, status: 'running', createdAt: new Date().toISOString(), attempts: 1 };
      await this._persist(this._active);
      return await this._run(this._active, false);
    } finally { this._busy = false; }
  }

  async resume(id) {
    if (this._busy || this._closing) throw new Error('A task operation is already running');
    this._busy = true;
    try {
      await this._init();
      if (this._active && this._active.id !== id && !TERMINAL.has(this._active.status)) throw new Error(`Another task ${this._active.id} is active`);
      const job = this._active?.id === id ? this._active : await this._readJob(id);
      if (TERMINAL.has(job.status)) return this._snapshot(job);
      this._active = job;
      job.status = 'running';
      job.attempts = (job.attempts || 0) + 1;
      delete job.message;
      await this._persist(job);
      return await this._run(job, true);
    } finally { this._busy = false; }
  }

  _listen(emitter, event, handler) {
    emitter.on(event, handler);
    this._listeners.push(() => emitter.off(event, handler));
  }

  _track(operation) {
    const guarded = Promise.resolve(operation).catch(() => {}).finally(() => this._pending.delete(guarded));
    this._pending.add(guarded);
    return guarded;
  }

  _detach() {
    for (const remove of this._listeners.splice(0)) remove();
    this._pages.clear();
  }

  async _browser() {
    if (this._context) return this._context;
    if (this._launch) return this._launch;
    const generation = this._generation;
    const launch = (async () => {
      const { chromium } = await import('playwright-core');
      const context = await chromium.launchPersistentContext(this._dir('browser-profile'), {
        channel: this.channel, headless: this.headless, acceptDownloads: true,
        timeout: 20000,
      });
      if (generation !== this._generation || this._closing) {
        await context.close();
        throw new Error('Browser opening was cancelled');
      }
      this._context = context;
      context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      context.setDefaultTimeout(Math.min(this.navigationTimeoutMs, 5000));
      this._listen(context, 'page', (page) => this._attachPage(page));
      this._listen(context, 'response', (response) => {
        const job = this._active;
        let page;
        try { page = response.frame().page(); } catch { return; }
        if (!job || !this._accepting || !this._pages.has(page) || TERMINAL.has(job.status)) return;
        const headers = response.headers();
        const url = response.url();
        if (SUPPLEMENT.test(url) || response.status() >= 400) return;
        if (/application\/pdf|application\/octet-stream/i.test(headers['content-type'] || '') || PDF_HINT.test(url) || /\.pdf/i.test(headers['content-disposition'] || '')) {
          this._track((async () => {
            const body = await response.body();
            if (isPDF(body)) await this._saveBody(job, body, 'paper');
          })());
        }
      });
      this._listen(context, 'close', () => {
        if (this._context !== context) return;
        this._context = null;
        this._accepting = false;
        this._detach();
      });
      for (const page of context.pages()) this._attachPage(page);
      return context;
    })();
    this._launch = launch;
    try { return await launch; } finally { if (this._launch === launch) this._launch = null; }
  }

  _attachPage(page) {
    if (this._pages.has(page)) return;
    this._pages.add(page);
    this._listen(page, 'download', (download) => {
      const job = this._active;
      if (!job || !this._accepting || !this._pages.has(page) || TERMINAL.has(job.status)) return;
      if (SUPPLEMENT.test(`${download.url()} ${download.suggestedFilename()}`)) return;
      this._track(this._saveDownload(job, download));
    });
    this._listen(page, 'close', () => this._pages.delete(page));
  }

  _canSave(job) { return this._active === job && !TERMINAL.has(job.status) && !this._closing; }

  async _saveBody(job, body, name) {
    if (!isPDF(body) || !this._canSave(job)) return;
    // Claim synchronously before the first await so response/download races save once.
    if (job._saving) return;
    job._saving = true;
    try {
      const filename = path.join(this._dir('downloads'), `${randomUUID()}-${cleanName(name)}.pdf`);
      await fs.writeFile(filename, body, { flag: 'wx', mode: 0o600 });
      if (!this._canSave(job)) return;
      job.path = filename;
      job.status = 'completed';
      job.message = 'PDF 已保存。';
      await this._persist(job);
    } finally { job._saving = false; }
  }

  async _saveDownload(job, download) {
    // Quarantine untrusted bytes outside downloads. No deletes or moves are used.
    const staging = path.join(this._dir('download-staging'), `${randomUUID()}.part`);
    await fs.writeFile(staging, '', { flag: 'wx', mode: 0o600 });
    await download.saveAs(staging);
    await fs.chmod(staging, 0o600);
    const handle = await fs.open(staging, 'r');
    const magic = Buffer.alloc(5);
    try { await handle.read(magic, 0, 5, 0); } finally { await handle.close(); }
    if (!isPDF(magic) || !this._canSave(job) || job._saving) return;
    job._saving = true;
    try {
      const filename = path.join(this._dir('downloads'), `${randomUUID()}-${cleanName(download.suggestedFilename())}.pdf`);
      await fs.copyFile(staging, filename, constants.COPYFILE_EXCL);
      await fs.chmod(filename, 0o600);
      if (!this._canSave(job)) return;
      job.path = filename;
      job.status = 'completed';
      job.message = 'PDF 已保存。';
      await this._persist(job);
    } finally { job._saving = false; }
  }

  async _run(job, resume) {
    const token = { live: true, deadline: Date.now() + MAX_RUN_MS };
    this._token = token;
    let timer;
    try {
      const work = this._explore(job, resume, token);
      const outcome = await Promise.race([
        work.then(() => 'done'),
        new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), MAX_RUN_MS); }),
      ]);
      token.live = false;
      if (!TERMINAL.has(job.status)) {
        job.status = 'needs_attention';
        job.message ||= outcome === 'timeout' ? '已达到本轮时间上限。请在浏览器完成验证或打开论文 PDF，再恢复任务。' : '未找到可保存的主文 PDF。请在浏览器完成登录、验证或打开 PDF，再恢复任务。';
        await this._persist(job);
      }
    } catch {
      token.live = false;
      if (!TERMINAL.has(job.status)) {
        job.status = this._context ? 'needs_attention' : 'failed';
        job.message = this._context ? '浏览器访问暂未完成，请在窗口处理后恢复任务。' : '无法启动或连接浏览器。请确认已安装所选浏览器，且专用资料目录未被其他实例占用。';
        await this._persist(job);
      }
    } finally {
      clearTimeout(timer);
      token.live = false;
      if (this._token === token) this._token = null;
    }
    return this._snapshot(job);
  }

  _live(job, token) { return token.live && Date.now() < token.deadline && this._active === job && job.status === 'running' && !this._closing; }
  _timeout(token) { return Math.max(1, Math.min(this.navigationTimeoutMs, token.deadline - Date.now())); }

  async _navigate(page, url, token) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this._timeout(token) }); }
    catch { /* Chromium reports ERR_ABORTED when navigation becomes a download. */ }
  }

  async _settle(job, token) {
    const end = Math.min(token.deadline, Date.now() + this.settleMs);
    while (this._live(job, token) && Date.now() < end) await delay(Math.min(100, end - Date.now()));
  }

  async _inspect(page) {
    return page.evaluate(({ supplement, label, hint, limit }) => {
      const supplemental = new RegExp(supplement, 'i');
      const pdfLabel = new RegExp(label, 'i');
      const pdfHint = new RegExp(hint, 'i');
      const bodyText = (document.body?.innerText || '').slice(0, 18000);
      const challenged = /verify (?:that )?you are human|checking your browser|verify your identity|complete the security check|unusual traffic|确认您是人类|人机验证|安全验证/i.test(bodyText)
        || /just a moment|attention required/i.test(document.title)
        || [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha')].some((el) => el.getBoundingClientRect().height > 0);
      const candidates = [];
      const add = (raw, text, score, selector) => {
        if (supplemental.test(`${raw || ''} ${text || ''}`)) return;
        let url;
        try { if (raw && !raw.trim().startsWith('#')) { const parsed = new URL(raw, document.baseURI); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } } catch { /* malformed link */ }
        if (url || selector) candidates.push({ url, score, selector });
      };
      for (const meta of document.querySelectorAll('meta[name="citation_pdf_url" i],meta[property="citation_pdf_url" i]')) add(meta.content, '', 100);
      for (const [index, node] of [...document.querySelectorAll('a,iframe,embed,object,button,input[type="button"],input[type="submit"],[role="button"]')].slice(0, 3000).entries()) {
        const raw = node.getAttribute('href') || node.getAttribute('src') || node.getAttribute('data');
        const text = `${node.innerText || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''} ${node.value || ''}`.trim();
        const kind = node.tagName.toLowerCase();
        if (pdfHint.test(raw || '') || pdfLabel.test(text) || node.getAttribute('type') === 'application/pdf') {
          // DOM index is rechecked by locator at click time; no page attributes are modified.
          add(raw, text, pdfHint.test(raw || '') ? 80 : 60, { index, text: text.slice(0, 300), kind });
        }
      }
      // Common PDF.js viewers carry the underlying document in a file URL parameter.
      for (const key of ['file', 'pdf', 'url']) {
        const value = new URL(location.href).searchParams.get(key);
        if (value && pdfHint.test(value)) add(value, '', 90);
      }
      const seen = new Set();
      return { title: document.title.slice(0, 300), challenged, candidates: candidates.sort((a, b) => b.score - a.score).filter((c) => {
        const key = c.url || JSON.stringify(c.selector);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, limit) };
    }, { supplement: SUPPLEMENT.source, label: PDF_LABEL.source, hint: PDF_HINT.source, limit: MAX_CANDIDATES });
  }

  async _explore(job, resume, token) {
    const context = await this._browser();
    if (!this._live(job, token)) return;
    let page = resume ? [...this._pages].filter((p) => !p.isClosed() && p.url() !== 'about:blank').at(-1) : null;
    if (!page) {
      // Exclude previous completed task pages to avoid unrelated late responses.
      this._pages.clear();
      page = await context.newPage();
      this._attachPage(page);
      if (!this._live(job, token)) return;
      this._accepting = true;
      await this._navigate(page, job.url, token);
    } else this._accepting = true;
    const visited = new Set();
    const clicked = new Set();
    const queue = [];
    let steps = 0;
    let reloaded = false;
    while (this._live(job, token) && steps < MAX_STEPS) {
      await this._settle(job, token);
      if (!this._live(job, token)) break;
      const pages = [...this._pages].filter((p) => !p.isClosed());
      for (const current of pages.reverse().slice(0, 6)) {
        if (!this._live(job, token)) return;
        let info;
        try { info = await this._inspect(current); } catch { continue; }
        if (!this._live(job, token)) return;
        if (info.title && !job.title) job.title = info.title;
        if (info.challenged) {
          job.message = '页面需要人工验证。请在保留的浏览器窗口完成验证，然后恢复任务。';
          return;
        }
        for (const candidate of info.candidates) {
          if (queue.length >= MAX_CANDIDATES) break;
          if (candidate.url && !visited.has(candidate.url)) queue.push({ ...candidate, page: current });
          else if (!candidate.url && candidate.selector) {
            const key = `${current.url()}#${candidate.selector.index}`;
            if (!clicked.has(key)) queue.push({ ...candidate, page: current, key });
          }
        }
      }
      if (!this._live(job, token)) break;
      const candidate = queue.shift();
      if (!candidate) {
        // Resume a PDF viewer whose original response happened before listeners attached.
        if (resume && !reloaded && !page.isClosed()) {
          reloaded = true; steps++;
          await this._navigate(page, safeURL(page.url()) || job.url, token);
          continue;
        }
        break;
      }
      if (candidate.url) {
        if (visited.has(candidate.url)) continue;
        visited.add(candidate.url);
        steps++;
        page = candidate.page;
        await this._navigate(page, candidate.url, token);
      } else {
        if (clicked.has(candidate.key) || candidate.page.isClosed()) continue;
        clicked.add(candidate.key);
        steps++;
        try {
          const locator = candidate.page.locator('a,iframe,embed,object,button,input[type="button"],input[type="submit"],[role="button"]').nth(candidate.selector.index);
          const text = await locator.evaluate((node) => `${node.innerText || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''} ${node.value || ''}`.trim());
          if (this._live(job, token) && text.slice(0, 300) === candidate.selector.text && !SUPPLEMENT.test(text)) await locator.click({ timeout: Math.min(5000, this._timeout(token)), noWaitAfter: true });
        } catch { /* Continue with another bounded candidate. */ }
      }
    }
    await this._settle(job, token);
  }

  async cancel(id) {
    if (this._busy || this._closing) throw new Error('A task operation is already running');
    await this._init();
    if (!this._active || this._active.id !== id) throw new Error('Task is not active');
    if (TERMINAL.has(this._active.status)) return this._snapshot(this._active);
    await this.close();
    this._active.status = 'failed';
    this._active.message = '用户已取消任务，可以开始新的下载。';
    await this._persist(this._active);
    return this._snapshot(this._active);
  }

  async close() {
    if (this._closing) return;
    this._closing = true;
    this._generation++;
    this._accepting = false;
    if (this._token) this._token.live = false;
    const context = this._context;
    this._context = null;
    this._detach();
    try {
      if (context) await context.close();
      if (this._launch) await this._launch.catch(() => {});
      await Promise.allSettled([...this._pending]);
      if (this._active && !TERMINAL.has(this._active.status)) {
        this._active.status = 'needs_attention';
        this._active.message = '浏览器已关闭；恢复任务将重新打开原始 URL 并保留登录状态。';
        await this._persist(this._active);
      }
      await this._writes;
    } finally { this._closing = false; }
  }
}
