/**
 * The recovery page reads Chrome's own localStorage files (LevelDB) and finds
 * a canvas as it was before a smaller copy overwrote it — in the write-ahead
 * log and after Chrome compacts it into a snappy-compressed table — then puts
 * it back into axdraw as a new canvas.
 *
 *   npm run build && node tests/recover-leveldb.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const server = spawn("npx", ["vite", "preview", "--port", "4181"], { stdio: "ignore", detached: true });
const BASE = "http://localhost:4181";
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
const dir = mkdtempSync(join(tmpdir(), "prof-"));
let ctx = await chromium.launchPersistentContext(dir, { ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}), args: ["--no-sandbox"] });
let page = await ctx.newPage();
await page.goto(BASE + "/recover.html");
await page.evaluate(() => {
  const el = (i) => ({ id: "e" + i, type: "rectangle", x: i * 10, y: 0, width: 50, height: 40, version: 2, updated: Date.now() - 86400000, isDeleted: false });
  const txt = { id: "t1", type: "text", text: "윈도우 운영체제 실습", x: 0, y: 0, width: 100, height: 20, version: 1, updated: Date.now() - 86400000, isDeleted: false };
  localStorage.setItem("axdraw:boards", JSON.stringify([{ id: "mois", name: "행정안전부 블루특화과정", updated: 1 }]));
  localStorage.setItem("axdraw:scene:mois", JSON.stringify({ version: 2, elements: [txt, ...Array.from({ length: 180 }, (_, i) => el(i))], files: {} }));
});
await page.waitForTimeout(8000);
// later: overwritten by a small copy
await page.evaluate(() => {
  localStorage.setItem("axdraw:scene:mois", JSON.stringify({ version: 2, elements: [{ id: "n1", type: "rectangle", x: 0, y: 0, width: 5, height: 5, version: 1, updated: Date.now(), isDeleted: false }], files: {} }));
});
for (let round = 0; round < 6; round++) {
  await page.evaluate((round) => { for (let i = 0; i < 20; i++) localStorage.setItem("pad" + i, String(round) + "y".repeat(60000)); }, round);
  await page.waitForTimeout(2500);
}
await ctx.close();
// Reopening converts the log into a compressed table file (.ldb).
ctx = await chromium.launchPersistentContext(dir, { ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}), args: ["--no-sandbox"] });
page = await ctx.newPage();
await page.goto(BASE + "/recover.html");
await page.evaluate(() => localStorage.setItem("touch", "1"));
await page.waitForTimeout(4000);
await ctx.close();
const ldb = join(dir, "Default", "Local Storage", "leveldb");
const items = readdirSync(ldb).map((name) => ({ name, bytes: [...readFileSync(join(ldb, name))] }));

console.log("files", items.map((i) => `${i.name}:${i.bytes.length}`).join(" "));
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}), args: ["--no-sandbox"] });
const p2 = await browser.newPage();
await p2.goto(BASE + "/recover.html");
await p2.evaluate((items) => window.__scanBuffers(items), items);
console.log(JSON.stringify(await p2.evaluate(() => window.__found())));
console.log(await p2.textContent("#status"));
await p2.click(".result >> nth=0 >> button.primary");
await p2.waitForSelector(".done");
await p2.goto(BASE + "/");
await p2.waitForFunction(() => Boolean(window.axdraw));
const imported = await p2.evaluate(() => {
  const b = window.axdraw.listBoards().find((x) => x.name.includes("복구"));
  if (!b) return null;
  window.axdraw.openBoard(b.id);
  return { name: b.name, shapes: window.axdraw.elements.filter((e) => !e.isDeleted).length };
});
console.log("imported", JSON.stringify(imported));
const ok = imported && imported.shapes === 181;
console.log(ok ? "  ok  an overwritten canvas is recovered from Chrome's LevelDB files" : "FAIL  recovery from LevelDB");
process.exitCode = ok ? 0 : 1;
await browser.close(); process.kill(-server.pid);
