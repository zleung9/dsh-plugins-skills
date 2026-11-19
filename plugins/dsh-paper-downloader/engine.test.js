import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PaperDownloader } from './engine.js';

const PDF = Buffer.from('%PDF-1.4\nunit test PDF bytes\n%%EOF');
const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'paper-engine-test-'));

class FakePage extends EventEmitter {
  constructor(context) { super(); this.context = context; this.address = 'about:blank'; this.closed = false; this.visits = []; }
  url() { return this.address; }
  isClosed() { return this.closed; }
  async goto(url) { this.address = url; this.visits.push(url); await this.context.onVisit?.(this, url); }
}
class FakeContext extends EventEmitter {
  constructor() { super(); this.list = []; }
  async newPage() { const page = new FakePage(this); this.list.push(page); this.emit('page', page); return page; }
  pages() { return this.list; }
  async close() { for (const page of this.list) { page.closed = true; page.emit('close'); } this.emit('close'); }
}
class FakeDownloader extends PaperDownloader {
  constructor(options) { super({ settleMs: 0, ...options }); this.openCount = 0; this.inspection = () => ({ title: 'Example article', challenged: false, candidates: [] }); }
  async _browser() {
    if (this._context) return this._context;
    this.openCount++;
    this._context = new FakeContext();
    this._listen(this._context, 'page', (page) => this._attachPage(page));
    return this._context;
  }
  async _inspect(page) { return this.inspection(page); }
}

// Test directories intentionally remain: the engine contract forbids delete/move operations.
test('validates URLs, ids and timeout settings', async () => {
  assert.throws(() => new PaperDownloader({}), /dataDir/);
  assert.throws(() => new PaperDownloader({ dataDir: '/tmp/x', navigationTimeoutMs: 0 }), /timeout/);
  const engine = new FakeDownloader({ dataDir: await temporary() });
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.org']) await assert.rejects(engine.start(url), /HTTP/);
  await assert.rejects(engine.status('../outside'), /Invalid job id/);
  await engine.close();
});

test('persists attention state, private modes, and rejects another active task', async () => {
  const dataDir = await temporary();
  const engine = new FakeDownloader({ dataDir });
  const job = await engine.start('https://example.org/article');
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.title, 'Example article');
  assert.equal(job.attempts, 1);
  assert.equal(engine._context.pages()[0].isClosed(), false);
  await assert.rejects(engine.start('https://example.org/other'), /Active task/);
  assert.deepEqual(await engine.status(job.id), job);
  for (const name of ['', 'jobs', 'downloads', 'browser-profile', 'download-staging']) assert.equal((await fs.stat(path.join(dataDir, name))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dataDir, 'jobs', `${job.id}.json`))).mode & 0o777, 0o600);
  await engine.close();
});

test('rejects overlapping start and resume synchronously', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  let unblock;
  engine._inspect = () => new Promise((resolve) => { unblock = resolve; });
  const first = engine.start('https://example.org/article');
  await assert.rejects(engine.start('https://example.org/other'), /already running/);
  while (!unblock) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(engine.resume(engine._active.id), /already running/);
  unblock({ challenged: false, candidates: [] });
  await first;
  await engine.close();
});

test('saves only PDF magic, hides internals, and deduplicates races', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  const job = await engine.start('https://example.org/article');
  await engine._saveBody(engine._active, Buffer.from('<html>login</html>'), 'bad');
  assert.deepEqual(await fs.readdir(engine._dir('downloads')), []);
  await Promise.all([engine._saveBody(engine._active, PDF, '../../unsafe.pdf'), engine._saveBody(engine._active, PDF, 'duplicate')]);
  const result = await engine.status(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result._saving, undefined);
  assert.equal(path.dirname(result.path), engine._dir('downloads'));
  assert.match(path.basename(result.path), /^[a-f0-9-]{36}-/);
  assert.deepEqual(await fs.readFile(result.path), PDF);
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(engine._dir('downloads'))).length, 1);
  await engine.close();
});

test('download.saveAs quarantines non-PDF and validates a genuine PDF', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  await engine.start('https://example.org/article');
  const download = (bytes) => ({ suggestedFilename: () => 'article.pdf', saveAs: async (target) => fs.writeFile(target, bytes) });
  await engine._saveDownload(engine._active, download(Buffer.from('HTML challenge')));
  assert.equal((await fs.readdir(engine._dir('downloads'))).length, 0);
  await engine._saveDownload(engine._active, download(PDF));
  assert.equal(engine._active.status, 'completed');
  assert.deepEqual(await fs.readFile(engine._active.path), PDF);
  for (const name of await fs.readdir(engine._dir('download-staging'))) assert.equal((await fs.stat(path.join(engine._dir('download-staging'), name))).mode & 0o777, 0o600);
  await engine.close();
});

test('challenge halts candidate navigation and preserves the window', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  engine.inspection = () => ({ challenged: true, title: 'Verify', candidates: [{ url: 'https://example.org/main.pdf' }] });
  const job = await engine.start('https://example.org/article');
  assert.equal(job.status, 'needs_attention');
  assert.match(job.message, /人工验证/);
  assert.deepEqual(engine._context.pages()[0].visits, ['https://example.org/article']);
  await engine.close();
});

test('candidate visits are bounded and repeats are not visited twice', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  engine.inspection = () => ({ challenged: false, candidates: Array.from({ length: 30 }, (_, i) => ({ url: `https://example.org/${i}.pdf` })) });
  await engine.start('https://example.org/article');
  const visits = engine._context.pages()[0].visits;
  assert.equal(visits.length, 9);
  assert.equal(new Set(visits).size, visits.length);
  await engine.close();
});

test('resume preserves a manually navigated page and completes a PDF', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  const job = await engine.start('https://example.org/article');
  const page = engine._context.pages()[0];
  page.address = 'https://example.org/unlocked';
  engine.inspection = () => ({ challenged: false, candidates: [{ url: 'https://example.org/main.pdf' }] });
  engine._context.onVisit = async (_, url) => { if (url.endsWith('.pdf')) await engine._saveBody(engine._active, PDF, 'main'); };
  const result = await engine.resume(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.attempts, 2);
  assert.equal(engine.openCount, 1);
  assert.deepEqual(page.visits, ['https://example.org/article', 'https://example.org/main.pdf']);
  await engine.close();
});

test('close cleans listeners and permits reopening with the same profile', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  const job = await engine.start('https://example.org/article');
  const oldContext = engine._context;
  const oldPage = oldContext.pages()[0];
  await engine.close();
  assert.equal(oldContext.listenerCount('page'), 0);
  assert.equal(oldPage.listenerCount('download'), 0);
  await engine.resume(job.id);
  assert.equal(engine.openCount, 2);
  assert.equal(engine._context.pages()[0].visits[0], job.url);
  await engine.close();
});

test('restart restores active state and the original URL', async () => {
  const dataDir = await temporary();
  const first = new FakeDownloader({ dataDir });
  const job = await first.start('https://example.org/article');
  await first.close();
  const second = new FakeDownloader({ dataDir });
  await assert.rejects(second.start('https://example.org/new'), /Active task/);
  await second.resume(job.id);
  assert.equal(second._context.pages()[0].visits[0], job.url);
  await second.close();
});

test('history returns latest twenty and ignores malformed records', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  await engine._init();
  for (let i = 0; i < 25; i++) await engine._persist({ id: randomUUID(), url: `https://example.org/${i}`, status: 'completed', createdAt: new Date().toISOString() });
  await fs.writeFile(path.join(engine._dir('jobs'), `${randomUUID()}.json`), '{partial', { mode: 0o600 });
  assert.equal((await engine.status()).length, 20);
  await engine.close();
});

test('failed browser launch returns a persisted failed job and can retry a new task', async () => {
  const engine = new FakeDownloader({ dataDir: await temporary() });
  engine._browser = async () => { throw new Error('browser missing; internal details'); };
  const job = await engine.start('https://example.org/article');
  assert.equal(job.status, 'failed');
  assert.doesNotMatch(job.message, /internal details/);
  assert.equal((await engine.status(job.id)).status, 'failed');
  const next = await engine.start('https://example.org/second');
  assert.notEqual(next.id, job.id);
  await engine.close();
});
