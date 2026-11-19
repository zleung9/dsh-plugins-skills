#!/usr/bin/env node
/**
 * branch_session.mjs — move a pi session's leaf back to an earlier entry and
 * append a `mail-branch` marker entry (child of that entry).
 *
 * poll_inbox.py uses this when a new email In-Reply-To's an EARLIER email of
 * the thread (not the most recent one). After this runs, the marker entry is
 * the last line of the session file, so `pi -p --session <file>` naturally
 * continues from the branch point. History is untouched — the /tree view in
 * the pi TUI shows a real branch.
 *
 * Usage:  branch_session.mjs <sessionFile> <targetEntryId> <repliesToMid>
 * Exit:   0 ok (prints JSON), 2 usage / entry not found, 1 other
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [sessionFile, targetId, repliesTo] = process.argv.slice(2);
if (!sessionFile || !targetId || !repliesTo) {
  console.error("usage: branch_session.mjs <sessionFile> <targetEntryId> <repliesToMid>");
  process.exit(2);
}

// Locate the installed pi package (ESM entry) via the pi binary symlink.
let binPath;
try {
  binPath = execFileSync("/bin/sh", ["-c", "readlink -f \"$(command -v pi)\""], { encoding: "utf8" }).trim();
} catch (e) {
  console.error(`cannot resolve pi binary: ${e.message}`);
  process.exit(1);
}
// <pkgRoot>/dist/bundle/cli.js -> <pkgRoot>/dist/index.js
const pkgRoot = binPath.replace(/\/dist\/bundle\/cli\.js$/, "");
if (!pkgRoot || pkgRoot === binPath) {
  console.error(`cannot locate pi package from ${binPath}`);
  process.exit(1);
}
const { SessionManager } = await import(pathToFileURL(`${pkgRoot}/dist/index.js`).href);

let sm;
try {
  sm = SessionManager.open(sessionFile);
} catch (e) {
  console.error(`cannot open session: ${e.message}`);
  process.exit(1);
}
if (!sm.getEntry(targetId)) {
  console.error(`entry ${targetId} not found in ${sessionFile}`);
  process.exit(2);
}
sm.branch(targetId);
const markerId = sm.appendCustomEntry("mail-branch", {
  repliesTo: repliesTo,
  at: new Date().toISOString(),
});
console.log(JSON.stringify({ ok: true, branchAt: targetId, markerEntry: markerId, leaf: sm.getLeafId() }));
