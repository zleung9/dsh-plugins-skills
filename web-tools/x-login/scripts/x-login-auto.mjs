#!/usr/bin/env node
// x-login-auto.mjs — attempt AUTOMATED username/password login to X.com.
//
// ⚠️  X.com employs aggressive bot defenses (Arkose Labs challenge, device
// fingerprinting). Automated form-fill frequently triggers a CAPTCHA or a
// "Verify your identity" step that a script cannot solve. This script:
//   1. opens a VISIBLE window (so you can take over if a challenge appears),
//   2. fills username → clicks Next → fills password → clicks "Log in",
//   3. waits for auth_token OR a challenge, printing what it sees,
//   4. if a challenge appears, it keeps the window open for the human to
//      finish, polling for up to --timeout-minutes.
//
// Credentials are read from env vars, NEVER hardcoded:
//   X_USER  — username / phone / email
//   X_PASS  — password
//
// Usage:
//   X_USER=you X_PASS=secret node scripts/x-login-auto.mjs [--timeout-minutes 15]
//
// Exit codes: 0 = logged in; 1 = timeout / challenge not solved; 2 = error.
import { launchX, isLoggedIn, waitFor, firstPage, X_LOGIN } from "./pw-common.mjs";

const argv = process.argv.slice(2);
function getArg(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const TIMEOUT_MS = parseInt(getArg("--timeout-minutes", "15"), 10) * 60 * 1000;

const USER = process.env.X_USER;
const PASS = process.env.X_PASS;
if (!USER || !PASS) {
  console.error("MISSING_CREDENTIALS: set X_USER and X_PASS env vars.");
  console.error("Example: X_USER=you X_PASS='secret' node scripts/x-login-auto.mjs");
  process.exit(2);
}

let ctx;
try {
  ctx = await launchX({ headed: true });
} catch (e) {
  console.error(`LAUNCH_ERROR: ${e.message}`);
  process.exit(2);
}

function log(s) {
  console.log(`[x-login-auto] ${s}`);
}
function detectState(text, url) {
  const t = (text || "").toLowerCase();
  const u = (url || "").toLowerCase();
  if (u.includes("/home") || u.includes("/compose") || /home$/.test(u)) return "home";
  if (t.includes("verify your identity") || t.includes("verify it's you") || t.includes("enter the code")) return "challenge_verify";
  if (t.includes("phone or email") || t.includes("username") && t.includes("password") === false) return "ask_user";
  if (t.includes("password")) return "ask_pass";
  if (t.includes("suspicious") || t.includes("something went wrong") || t.includes("try again")) return "blocked";
  return "unknown";
}

let exitCode = 0;
try {
  const page = await firstPage(ctx);
  log(`navigating to ${X_LOGIN} ...`);
  await page.goto(X_LOGIN, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => log(`nav error: ${e.message}`));
  // X's login is a SPA that redirects to /i/jf/onboarding/web?mode=login and
  // renders the form asynchronously. Wait for the network to settle, then
  // explicitly wait for the username input to appear.
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000).catch(() => {});

  if (await isLoggedIn(ctx)) {
    log("ALREADY_LOGGED_IN");
    process.exit(0);
  }

  // --- Fill username + password on the same form ---------------------------
  // Real DOM (zh-CN locale): a single form with
  //   <input name="username_or_email" autocomplete="username webauthn">
  //   <input type="password" name="password">
  //   button "继续" / "Next" / "Log in"
  // The inputs are rendered twice (responsive dupes); a single-selector
  // locator + .first() is more stable than a multi-selector union here.
  const userLocator = page.locator('input[name="username_or_email"]').first();
  log("filling username ...");
  let haveUser = false;
  try {
    await userLocator.waitFor({ state: "visible", timeout: 25000 });
    // fill() focuses & clears automatically; avoid click() which can stall on
    // actionability when a cookie banner overlays the input.
    await userLocator.fill(USER, { delay: 70, timeout: 10000 });
    await page.waitForTimeout(500);
    haveUser = true;
  } catch {
    log("could not find/fill username input — handing off to human");
  }

  log("filling password ...");
  const passLocator = page.locator('input[type="password"]').first();
  let havePass = false;
  try {
    await passLocator.waitFor({ state: "visible", timeout: 15000 });
    await passLocator.fill(PASS, { delay: 70, timeout: 10000 });
    await page.waitForTimeout(400);
    havePass = true;
  } catch {
    log("no password field visible yet — will try to submit username first");
  }

  // Submit. Button label is locale-dependent: "继续"(zh) / "Next"(en) / "Log in".
  const submitBtn =
    (await page.getByRole("button", { name: /^继续$/ }).first().isVisible().catch(() => false))
      ? page.getByRole("button", { name: /^继续$/ }).first()
      : (await page.getByRole("button", { name: /^Next$/i }).first().isVisible().catch(() => false))
        ? page.getByRole("button", { name: /^Next$/i }).first()
        : (await page.getByRole("button", { name: /^Log in$/i }).first().isVisible().catch(() => false))
          ? page.getByRole("button", { name: /^Log in$/i }).first()
          : null;
  if (submitBtn) {
    await submitBtn.click();
    log("clicked submit (继续/Next/Log in)");
  } else if (havePass) {
    await passLocator.press("Enter");
    log("pressed Enter to submit");
  } else {
    log("no submit button found — handing off to human");
  }
  await page.waitForTimeout(3000);

  // X may then show a follow-up: a password-only step OR a "verify your
  // username/phone" step. Handle the password-only follow-up.
  const passOnly = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  const stillOnLogin = /\/login/.test(page.url());
  if (passOnly && stillOnLogin && !(await isLoggedIn(ctx))) {
    log("password-only follow-up step detected — filling password again");
    await page.locator('input[type="password"]').first().fill(PASS, { delay: 70, timeout: 10000 });
    await page.waitForTimeout(400);
    const btn2 =
      (await page.getByRole("button", { name: /^Log in$/i }).first().isVisible().catch(() => false))
        ? page.getByRole("button", { name: /^Log in$/i }).first()
        : (await page.getByRole("button", { name: /^继续$/ }).first().isVisible().catch(() => false))
          ? page.getByRole("button", { name: /^继续$/ }).first()
          : null;
    if (btn2) { await btn2.click(); log("clicked submit (follow-up)"); }
    else { await page.locator('input[type="password"]').first().press("Enter"); log("pressed Enter (follow-up)"); }
    await page.waitForTimeout(3000);
  }

  // Username/phone verification follow-up ("Enter your phone number or username")
  const verifyInput = await page
    .locator('input[name="text"], input[data-testid="ocfEnterTextTextInput"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (verifyInput && stillOnLogin && !(await isLoggedIn(ctx))) {
    log("username-verify step detected — filling username");
    await page.locator('input[name="text"], input[data-testid="ocfEnterTextTextInput"]').first().fill(USER, { delay: 70 });
    const vbtn =
      (await page.getByRole("button", { name: /^Next$/i }).first().isVisible().catch(() => false))
        ? page.getByRole("button", { name: /^Next$/i }).first()
        : page.getByRole("button", { name: /^继续$/ }).first();
    if (vbtn) { await vbtn.click(); log("clicked Next (verify)"); }
    await page.waitForTimeout(3000);
  }

  // --- Step 3: wait for outcome --------------------------------------------
  await page.waitForTimeout(4000);
  const state = detectState(await page.evaluate(() => document.body && document.body.innerText.slice(0, 800)), page.url());
  log(`post-login state: ${state} (url=${page.url()})`);

  if (await isLoggedIn(ctx)) {
    await new Promise((r) => setTimeout(r, 2000));
    log("LOGGED_IN");
    process.exit(0);
  }

  if (state === "home") {
    await new Promise((r) => setTimeout(r, 3000));
    if (await isLoggedIn(ctx)) {
      log("LOGGED_IN");
      process.exit(0);
    }
  }

  // challenge / verify / blocked → keep window open for the human
  log(`CHALLENGE_OR_WAIT: state=${state}. Keeping the browser window open.`);
  log(`Polling for login for up to ${Math.round(TIMEOUT_MS / 60000)} min — please complete any challenge in the window.`);

  const ok = await waitFor(() => isLoggedIn(ctx), {
    timeoutMs: TIMEOUT_MS,
    intervalMs: 5000,
    onTick: (s) => {
      if (s % 30 === 0 && s > 0) process.stderr.write(`... still waiting (${s}s)\n`);
    },
  });

  if (ok) {
    await new Promise((r) => setTimeout(r, 2000));
    log("LOGGED_IN (after manual challenge)");
    exitCode = 0;
  } else {
    log("LOGIN_TIMEOUT");
    exitCode = 1;
  }
} catch (e) {
  console.error(`ERROR: ${e.stack || e.message}`);
  exitCode = 2;
} finally {
  await ctx.close();
}
process.exit(exitCode);
