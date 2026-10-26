import { chromium } from "playwright";
import fs from "node:fs";
const DIR = "/Users/zliang/Nutstore Files/pi-mail-archive/2026-09/2026-09-07-1910-C77EAB22-Re-X-AI-LLM-Agent-日报-2026-09-07/paper";
const ctx = await chromium.launchPersistentContext("/tmp/pw_hf_profile", { headless: true });
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const url = "https://pangram-public.s3.us-east-1.amazonaws.com/pdf/pangram_4_technical_report.pdf";
  const [resp, dl] = await Promise.all([
    page.goto(url, { waitUntil: "commit", timeout: 120000 }).catch(e => { console.log("goto err", e.message.slice(0,80)); return null; }),
    page.waitForEvent("download", { timeout: 120000 }),
  ]);
  await dl.saveAs(DIR + "/pangram4_report.pdf");
  console.log("saved");
} finally {
  await ctx.close();
}
