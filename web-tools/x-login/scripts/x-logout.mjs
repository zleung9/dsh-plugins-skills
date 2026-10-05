#!/usr/bin/env node
// x-logout.mjs — clear the X.com login session from the persistent profile.
//
// Two modes:
//   --cookies   (default) delete x.com auth_token / ct0 / kdt cookies in-place.
//                Fast, keeps the profile. Next run will require re-login.
//   --purge     delete the whole browser-profile/ directory. Strongest reset.
//
// Usage: node scripts/x-logout.mjs [--cookies|--purge]
import { launchX, xCookies } from "./pw-common.mjs";
import { rmSync } from "node:fs";
import { X_PROFILE } from "./pw-common.mjs";

const argv = process.argv.slice(2);
const purge = argv.includes("--purge");

if (purge) {
  rmSync(X_PROFILE, { recursive: true, force: true });
  console.log(JSON.stringify({ mode: "purge", purged: true, path: X_PROFILE }));
  process.exit(0);
}

const ctx = await launchX({ headed: false });
try {
  const before = await xCookies(ctx);
  const names = ["auth_token", "ct0", "kdt", "twid", "auth_multi"];
  const toClear = before.filter((c) => names.includes(c.name));
  // Playwright cookie delete wants {name,domain,path}
  for (const c of toClear) {
    await ctx.clearCookies({ name: c.name, domain: c.domain, path: c.path });
  }
  const after = await xCookies(ctx);
  console.log(
    JSON.stringify({
      mode: "cookies",
      cleared: toClear.map((c) => c.name),
      remaining: after.map((c) => c.name),
    })
  );
  process.exit(0);
} finally {
  await ctx.close();
}
