import { launchX } from "/Users/zliang/.pi/agent/skills/x-digest/scripts/pw-common.mjs";
import fs from "node:fs";

const DIR = "/Users/zliang/Nutstore Files/pi-mail-archive/2026-09/2026-09-07-1910-C77EAB22-Re-X-AI-LLM-Agent-日报-2026-09-07/paper";
const urls = [
  ["antling_announce", "https://x.com/AntLingAGI/status/2093022087069958492"],
  ["zainhas_pangram", "https://x.com/zainhas/status/2096517199871803742"],
];

const ctx = await launchX({ headed: false });
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  for (const [name, url] of urls) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); } catch (e) { console.log(name, "goto warn", e.message.slice(0,80)); }
    await page.waitForTimeout(5000);
    const data = await page.evaluate(() => {
      const arts = Array.from(document.querySelectorAll("article"));
      return arts.map(a => ({
        text: a.innerText,
        links: Array.from(a.querySelectorAll("a[href]")).map(x => x.href).filter(h => h.includes("/status/") || h.includes("http") && !h.startsWith("https://x.com/")).filter(h=>!h.startsWith("https://x.com/")).slice(0, 20),
      }));
    });
    fs.writeFileSync(`${DIR}/${name}.json`, JSON.stringify(data, null, 2));
    console.log(name, "articles:", data.length, "first len:", data[0] ? data[0].text.length : 0);
    await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
  }
} finally {
  await ctx.close();
}
