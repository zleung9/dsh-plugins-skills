#!/usr/bin/env node
// x-status.mjs — quick check whether the Playwright profile has a valid X login.
//
// Usage: node scripts/x-status.mjs [--headed]
//   prints JSON: { loggedIn, hasAuthToken, cookieCount, url, httpStatus }
//   exit 0 when logged in, 1 otherwise.
//
// Runs HEADLESS by default. It actually navigates to x.com/home (not just
// reads cookies) so the result reflects whether the session is *accepted*
// by X right now, not merely whether an auth_token cookie exists on disk.
import { launchX, isLoggedIn, xCookies, X_HOME, firstPage } from "./pw-common.mjs";

const argv = process.argv.slice(2);
const headed = argv.includes("--headed");

const ctx = await launchX({ headed });
let url = "";
let httpStatus = null;
try {
  const page = await firstPage(ctx);
  const resp = await page.goto(`${X_HOME}/home`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => {
    console.error(`navigation error: ${e.message}`);
    return null;
  });
  httpStatus = resp ? resp.status() : null;
  url = page.url();
  // small settle for SPA redirect after login check
  await page.waitForTimeout(2500).catch(() => {});
  const cookies = await xCookies(ctx);
  const loggedIn = await isLoggedIn(ctx);
  console.log(
    JSON.stringify({ loggedIn, hasAuthToken: cookies.some((c) => c.name === "auth_token" && c.value), cookieCount: cookies.length, url, httpStatus })
  );
  process.exit(loggedIn ? 0 : 1);
} finally {
  await ctx.close();
}
