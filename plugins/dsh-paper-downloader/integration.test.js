import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PaperDownloader } from './engine.js';

function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
  let s = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, obj] of objects.entries()) { offsets.push(Buffer.byteLength(s)); s += `${i + 1} 0 obj\n${obj}\nendobj\n`; }
  const start = Buffer.byteLength(s);
  s += 'xref\n0 4\n0000000000 65535 f \n' + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(s + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

test('browser downloads, validates files, and preserves login across restart', { timeout: 180000 }, async () => {
  const pdf = pdfFixture();
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/paper') return res.end('<title>Test paper</title><meta name="citation_pdf_url" content="/download">');
    if (path === '/popup') return res.end('<button onclick="window.open(\'/download\')">Download PDF</button>');
    if (path === '/download' || path === '/direct.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="paper.pdf"' }); return res.end(pdf);
    }
    if (path === '/fake') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="fake.pdf"' }); return res.end('<html>Please log in</html>'); }
    if (path === '/login') {
      res.setHeader('Set-Cookie', 'library=ok; Max-Age=86400; HttpOnly; SameSite=Lax; Path=/');
      return res.end('<title>Signed in</title><a href="/download">Download PDF</a>');
    }
    if (path === '/protected' && req.headers.cookie?.includes('library=ok')) return res.end('<a href="/download">Download PDF</a>');
    res.end('<title>Verification required</title><p>Please sign in or complete verification manually.</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(process.cwd(), '.test-browser-'));
  let engine = new PaperDownloader({ dataDir: dir, headless: true, settleMs: 300, navigationTimeoutMs: 5000 });
  try {
    const first = await engine.start(base + '/paper');
    assert.equal(first.status, 'completed', JSON.stringify(first));
    assert.deepEqual(await readFile(first.path), pdf);
    const direct = await engine.start(base + '/direct.pdf');
    assert.equal(direct.status, 'completed', JSON.stringify(direct));
    assert.notEqual(first.path, direct.path);
    const popup = await engine.start(base + '/popup');
    assert.equal(popup.status, 'completed', JSON.stringify(popup));
    const paused = await engine.start(base + '/protected');
    assert.equal(paused.status, 'needs_attention', JSON.stringify(paused));
    // Simulate the user's navigation after completing a login in the retained browser.
    await engine._context.pages().at(-1).goto(base + '/login');
    const login = await engine.resume(paused.id);
    assert.equal(login.status, 'completed', JSON.stringify(login));
    await engine.close();
    engine = new PaperDownloader({ dataDir: dir, headless: true, settleMs: 300, navigationTimeoutMs: 5000 });
    const protectedResult = await engine.start(base + '/protected');
    assert.equal(protectedResult.status, 'completed', JSON.stringify(protectedResult));
    const fake = await engine.start(base + '/fake');
    assert.notEqual(fake.status, 'completed');
    assert.equal(fake.path, undefined);
    assert.equal((await engine.cancel(fake.id)).status, 'failed');
    const afterCancel = await engine.start(base + '/paper');
    assert.equal(afterCancel.status, 'completed', JSON.stringify(afterCancel));
    await engine.close();
    const saved = await engine.status(first.id);
    assert.equal(saved.status, 'completed');
  } finally {
    await engine.close();
    await new Promise(resolve => server.close(resolve));
  }
});
