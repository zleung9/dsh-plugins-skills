// pw-common.mjs — shared Playwright helpers for x-digest.
//
// Uses a dedicated persistent Chromium profile at
// ~/email-assistant/browser-profiles/x-digest (OUTSIDE this skill dir, so it stays
// out of the Nutstore sync folder and is shared across agents). So:
//   - login cookies persist to disk across runs (no re-login needed)
//   - NO user extensions are ever loaded (the X.com "privacy extension"
//     error can't happen)
//   - no dependency on the user's Chrome or a CDP port (:9222)
//
// Only ONE process may hold the profile at a time (SingletonLock).
import { chromium } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";

// The profile is deliberately NOT inside the skill dir: it is a live Chrome
// user-data dir that would otherwise be uploaded by Nutstore on every run.
// Override the location with X_PROFILE_DIR if you need a different one.
export const X_PROFILE =
  process.env.X_PROFILE_DIR ||
  join(homedir(), "email-assistant", "browser-profiles", "x-digest");

/**
 * Launch the persistent X Chromium context.
 * @param {object} opts
 * @param {boolean} [opts.headed=true]  set false for headless (login requires headed)
 */
export async function launchX({ headed = true } = {}) {
  return chromium.launchPersistentContext(X_PROFILE, {
    headless: !headed,
    viewport: { width: 1380, height: 900 },
    locale: "zh-CN",
    // macOS: Chromium's base::GetTempDir() checks MAC_CHROMIUM_TMPDIR first,
    // then falls back to NSTemporaryDirectory() (= /var/folders/.../T).
    // Under the agent file sandbox, mkdtemp() there is denied, which made the
    // headed browser die at startup with "Failed to create socket directory"
    // (ProcessSingleton). /tmp is writable, so point Chromium at it.
    env: {
      ...process.env,
      MAC_CHROMIUM_TMPDIR: process.env.MAC_CHROMIUM_TMPDIR || "/tmp",
    },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
}

/** Return x.com cookies for the context. */
export async function xCookies(ctx) {
  return ctx.cookies("https://x.com");
}

/** True when the context has an X login (auth_token cookie). */
export async function isLoggedIn(ctx) {
  const cookies = await xCookies(ctx);
  return cookies.some((c) => c.name === "auth_token" && c.value);
}

/** Wait for a condition with a 5s poll. Returns true if it became true. */
export async function waitFor(fn, { timeoutMs = 300000, intervalMs = 5000, onTick = null } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    if (onTick) onTick(Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
