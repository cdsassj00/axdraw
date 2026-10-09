/**
 * Integration tests against the real Worker.
 *
 * The e2e suite runs on `vite preview`, which has no relay, no R2 and no
 * database, so everything that crosses the network — share links, live rooms,
 * cloud canvases — was only ever tested by hand. This runs the actual
 * worker/index.js under `wrangler dev` (local Durable Objects, R2, KV and D1,
 * fresh state every run) and drives several browser profiles against it: a
 * teacher, a student, and a second device of the same person.
 *
 *   npm run build && node tests/integration.mjs
 *
 * WRANGLER overrides the wrangler command (default: npx --yes wrangler@4).
 * PLAYWRIGHT_CHROMIUM points at a specific Chromium binary.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 8797);
// BASE_URL runs everything against a deployed site instead of wrangler dev.
// Cloud checks that need the database then only confirm the app copes with
// cloud storage not being switched on, unless CLOUD=1 says it is.
const LIVE = process.env.BASE_URL ?? null;
const BASE = LIVE ?? `http://localhost:${PORT}`;
const WRANGLER = (process.env.WRANGLER ?? "npx --yes wrangler@4").split(" ");

let passed = 0;
let failed = 0;
function check(name, ok, extra = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` :: ${extra}` : ""}`);
}

const work = mkdtempSync(join(tmpdir(), "axdraw-it-"));
const config = join(work, "wrangler.toml");
writeFileSync(
  config,
  `name = "axdraw-test"
main = "${join(ROOT, "worker/index.js")}"
compatibility_date = "2026-08-01"
[assets]
directory = "${join(ROOT, "dist")}"
binding = "ASSETS"
run_worker_first = ["/api/*"]
[[kv_namespaces]]
binding = "SCENES"
id = "test"
[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]
[[r2_buckets]]
binding = "ROOM_SCENES"
bucket_name = "axdraw-rooms"
[[d1_databases]]
binding = "DB"
database_name = "axdraw-db"
database_id = "00000000-0000-0000-0000-000000000000"
`,
);
const state = join(work, "state");

const server = LIVE
  ? null
  : spawn(
      WRANGLER[0],
      [...WRANGLER.slice(1), "dev", "-c", config, "--port", String(PORT), "--persist-to", state],
      { cwd: work, stdio: "ignore", detached: true },
    );

/** Runs SQL against the local D1 the Worker is using. */
function sql(command) {
  const out = execFileSync(
    WRANGLER[0],
    [...WRANGLER.slice(1), "d1", "execute", "axdraw-db", "-c", config, "--local", "--persist-to", state, "--json", "--command", command],
    { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out)[0].results;
}

async function waitForServer(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
    ...(LIVE && process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
    // CHROMIUM_ARGS: extra flags, e.g. trusting a proxy's CA by its key.
    args: ["--no-sandbox", ...(process.env.CHROMIUM_ARGS ?? "").split(" ").filter(Boolean)],
  });

  const errors = [];
  /** A browser profile: its own localStorage, i.e. its own person or device. */
  async function profile(name) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await context.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text) => void window.__copied.push(text) },
      });
    });
    const open = async (url = BASE) => {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForFunction(() => Boolean(window.axdraw));
      return page;
    };
    return { context, open };
  }

  const drag = async (page, from, to) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
    }
    await page.mouse.up();
  };
  const rect = async (page, from, to) => {
    await page.keyboard.press("r");
    await drag(page, from, to);
    await page.keyboard.press("Escape");
  };
  const live = (page) =>
    page.evaluate(() => window.axdraw.elements.filter((element) => !element.isDeleted).map((element) => element.id));
  const boards = (page) => page.evaluate(() => window.axdraw.listBoards());
  const currentName = (page) => page.evaluate(() => window.axdraw.currentBoardName());
  const lastCopied = (page) => page.evaluate(() => window.__copied[window.__copied.length - 1]);
  const onScreen = (page) =>
    page.evaluate(() => {
      const { zoom, scrollX, scrollY } = window.axdraw.state;
      const w = innerWidth / zoom;
      const h = innerHeight / zoom;
      return window.axdraw.elements.filter(
        (e) => !e.isDeleted && e.x + scrollX < w && e.x + e.width + scrollX > 0 && e.y + scrollY < h && e.y + e.height + scrollY > 0,
      ).length;
    });

  /* -------------------------------------------------- share links -- */

  const teacher = await profile("teacher");
  let tPage = await teacher.open();
  await rect(tPage, [300, 300], [420, 380]);
  await rect(tPage, [700, 500], [820, 580]);
  await tPage.click(".share-btn");
  await tPage.click(".share-snapshot");
  await tPage.waitForFunction(() => window.__copied.length > 0);
  const shareUrl = await lastCopied(tPage);
  await tPage.keyboard.press("Escape");
  check("the Share dialog copies a snapshot link", /#share=/.test(shareUrl ?? ""), shareUrl);

  const student = await profile("student");
  let sPage = await student.open();
  // The student's own work, far away where a share used to land on top of it.
  await sPage.evaluate(() => {
    window.axdraw.state.scrollX = -5000;
    window.axdraw.state.scrollY = -5000;
  });
  await rect(sPage, [300, 300], [400, 400]);
  const ownBoard = await sPage.evaluate(() => window.axdraw.currentBoardId());
  // Straight after it was made — the moment a class opens a link.
  await sPage.goto(shareUrl, { waitUntil: "networkidle" });
  await sPage.waitForFunction(() => window.axdraw.currentBoardName().startsWith("받은 그림"), null, { timeout: 10000 });
  check("a share link opens in a canvas of its own", (await currentName(sPage)).startsWith("받은 그림"), await currentName(sPage));
  check("the shared drawing is all there", (await live(sPage)).length === 2, `${(await live(sPage)).length} elements`);
  check("and on screen, not off in the distance", (await onScreen(sPage)) >= 1, `${await onScreen(sPage)} on screen`);
  const ownStill = await sPage.evaluate(
    (id) => JSON.parse(localStorage.getItem(`axdraw:scene:${id}`)).elements.filter((e) => !e.isDeleted).length,
    ownBoard,
  );
  check("the student's own canvas is untouched", ownStill === 1, `${ownStill} on their own canvas`);
  const boardsBefore = (await boards(sPage)).length;
  await sPage.evaluate((url) => (location.hash = new URL(url).hash), shareUrl);
  await sPage.waitForTimeout(800);
  check("opening the same link again reuses that canvas", (await boards(sPage)).length === boardsBefore, `${boardsBefore} -> ${(await boards(sPage)).length}`);

  /* -------------------------------------------------- live rooms -- */

  // SKIP_ROOMS: for networks that cannot carry WebSockets (some egress proxies).
  if (process.env.SKIP_ROOMS) console.log("  --  live rooms skipped (SKIP_ROOMS)");
  else {

  await tPage.click(".share-btn");
  await tPage.click(".share-live-start");
  await tPage.waitForFunction(() => window.__copied.some((text) => text.includes("#room=")));
  const roomUrl = await lastCopied(tPage);
  await tPage.keyboard.press("Escape");
  const roomId = /#room=([A-Za-z0-9]+)/.exec(roomUrl)[1];
  check("the Share dialog starts a live room", Boolean(roomId), roomUrl);
  check(
    "the room belongs to the teacher's canvas",
    (await tPage.evaluate(() => window.axdraw.listBoards().find((b) => b.id === window.axdraw.currentBoardId())?.room?.id)) === roomId,
  );
  const teacherBoards = (await boards(tPage)).length;
  await tPage.reload({ waitUntil: "networkidle" });
  await tPage.waitForFunction(() => Boolean(window.axdraw.collab), null, { timeout: 10000 });
  check(
    "reloading the owner's tab does not spawn a duplicate canvas",
    (await boards(tPage)).length === teacherBoards,
    `${teacherBoards} -> ${(await boards(tPage)).length}`,
  );
  await tPage.goto(BASE, { waitUntil: "networkidle" });
  await tPage.waitForFunction(() => Boolean(window.axdraw.collab), null, { timeout: 10000 });
  check(
    "coming back without the link reconnects the canvas to its room",
    (await tPage.evaluate(() => window.axdraw.collab?.id)) === roomId,
  );

  await sPage.goto(roomUrl, { waitUntil: "networkidle" });
  await sPage.waitForFunction(() => window.axdraw.elements.filter((e) => !e.isDeleted).length === 2, null, { timeout: 15000 });
  check("a student joining sees the teacher's drawing", (await live(sPage)).length === 2);

  // Erase one shape while the student is away; their browser keeps the old copy.
  const erased = (await live(tPage))[0];
  await sPage.waitForTimeout(1000); // let the student's copy reach their storage
  const staleCopy = await sPage.evaluate(
    () => JSON.parse(localStorage.getItem(`axdraw:scene:${window.axdraw.currentBoardId()}`)).elements.filter((e) => !e.isDeleted).length,
  );
  check("the student's browser holds a copy of the room", staleCopy === 2, `${staleCopy} stored`);
  await sPage.close();
  await tPage.evaluate((id) => {
    const app = window.axdraw;
    app.state.selectedIds = new Set([id]);
    app.deleteSelection();
  }, erased);
  await tPage.close({ runBeforeUnload: true }); // pagehide flushes the room save
  await new Promise((r) => setTimeout(r, 1500));

  sPage = await student.open(roomUrl);
  await sPage.waitForFunction(() => Boolean(window.axdraw.collab), null, { timeout: 10000 });
  await sPage.waitForTimeout(2500);
  check(
    "an erased shape stays erased for someone rejoining with an old copy",
    !(await live(sPage)).includes(erased),
    JSON.stringify(await live(sPage)),
  );
  const observer = await profile("observer");
  const oPage = await observer.open(roomUrl);
  await oPage.waitForTimeout(3000);
  check(
    "and the rejoin did not bring it back for anyone else",
    !(await live(oPage)).includes(erased) && (await live(oPage)).length === 1,
    JSON.stringify(await live(oPage)),
  );

  // A snapshot opened from inside a room must not leak into the room.
  await sPage.evaluate((url) => (location.hash = new URL(url).hash), shareUrl);
  await sPage.waitForTimeout(1500);
  check("a share link opened inside a room leaves the room", !(await sPage.evaluate(() => Boolean(window.axdraw.collab))));
  await oPage.waitForTimeout(1500);
  check("and nothing from it reaches the room", (await live(oPage)).length === 1, `${(await live(oPage)).length} in the room`);

  // Another room's link while in a room switches rooms instead of doing nothing.
  await oPage.evaluate(() => window.axdraw.newBoard());
  await oPage.evaluate(() => window.axdraw.startCollab());
  await oPage.waitForFunction(() => Boolean(window.axdraw.collab));
  const otherRoom = await oPage.evaluate(() => window.axdraw.collab.url);
  await sPage.evaluate((url) => (location.hash = new URL(url).hash), roomUrl);
  await sPage.waitForFunction((id) => window.axdraw.collab?.id === id, roomId, { timeout: 10000 });
  await sPage.evaluate((url) => (location.hash = new URL(url).hash), otherRoom);
  await sPage.waitForFunction((url) => window.axdraw.collab?.url === url, otherRoom, { timeout: 10000 }).catch(() => undefined);
  check(
    "pasting another room's link while in a room switches to it",
    (await sPage.evaluate(() => window.axdraw.collab?.url)) === otherRoom,
  );

  // A room in one tab, a new canvas in another tab of the same browser. The
  // open canvas used to be one value shared by all tabs: the room tab then
  // saved the room's drawing into the other tab's new canvas.
  const pupil = await profile("pupil");
  const roomTab = await pupil.open(otherRoom);
  await roomTab.waitForFunction(() => Boolean(window.axdraw.collab), null, { timeout: 10000 });
  const roomBoard = await roomTab.evaluate(() => window.axdraw.currentBoardId());
  const roomName = await roomTab.evaluate(() => window.axdraw.currentBoardName());
  const plainTab = await pupil.open();
  await plainTab.evaluate(() => window.axdraw.newBoard());
  const plainBoard = await plainTab.evaluate(() => window.axdraw.currentBoardId());
  await rect(oPage, [300, 300], [420, 380]); // someone draws in the room
  await roomTab.waitForFunction(() => window.axdraw.elements.some((e) => !e.isDeleted), null, { timeout: 10000 });
  await roomTab.waitForTimeout(800);
  const placed = await roomTab.evaluate(
    ([room, plain]) => {
      const live = (id) => JSON.parse(localStorage.getItem(`axdraw:scene:${id}`) || '{"elements":[]}').elements.filter((e) => !e.isDeleted).length;
      return {
        room: live(room),
        plain: live(plain),
        field: document.querySelector(".board-name-input").value,
        inRoom: window.axdraw.elements.filter((e) => !e.isDeleted).map((e) => `${e.type}@${Math.round(e.x)},${Math.round(e.y)}`),
      };
    },
    [roomBoard, plainBoard],
  );
  check(
    "a room's drawing stays in the room's canvas when another tab opens a new one",
    placed.room === 1 && placed.plain === 0 && placed.field === roomName,
    JSON.stringify(placed),
  );
  await roomTab.reload({ waitUntil: "networkidle" });
  await roomTab.waitForTimeout(1000);
  check(
    "and the room tab reloading does not rename the other tab's canvas",
    (await plainTab.$eval(".board-name-input", (node) => node.value)) !== roomName,
    await plainTab.$eval(".board-name-input", (node) => node.value),
  );


  // Leaving a room before its saved drawing has arrived — a slow phone, or a
  // quick "New canvas" right after opening the link. The download used to
  // finish anyway and pour the room's drawing into whatever canvas was open
  // by then, and broadcast it into that canvas's room.
  const hopper = await profile("hopper");
  const hopPage = await hopper.open();
  await hopPage.route(`**/api/rooms/${roomId}/scene`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await hopPage.evaluate((url) => (location.hash = new URL(url).hash), roomUrl);
  await hopPage.waitForFunction((id) => window.axdraw.collab?.id === id, roomId, { timeout: 10000 });
  await hopPage.evaluate(() => window.axdraw.newBoard());
  const fresh = await hopPage.evaluate(() => window.axdraw.currentBoardId());
  await hopPage.waitForTimeout(4000);
  const leaked = await hopPage.evaluate(
    (id) => ({
      onScreen: window.axdraw.elements.filter((e) => !e.isDeleted).length,
      stored: JSON.parse(localStorage.getItem(`axdraw:scene:${id}`) || '{"elements":[]}').elements.filter((e) => !e.isDeleted).length,
    }),
    fresh,
  );
  check(
    "a room left before its drawing arrives does not pour it into the next canvas",
    leaked.onScreen === 0 && leaked.stored === 0,
    JSON.stringify(leaked),
  );

  // "Bring everyone to my view": one press puts every participant's screen on
  // the area the presenter is looking at.
  const presenter = await profile("presenter");
  const pPage = await presenter.open();
  await pPage.evaluate(() => window.axdraw.startCollab());
  await pPage.waitForFunction(() => Boolean(window.axdraw.collab));
  const gatherUrl = await pPage.evaluate(() => window.axdraw.collab.url);
  const attendee = await profile("attendee");
  const aPage = await attendee.open(gatherUrl);
  await aPage.waitForFunction(() => Boolean(window.axdraw.collab), null, { timeout: 10000 });
  await aPage.waitForTimeout(800);
  await pPage.evaluate(() => {
    const app = window.axdraw;
    app.state.scrollX = -6000;
    app.state.scrollY = -4000;
    app.render();
  });
  await pPage.click(".share-btn");
  await pPage.click(".share-gather");
  await pPage.keyboard.press("Escape");
  await aPage.waitForTimeout(1500);
  const centres = await Promise.all(
    [pPage, aPage].map((pg) =>
      pg.evaluate(() => {
        const { zoom, scrollX, scrollY } = window.axdraw.state;
        return [innerWidth / 2 / zoom - scrollX, innerHeight / 2 / zoom - scrollY].map(Math.round);
      }),
    ),
  );
  check(
    "gathering moves a participant's view onto the presenter's",
    Math.abs(centres[0][0] - centres[1][0]) < 60 && Math.abs(centres[0][1] - centres[1][1]) < 60,
    JSON.stringify(centres),
  );

  // The sweep of empty canvases and dead room links.
  const tidy = await profile("tidy");
  const tPage2 = await tidy.open();
  const roomKey = /#room=[A-Za-z0-9]+,([A-Za-z0-9_-]+)/.exec(roomUrl)[1];
  await tPage2.evaluate(
    ({ roomId, roomKey }) => {
      const app = window.axdraw;
      app.newBoard(); // empty
      app.newBoard(); // empty, will be the one with work
    },
    { roomId, roomKey },
  );
  await rect(tPage2, [300, 300], [420, 380]);
  const workBoard = await tPage2.evaluate(() => window.axdraw.currentBoardId());
  await tPage2.evaluate(
    ({ roomId, roomKey }) => {
      // A room canvas whose copy here is empty, while the room has a drawing on
      // the server; a link to a room that has nothing; a link to the room with
      // a drawing but no canvas here.
      const boards = JSON.parse(localStorage.getItem("axdraw:boards"));
      boards.push({ id: "roomcopy", name: "협업 old", updated: Date.now(), room: { id: roomId, key: roomKey } });
      localStorage.setItem("axdraw:boards", JSON.stringify(boards));
      localStorage.setItem(
        "axdraw:rooms",
        JSON.stringify([
          { id: "deadroom00000001", key: "AAAAAAAAAAAAAAAAAAAAAA", name: "빈 방", visited: Date.now() },
          { id: roomId, key: roomKey, name: "그림 있는 방", visited: Date.now() },
        ]),
      );
      window.axdraw.newBoard(); // open on a blank canvas
    },
    { roomId, roomKey },
  );
  const removed = await tPage2.evaluate(() => window.axdraw.cleanupEmpty());
  const tidied = await tPage2.evaluate(() => ({
    boards: window.axdraw.listBoards().map((b) => b.id),
    rooms: JSON.parse(localStorage.getItem("axdraw:rooms")).map((r) => r.name),
    open: window.axdraw.currentBoardId(),
  }));
  check(
    "the sweep removes empty canvases and links to empty rooms",
    removed.canvases === 3 && removed.rooms === 1 && !tidied.rooms.includes("빈 방"),
    JSON.stringify({ removed, tidied }),
  );
  check(
    "and keeps the canvas with work, plus a room canvas whose drawing is on the server",
    tidied.boards.includes(workBoard) && tidied.boards.includes("roomcopy") && tidied.rooms.includes("그림 있는 방"),
    JSON.stringify(tidied),
  );
  check("and opens the canvas with work instead of a blank one", tidied.open === workBoard);

  // A room saved while scenes went to KV — before the R2 bucket existed.
  if (!LIVE) {
    const sealed = await tPage2.evaluate(async () => {
      const element = window.axdraw.elements.find((e) => !e.isDeleted);
      const keyBytes = crypto.getRandomValues(new Uint8Array(16));
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(JSON.stringify({ elements: [element], files: {} }));
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
      const body = new Uint8Array(iv.length + cipher.length);
      body.set(iv);
      body.set(cipher, iv.length);
      const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
      return { key: b64(keyBytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), body: b64(body) };
    });
    const kvRoom = "kvroom0000000001";
    const file = join(work, "kvscene.bin");
    writeFileSync(file, Buffer.from(sealed.body, "base64"));
    execFileSync(
      WRANGLER[0],
      [...WRANGLER.slice(1), "kv", "key", "put", `room:${kvRoom}`, "--path", file, "--binding", "SCENES", "--local", "--persist-to", state, "-c", config],
      { cwd: work, stdio: "ignore" },
    );
    const old = await profile("old-room");
    const oldPage = await old.open(`${BASE}/#room=${kvRoom},${sealed.key}`);
    await oldPage.waitForFunction(() => window.axdraw.elements.some((e) => !e.isDeleted), null, { timeout: 15000 }).catch(() => undefined);
    check("a room saved before the move to R2 still opens with its drawing", (await live(oldPage)).length === 1);
  }
  }

  /* -------------------------------------------------- cloud -- */

  if (LIVE && process.env.CLOUD !== "1") {
    const visitor = await profile("visitor");
    const vPage = await visitor.open();
    await rect(vPage, [300, 300], [420, 380]);
    check("the cloud chip offers cloud saving", (await vPage.getAttribute(".cloud-chip", "data-state")) === "off");
    await vPage.click(".cloud-chip");
    await vPage.fill(".cloud-email", "e2e-check@example.com");
    await vPage.check(".consent-privacy");
    await vPage.click(".cloud-submit");
    await vPage.waitForFunction(() => (document.querySelector(".cloud-error")?.textContent ?? "").length > 0, null, { timeout: 15000 });
    check(
      "before the database exists, signing up says so plainly",
      /not switched on/.test((await vPage.textContent(".cloud-error")) ?? ""),
      await vPage.textContent(".cloud-error"),
    );
    check("and leaves nothing half-registered", await vPage.evaluate(() => !localStorage.getItem("axdraw:cloud")));
    check("the drawing is untouched", (await live(vPage)).length === 1);
    check("no page errors", errors.length === 0, errors.join(" | "));
    throw "done";
  }

  // What the server holds, read back through the API with the browser's own
  // credentials — works against a deployed site, where the database cannot
  // be queried directly.
  const cloudApi = (page, path, account) =>
    page.evaluate(
      async ({ path, account }) => {
        const acct = account ?? JSON.parse(localStorage.getItem("axdraw:cloud"));
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`axdraw-cloud-auth:${acct.secret}`));
        let binary = "";
        for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
        const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const response = await fetch(path, { headers: { authorization: `Bearer ${acct.workspace}.${token}` } });
        return { status: response.status, body: await response.json().catch(() => null), account: acct };
      },
      { path, account },
    );
  // A throwaway address on a live site; the run deletes it again at the end.
  const testEmail = LIVE ? `e2e-check+${Date.now()}@example.com` : "teacher@example.com";

  const PASSWORD = "class-2026!";
  /** Sign up through the window a person uses: the chip, then "create an account". */
  const signup = async (page, email, { consent = true, marketing = true } = {}) => {
    await page.click(".cloud-chip");
    await page.click(".cloud-swap");
    await page.fill(".cloud-email", email);
    await page.fill(".cloud-password", PASSWORD);
    await page.fill(".cloud-password-confirm", PASSWORD);
    if (consent) await page.check(".consent-privacy");
    if (marketing) await page.check(".consent-marketing");
    await page.click(".cloud-submit");
  };
  const login = async (page, email, password = PASSWORD) => {
    await page.click(".cloud-chip");
    await page.fill(".cloud-email", email);
    await page.fill(".cloud-password", password);
    await page.click(".cloud-submit");
  };
  const chipState = (page) => page.getAttribute(".cloud-chip", "data-state");

  const laptop = await profile("laptop");
  const lPage = await laptop.open();
  await rect(lPage, [300, 300], [420, 380]);
  check("the cloud chip starts at 'log in'", (await chipState(lPage)) === "off");
  await signup(lPage, LIVE ? testEmail : "Teacher@Example.com", { consent: false });
  await lPage.waitForFunction(() => (document.querySelector(".cloud-error")?.textContent ?? "").length > 0);
  check(
    "the required consent cannot be skipped",
    await lPage.evaluate(() => !localStorage.getItem("axdraw:cloud")),
    await lPage.textContent(".cloud-error"),
  );
  await lPage.check(".consent-privacy");
  await lPage.check(".consent-marketing");
  await lPage.click(".cloud-submit");
  await lPage.waitForFunction(() => document.querySelector(".cloud-chip")?.dataset.state === "saved", null, { timeout: 20000 });
  check("signing up switches saving to the account on", true);
  if (LIVE) {
    const account = await cloudApi(lPage, "/api/cloud/account");
    check(
      "the email and both consents are recorded",
      account.status === 200 && account.body.email === testEmail && account.body.marketing === true,
      JSON.stringify(account.body),
    );
  } else {
    const lead = sql("SELECT email, marketing_consent, consent_version FROM leads");
    const accounts = sql("SELECT email, length(pw_hash) AS hash FROM accounts");
    check(
      "the email and both consents are recorded",
      lead.length === 1 && lead[0].email === "teacher@example.com" && lead[0].marketing_consent === 1,
      JSON.stringify(lead),
    );
    check(
      "the password is stored only as a hash",
      accounts.length === 1 && accounts[0].hash === 64 && !JSON.stringify(sql("SELECT * FROM accounts")).includes(PASSWORD),
      JSON.stringify(accounts),
    );
  }

  await lPage.evaluate(() => window.axdraw.newBoard());
  await rect(lPage, [500, 400], [620, 480]);
  const listStored = async () =>
    LIVE ? (await cloudApi(lPage, "/api/cloud/canvases")).body.canvases : sql("SELECT id, name, size FROM canvases");
  let stored = await listStored();
  // Saves trail edits by a couple of seconds, more against a real deployment.
  for (let deadline = Date.now() + 15000; stored.length < 2 && Date.now() < deadline; ) {
    await lPage.waitForTimeout(1000);
    stored = await listStored();
  }
  check("every canvas is saved to the account", stored.length === 2, `${stored.length} canvases`);
  check("canvas names reach the server encrypted", stored.every((row) => !/캔버스/.test(row.name)), stored.map((r) => r.name.slice(0, 12)).join(","));

  // Another device: nothing but the email and password.
  const tablet = await profile("tablet");
  const tabPage = await tablet.open();
  await login(tabPage, LIVE ? testEmail : "teacher@example.com", "wrong-password");
  await tabPage.waitForFunction(() => (document.querySelector(".cloud-error")?.textContent ?? "").length > 0, null, { timeout: 15000 });
  check("a wrong password is refused", /Wrong email or password/.test(await tabPage.textContent(".cloud-error")), await tabPage.textContent(".cloud-error"));
  await tabPage.fill(".cloud-password", PASSWORD);
  await tabPage.click(".cloud-submit");
  await tabPage.waitForFunction(() => window.axdraw.elements.some((e) => !e.isDeleted), null, { timeout: 20000 });
  check(
    "logging in on another device lists the account's canvases",
    (await boards(tabPage)).filter((b) => b.cloudSynced || b.remote).length >= 2,
    JSON.stringify((await boards(tabPage)).map((b) => b.name)),
  );
  check("and opens one with its drawing", (await live(tabPage)).length === 1);

  // Both devices edit the same canvas without seeing each other's save.
  const shared = await tabPage.evaluate(() => window.axdraw.currentBoardId());
  await lPage.evaluate((id) => window.axdraw.openBoard(id), shared);
  await lPage.waitForTimeout(800);
  await rect(tabPage, [300, 550], [380, 620]);
  await tabPage.waitForTimeout(3500);
  await rect(lPage, [700, 550], [780, 620]);
  // The laptop's save meets the tablet's, merges, and saves again: a few
  // round trips, slower against a real deployment than a local Worker. The
  // tablet sees it the next time it opens the canvas, so reopen until it
  // does — bounded, so a merge that never lands still fails.
  const reopenUntil = async (want, deadline = Date.now() + 20000) => {
    for (;;) {
      await tabPage.waitForTimeout(2000);
      await tabPage.evaluate(() => {
        const app = window.axdraw;
        const here = app.currentBoardId();
        const other = app.listBoards().find((b) => b.id !== here).id;
        app.openBoard(other);
        app.openBoard(here);
      });
      await tabPage.waitForTimeout(1500);
      if ((await live(tabPage)).length === want || Date.now() > deadline) return;
    }
  };
  await reopenUntil(3);
  const laptopView = (await live(lPage)).length;
  const tabletView = (await live(tabPage)).length;
  check(
    "edits from two devices to one canvas are both kept",
    laptopView === 3 && tabletView === 3,
    `laptop ${laptopView}, tablet ${tabletView}`,
  );

  // Log out on the tablet — a shared classroom computer.
  await tabPage.click(".cloud-chip");
  await tabPage.click(".cloud-logout");
  await tabPage.waitForFunction(() => document.querySelector(".cloud-chip")?.dataset.state === "off", null, { timeout: 15000 });
  const afterLogout = await tabPage.evaluate(() => ({
    left: window.axdraw.listBoards().filter((b) => b.cloudSynced || b.remote).length,
    onScreen: window.axdraw.elements.filter((e) => !e.isDeleted).length,
    account: localStorage.getItem("axdraw:cloud"),
  }));
  check(
    "logging out removes the account's canvases from that device",
    afterLogout.left === 0 && afterLogout.onScreen === 0 && afterLogout.account === null,
    JSON.stringify(afterLogout),
  );
  const stillStored = (await listStored()).length;
  check("and they stay in the account", stillStored === 2, `${stillStored} in the account`);

  await lPage.click(".cloud-chip");
  await lPage.waitForFunction(() => !document.querySelector(".consent-marketing")?.disabled);
  await lPage.uncheck(".consent-marketing");
  await lPage.waitForTimeout(800);
  if (LIVE) {
    const account = await cloudApi(lPage, "/api/cloud/account");
    check("the newsletter consent can be withdrawn", account.body?.marketing === false, JSON.stringify(account.body));
  } else {
    const lead = sql("SELECT marketing_consent FROM leads");
    check("the newsletter consent can be withdrawn", lead[0]?.marketing_consent === 0, JSON.stringify(lead));
  }
  const credentials = (await cloudApi(lPage, "/api/cloud/canvases")).account;

  lPage.once("dialog", (dialog) => void dialog.accept());
  await lPage.click(".danger-btn");
  await lPage.waitForTimeout(1500);
  if (LIVE) {
    // The account is gone, so its old credentials no longer open anything.
    const after = await cloudApi(lPage, "/api/cloud/canvases", credentials);
    check("deleting the account removes the email and every canvas", after.status === 401, `status ${after.status}`);
  } else {
    const left = sql(
      "SELECT (SELECT count(*) FROM leads) AS leads, (SELECT count(*) FROM workspaces) AS workspaces, (SELECT count(*) FROM canvases) AS canvases, (SELECT count(*) FROM accounts) AS accounts",
    );
    check(
      "deleting the account removes the email and every canvas",
      left[0].leads === 0 && left[0].workspaces === 0 && left[0].canvases === 0 && left[0].accounts === 0,
      JSON.stringify(left[0]),
    );
  }
  check("and this browser keeps its own copies", (await boards(lPage)).length >= 2);

  // Someone who saved with the earlier email-only cloud keeps those canvases
  // when they create an account.
  if (!LIVE) {
    const veteran = await profile("veteran");
    const vetPage = await veteran.open();
    await rect(vetPage, [300, 300], [420, 380]);
    await vetPage.evaluate(() => window.axdraw.enableCloud("veteran@example.com", { privacy: true, marketing: false }));
    await vetPage.waitForTimeout(3500);
    const before = await vetPage.evaluate(() => JSON.parse(localStorage.getItem("axdraw:cloud")).workspace);
    // Their account window offers to choose a password, email filled in.
    await vetPage.click(".cloud-chip");
    await vetPage.click(".cloud-make-account");
    check("an email-only saver is offered a password", (await vetPage.inputValue(".cloud-email")) === "veteran@example.com");
    await vetPage.fill(".cloud-password", PASSWORD);
    await vetPage.fill(".cloud-password-confirm", PASSWORD);
    await vetPage.check(".consent-privacy");
    await vetPage.click(".cloud-submit");
    await vetPage.waitForFunction(() => document.querySelector(".cloud-chip")?.dataset.state === "saved", null, { timeout: 20000 });
    const after = await vetPage.evaluate(() => JSON.parse(localStorage.getItem("axdraw:cloud")).workspace);
    const phone = await profile("veteran-phone");
    const phonePage = await phone.open();
    await login(phonePage, "veteran@example.com");
    await phonePage.waitForFunction(() => window.axdraw.elements.some((e) => !e.isDeleted), null, { timeout: 20000 });
    check(
      "an account created over earlier cloud saving keeps those canvases",
      before === after && (await live(phonePage)).length === 1,
      `${before} -> ${after}`,
    );
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  if (error !== "done") {
    failed++;
    console.error(error);
  }
} finally {
  await browser?.close();
  try {
    if (server) process.kill(-server.pid);
  } catch {
    // Already gone.
  }
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
