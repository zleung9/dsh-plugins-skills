import { chromium } from "playwright";
import fs from "node:fs";

const DIR = "/Users/zliang/Nutstore Files/pi-mail-archive/2026-09/2026-09-07-1910-C77EAB22-Re-X-AI-LLM-Agent-日报-2026-09-07/paper";
const jobs = [
  ["https://huggingface.co/datasets/inclusionAI/FinFIRST/resolve/main/assets/overall-results.png", "finfirst_overall.png"],
  ["https://huggingface.co/datasets/inclusionAI/FinFIRST/resolve/main/assets/unsupported-correct-rate.png", "finfirst_ucr.png"],
  ["https://huggingface.co/datasets/inclusionAI/FinFIRST/resolve/main/assets/slice-analysis.png", "finfirst_slice.png"],
  ["https://huggingface.co/datasets/inclusionAI/FinFIRST/resolve/main/assets/benchmark-comparison.png", "finfirst_compare.png"],
  ["https://huggingface.co/inclusionAI/Ling-3.0-flash-Fin/raw/master/README.md", "ling_readme_master.md"],
];
const ctx = await chromium.launchPersistentContext("/tmp/pw_hf_profile", { headless: true, args: ["--disable-blink-features=AutomationControlled"] });
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  for (const [url, out] of jobs) {
    try {
      const resp = await page.goto(url, { waitUntil: "load", timeout: 60000 });
      const st = resp && resp.status();
      if (out.endsWith(".png")) {
        const buf = await resp.body().catch(() => null);
        if (buf && st === 200) { fs.writeFileSync(`${DIR}/${out}`, buf); console.log(out, st, buf.length); }
        else console.log(out, st, "no body");
      } else {
        await page.waitForTimeout(800);
        const t = await page.evaluate(() => (document.body ? document.body.innerText : ""));
        fs.writeFileSync(`${DIR}/${out}`, t);
        console.log(out, st, t.length);
      }
    } catch (e) {
      console.log(out, "ERR", e.message.slice(0, 120));
    }
  }
} finally {
  await ctx.close();
}
