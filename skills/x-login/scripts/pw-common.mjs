// pw-common.mjs — shared Playwright helpers for the x-login skill.
//
// Uses a DEDICATED persistent Chromium profile (browser-profile/) so:
//   - login cookies persist to disk across runs (re-login only on expiry)
//   - NO user extensions are ever loaded (avoids X.com's
//     "Something went wrong … privacy related extensions" bootstrap error)
//   - no dependency on the user's Chrome or a CDP port (:9222)
//
// Anti-bot: X.com returns HTTP 403 / blank page to a vanilla headless
// Chromium. We pass --disable-blink-features=AutomationControlled (hides
// navigator.webdriver) plus a realistic locale/viewport. A persistent
// profile that has been logged in once is treated as a returning user.
//
// Only ONE process may hold the profile at a time (SingletonLock).
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const X_PROFILE = join(SKILL_DIR, "browser-profile");
export const X_HOME = "https://x.com";
export const X_LOGIN = "https://x.com/login";

/**
 * Launch the persistent X Chromium context.
 * @param {object} opts
 * @param {boolean} [opts.headed=true]  set false for headless (login itself requires headed)
 * @param {number} [opts.timeout=60000] default navigation timeout (ms)
 */
export async function launchX({ headed = true, timeout = 60000 } = {}) {
  const ctx = await chromium.launchPersistentContext(X_PROFILE, {
    headless: !headed,
    viewport: { width: 1380, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  ctx.setDefaultTimeout(timeout);
  return ctx;
}

/** Return x.com cookies for the context. */
export async function xCookies(ctx) {
  return ctx.cookies("https://x.com");
}

/** True when the context has an X login (auth_token cookie present & non-empty). */
export async function isLoggedIn(ctx) {
  const cookies = await xCookies(ctx);
  return cookies.some((c) => c.name === "auth_token" && c.value);
}

/**
 * Wait for a condition to become true, polling on an interval.
 * @returns {Promise<boolean>} true if it became true before the timeout.
 */
export async function waitFor(fn, { timeoutMs = 300000, intervalMs = 5000, onTick = null } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    if (onTick) onTick(Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** First page of the context, creating one if needed. */
export async function firstPage(ctx) {
  return ctx.pages()[0] || (await ctx.newPage());
}
