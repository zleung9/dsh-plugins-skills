#!/usr/bin/env node
// x-login.mjs — open X.com login in a VISIBLE Playwright Chromium window
// and wait until the user signs in (manually). Cookies persist in
// browser-profile/, so this is only needed on first run or after a session
// expiry. This is the RECOMMENDED, most reliable path: X.com's bot defenses
// (Arkose / device fingerprint) are far easier for a real human in a real
// browser window than for an automated form-filler.
//
// Usage: node scripts/x-login.mjs [--timeout-minutes 15] [--url https://x.com/login]
//
// Prints status lines to stdout, progress to stderr. Exit codes:
//   0 = LOGGED_IN (or ALREADY_LOGGED_IN)
//   1 = LOGIN_TIMEOUT
//   2 = launch/navigation error
import { launchX, isLoggedIn, waitFor, firstPage, X_LOGIN } from "./pw-common.mjs";

const argv = process.argv.slice(2);
function getArg(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const TIMEOUT_MS = parseInt(getArg("--timeout-minutes", "15"), 10) * 60 * 1000;
const START_URL = getArg("--url", X_LOGIN);

let ctx;
try {
  ctx = await launchX({ headed: true });
} catch (e) {
  console.error(`LAUNCH_ERROR: ${e.message}`);
  console.error("If Chromium is missing, run: npx playwright install chromium");
  process.exit(2);
}

let exitCode = 0;
try {
  const page = await firstPage(ctx);
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => {
    console.error(`navigation error: ${e.message}`);
  });

  if (await isLoggedIn(ctx)) {
    console.log("ALREADY_LOGGED_IN");
  } else {
    console.log("OPEN_BROWSER_WINDOW: please sign in to x.com now (Google / Apple / phone / email all work).");
    console.log(`Waiting up to ${Math.round(TIMEOUT_MS / 60000)} min for login...`);

    const ok = await waitFor(() => isLoggedIn(ctx), {
      timeoutMs: TIMEOUT_MS,
      intervalMs: 5000,
      onTick: (s) => {
        if (s % 30 === 0 && s > 0) process.stderr.write(`... still waiting (${s}s)\n`);
      },
    });

    if (ok) {
      // let X settle the session (ct0, guest tokens, home redirect)
      await new Promise((r) => setTimeout(r, 3000));
      console.log("LOGGED_IN");
    } else {
      console.error("LOGIN_TIMEOUT: no auth_token detected; the window is closed. Re-run when ready.");
      exitCode = 1;
    }
  }
} finally {
  await ctx.close();
}
process.exit(exitCode);
