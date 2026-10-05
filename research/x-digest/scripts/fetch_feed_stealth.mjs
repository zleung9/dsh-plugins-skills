#!/usr/bin/env node
// fetch_feed_stealth.mjs — headless capture with a real-Chrome UA + explicit proxy.
// Used when headed launch is unavailable (process-singleton failure) but the
// system proxy (Clash @ 127.0.0.1:7890) is up.  Same output schema as fetch_feed.mjs.
//
// Usage: node scripts/fetch_feed_stealth.mjs [--scrolls 20] [--wait 2200] [--out data/feed.json] [--merge]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { X_PROFILE as PROFILE } from "./pw-common.mjs";

const argv = process.argv.slice(2);
function getArg(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const SCROLLS = parseInt(getArg("--scrolls", "20"), 10);
const WAIT = parseInt(getArg("--wait", "2200"), 10);
const OUT = resolve(process.cwd(), getArg("--out", "data/feed.json"));
const PROXY = getArg("--proxy", "http://127.0.0.1:7890");
const REAL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
// Profile path comes from pw-common.mjs (~/.agents/browser-profiles/x-digest),
// deliberately outside this skill dir so Nutstore never syncs a live profile.
const log = (m) => process.stderr.write(`[stealth] ${m}\n`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1380, height: 900 },
  locale: "zh-CN",
  userAgent: REAL_UA,
  proxy: { server: PROXY },
  args: ["--disable-blink-features=AutomationControlled", "--disable-features=IsolateOrigins,site-per-process"],
});
let exitCode = 0;
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
  if (/login|flow/i.test(page.url())) {
    log("NOT_LOGGED_IN — run: node scripts/x-login.mjs");
    exitCode = 2;
  } else {
    await capture(page);
  }
} finally {
  await ctx.close();
}
process.exit(exitCode);

async function capture(page) {
  const tabInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[role="tab"]'));
    const cur = btns.find((t) => t.getAttribute("aria-selected") === "true");
    return { tabs: btns.map((t) => t.textContent.trim()), current: cur ? cur.textContent.trim() : null };
  });
  log("tabs: " + JSON.stringify(tabInfo));
  if (tabInfo.current && !/following/i.test(tabInfo.current)) {
    const switched = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('[role="tab"]'));
      const f = btns.find((t) => /following/i.test(t.textContent));
      if (f) { f.click(); return true; }
      return false;
    });
    log("switched to Following tab: " + switched);
    await page.waitForTimeout(3500);
  }

  let n = 0;
  for (let i = 0; i < 30; i++) {
    n = await page.locator("article").count();
    if (n > 0) break;
    await page.waitForTimeout(1000);
  }
  log(`initial articles in DOM: ${n}`);

  const extract = () =>
    page.evaluate(() => {
      const out = [];
      for (const art of document.querySelectorAll("article")) {
        try {
          const statusA = Array.from(art.querySelectorAll('a[href*="/status/"]'))
            .map((a) => a.getAttribute("href"))
            .find((h) => /\/status\/\d+/.test(h || ""));
          if (!statusA) continue;
          const id = (statusA.match(/\/status\/(\d+)/) || [])[1];
          if (!id) continue;
          let handle = "", name = "";
          const profA = Array.from(art.querySelectorAll("a[href]")).find((a) => {
            const h = a.getAttribute("href") || "";
            return /^\/[A-Za-z0-9_]{1,15}$/.test(h) && h !== "/home";
          });
          if (profA) {
            const t = (profA.textContent || "").trim();
            const parts = t.split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
            for (const part of parts) {
              if (part.startsWith("@")) handle = part.replace(/^@/, "");
              else if (!name) name = part;
            }
            if (!handle) handle = (profA.getAttribute("href") || "").replace(/^\//, "");
          }
          const txt = art.querySelector('[data-testid="tweetText"]');
          const text = txt ? txt.innerText.trim() : "";
          const timeEl = art.querySelector("a time");
          const time = timeEl ? timeEl.getAttribute("datetime") || "" : "";
          const isRT = /Repost(ed)?\b|retweeted|转推/i.test(art.innerText.slice(0, 80));
          out.push({ id, handle, name, text, time, link: "https://x.com" + statusA.split("?")[0], rt: isRT });
        } catch {}
      }
      return out;
    });

  const byId = new Map();
  async function drain() {
    const list = await extract();
    let added = 0;
    for (const t of list) {
      if (!byId.has(t.id)) { byId.set(t.id, t); added++; }
      else {
        const old = byId.get(t.id);
        if (t.text.length > old.text.length) old.text = t.text;
      }
    }
    return { total: byId.size, added };
  }

  let first = await drain();
  log(`captured: ${first.total}`);
  if (first.total === 0) {
    // likely network still down — surface the on-page signal for diagnosis
    const sig = await page.evaluate(() => {
      const t = document.body.innerText;
      return {
        lost: /lost connectivity/i.test(t),
        wrong: /something went wrong/i.test(t),
        url: location.href,
      };
    });
    log("page signal: " + JSON.stringify(sig));
  }

  let same = 0;
  for (let i = 0; i < SCROLLS; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(WAIT);
    const r = await drain();
    log(`scroll ${i + 1}/${SCROLLS}: +${r.added}, total ${r.total}`);
    if (r.added === 0) {
      same++;
      if (same >= 4) { log("feed exhausted (4 scrolls, no new)"); break; }
    } else same = 0;
  }

  let tweets = [...byId.values()];
  if (existsSync(OUT) && argv.includes("--merge")) {
    try {
      const prev = JSON.parse(readFileSync(OUT, "utf8"));
      const m = new Map(tweets.map((t) => [t.id, t]));
      for (const t of prev.tweets || []) if (!m.has(t.id)) m.set(t.id, t);
      tweets = [...m.values()];
      log(`merged with previous file -> ${tweets.length}`);
    } catch {}
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), count: tweets.length, tweets }, null, 2));
  log(`saved ${tweets.length} tweets -> ${OUT}`);
}
