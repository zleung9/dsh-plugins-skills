import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { PaperDownloader } from './engine.js';
import { PaperReader } from './reader.js';

const article = `<title>Test research</title><meta name="citation_title" content="Test research"><meta name="citation_doi" content="10.1234/test"><main><article><h1>Test research</h1><section><h2>Abstract</h2><p>${'Our study compares treatment outcomes. '.repeat(12)}</p></section><section><h2>Introduction</h2><p>${'The background establishes the research question. '.repeat(30)}</p></section><section><h2>Methods</h2><p>${'We recruited participants and measured outcomes. '.repeat(30)}</p></section><section><h2>Results</h2><p>${'The observations showed a significant difference. '.repeat(30)}</p></section><section><h2>Discussion</h2><p>${'The findings have limitations and implications. '.repeat(30)}</p></section></article></main>`;

test('reader snapshots paginate, resume validation, share cookies, and isolate pending downloads', { timeout: 180000 }, async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/paper') return res.end(article);
    if (req.url === '/abstract-gated') return res.end('<article><h2>Abstract</h2><p>This is the accessible abstract.</p></article><div role="alert">Sign in to read the full text.</div>');
    if (req.url === '/login') {
      res.setHeader('Set-Cookie', 'library=ok; Max-Age=86400; Path=/; HttpOnly');
      return res.end(article);
    }
    if (req.url === '/protected' && req.headers.cookie?.includes('library=ok')) return res.end(article);
    if (req.url === '/pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="test.pdf"' }); return res.end('%PDF-1.4\n%%EOF'); }
    res.end('<title>Just a moment</title><main>Verify you are human</main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dataDir = await mkdtemp(path.join(process.cwd(), '.test-browser-reader-'));
  let engine = new PaperDownloader({ dataDir, headless: true, settleMs: 200, navigationTimeoutMs: 5000 });
  let reader = new PaperReader(engine);
  try {
    const result = await reader.read({ url: base + '/paper', limit: 80 });
    assert.equal(result.coverage, 'full_text', JSON.stringify(result));
    assert.ok(result.toc.length >= 4);
    assert.equal(result.text.length, 80);
    assert.equal(result.range.nextOffset, 80);
    assert.equal(result.truncated, true);
    const hitCount = hits;
    const next = await reader.read({ id: result.id, offset: 80, limit: 80 });
    assert.equal(next.range.offset, 80);
    assert.equal(hits, hitCount, 'cached reading must not navigate');
    const methods = result.toc.find(s => /methods/i.test(s.title));
    const section = await reader.read({ id: result.id, section: methods.id });
    assert.match(section.text, /recruited participants/);
    assert.doesNotMatch(section.text, /observations showed/);
    await assert.rejects(reader.read({ id: result.id, section: 'missing' }));
    await assert.rejects(reader.read({ url: 'file:///etc/passwd' }));
    await assert.rejects(reader.read({ id: result.id, limit: 16001 }));

    const gated = await reader.read({ url: base + '/abstract-gated' });
    assert.equal(gated.coverage, 'abstract_only');
    assert.equal(gated.status, 'needs_attention');
    assert.match(gated.text, /accessible abstract/);
    const blocked = await reader.read({ url: base + '/protected' });
    assert.equal(blocked.status, 'needs_attention');
    await reader.pages.get(blocked.id).goto(base + '/login');
    const resumed = await reader.read({ id: blocked.id, refresh: true });
    assert.equal(resumed.coverage, 'full_text');
    assert.equal(resumed.url, base + '/login');

    const waiting = await engine.start(base + '/verify');
    assert.equal(waiting.status, 'needs_attention');
    const pdf = await reader.read({ url: base + '/pdf' });
    assert.equal(pdf.coverage, 'pdf_only');
    assert.equal((await engine.status(waiting.id)).status, 'needs_attention', 'reading PDF must not complete an unrelated download');
    await engine.cancel(waiting.id);
    await engine.close();
    engine = new PaperDownloader({ dataDir, headless: true, settleMs: 200, navigationTimeoutMs: 5000 });
    reader = new PaperReader(engine);
    assert.equal((await reader.read({ id: result.id, section: methods.id })).id, result.id);
    const cookieRead = await reader.read({ url: base + '/protected' });
    assert.equal(cookieRead.coverage, 'full_text', 'persistent browser cookies shared with reader');
    const downloaded = await engine.start(base + '/pdf');
    assert.equal(downloaded.status, 'completed');
  } finally {
    await engine.close();
    await new Promise(resolve => server.close(resolve));
  }
});
