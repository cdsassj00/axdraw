/**
 * End-to-end smoke tests.
 *
 * Builds nothing on its own — run `npm run build` first (or use `npm run
 * test:e2e`, which does it for you). The script starts `vite preview`, drives
 * the editor with real pointer/keyboard input, and asserts on the resulting
 * scene. Set PLAYWRIGHT_CHROMIUM to point at a specific Chromium binary.
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 4173);
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? null;

let passed = 0;
let failed = 0;

function check(name, ok, extra = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` :: ${extra}` : ""}`);
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not start on ${url}`);
}

const server = spawn("npx", ["vite", "preview", "--port", String(PORT)], {
  stdio: "ignore",
  detached: true,
});

let browser;
try {
  await waitForServer(BASE);

  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    // Web fonts come from CDNs; the test sandbox is offline and the app is
    // built to degrade to fallback stacks, so those load failures are noise.
    const url = message.location()?.url ?? "";
    if (/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|googletagmanager/.test(url)) return;
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  /** Canvas coordinates below y=110 / left of x=240 are covered by the UI. */
  const drag = async (from, to, steps = 12) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        from[0] + ((to[0] - from[0]) * i) / steps,
        from[1] + ((to[1] - from[1]) * i) / steps,
      );
    }
    await page.mouse.up();
  };

  const scene = () =>
    page.evaluate(() => {
      const app = window.axdraw;
      const elements = app.elements.filter((element) => !element.isDeleted);
      return {
        n: elements.length,
        types: elements.map((element) => element.type),
        selected: app.state.selectedIds.size,
        last: elements[elements.length - 1] ?? null,
      };
    });

  const resetView = () =>
    page.evaluate(() => {
      const app = window.axdraw;
      app.clearCanvas();
      app.state.zoom = 1;
      app.state.scrollX = 0;
      app.state.scrollY = 0;
      app.render();
    });

  const sketch = async (points) => {
    await page.keyboard.press("p");
    await page.mouse.move(points[0][0], points[0][1]);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point[0], point[1], { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(60);
    return page.evaluate(() => {
      const element = window.axdraw.elements.filter((item) => !item.isDeleted).pop();
      return {
        type: element.type,
        points: element.points ? element.points.length : 0,
        angle: Number(element.angle.toFixed(2)),
      };
    });
  };

  /* ---------------- drawing & transforms ---------------- */

  await page.keyboard.press("r");
  await drag([420, 200], [620, 320]);
  let state = await scene();
  check("rectangle tool draws a rectangle", state.n === 1 && state.types[0] === "rectangle");

  await page.mouse.click(420, 200);
  check("clicking the outline selects it", (await scene()).selected === 1);

  await drag([620, 320], [680, 380]);
  state = await scene();
  check("south-east handle resizes", state.last.width > 240 && state.last.height > 160);

  const angleBefore = (await scene()).last.angle;
  await drag([550, 180], [640, 220]);
  check("rotation handle rotates", Math.abs((await scene()).last.angle - angleBefore) > 0.1);
  await page.keyboard.press("Control+z");

  /* ---------------- arrows & binding ---------------- */

  await resetView();
  await page.keyboard.press("r");
  await drag([300, 300], [440, 400]);
  await page.keyboard.press("o");
  await drag([700, 300], [840, 400]);
  await page.keyboard.press("a");
  await drag([445, 350], [695, 350]);

  const binding = await page.evaluate(() => {
    const arrow = window.axdraw.elements.find((element) => element.type === "arrow");
    return { start: !!arrow.startBinding, end: !!arrow.endBinding };
  });
  check("an arrow binds to the shapes at both ends", binding.start && binding.end, JSON.stringify(binding));

  await page.keyboard.press("v");
  await page.mouse.click(770, 300);
  await drag([770, 300], [770, 200]);
  const tipY = await page.evaluate(() => {
    const arrow = window.axdraw.elements.find((element) => element.type === "arrow");
    return Math.round(arrow.y + arrow.points[arrow.points.length - 1][1]);
  });
  check("a bound arrow follows the shape it points at", tipY < 340, `tip y = ${tipY}`);

  /* ---------------- text ---------------- */

  await page.mouse.dblclick(370, 350);
  await page.keyboard.type("라벨");
  await page.keyboard.press("Escape");
  const label = await page.evaluate(() => {
    const text = window.axdraw.elements.find((element) => element.type === "text");
    const container = window.axdraw.elements.find((element) => element.id === text?.containerId);
    return {
      text: text?.text,
      centred: text && container
        ? Math.abs(text.x + text.width / 2 - (container.x + container.width / 2)) < 1
        : false,
      linked: !!container?.boundElements?.some((bound) => bound.type === "text" && bound.id === text.id),
    };
  });
  check("double-click labels a shape", label.text === "라벨" && label.linked && label.centred, JSON.stringify(label));

  /* ---------------- multi-point lines ---------------- */

  await page.keyboard.press("l");
  // Keep clear of the right-side properties panel (x ≥ ~1060).
  await page.mouse.click(700, 500);
  await page.mouse.click(800, 560);
  await page.mouse.click(900, 480);
  await page.keyboard.press("Enter");
  const linePoints = await page.evaluate(() => {
    const line = window.axdraw.elements.filter((element) => element.type === "line").pop();
    return line ? line.points.length : 0;
  });
  check("click-click-Enter draws a multi-point line", linePoints === 3, `points = ${linePoints}`);

  /* ---------------- eraser, clipboard, groups ---------------- */

  const beforeErase = (await scene()).n;
  await page.keyboard.press("e");
  await drag([300, 300], [440, 300], 20);
  check("the eraser deletes what it touches", (await scene()).n < beforeErase);
  await page.keyboard.press("Control+z");
  check("undo brings erased elements back", (await scene()).n === beforeErase);

  await page.keyboard.press("v");
  await page.keyboard.press("Control+a");
  const beforeCopy = (await scene()).n;
  await page.evaluate(() => {
    window.axdraw.copySelection();
    window.axdraw.pasteFromClipboard();
  });
  await page.waitForTimeout(120);
  check("copy and paste duplicates the selection", (await scene()).n === beforeCopy * 2);
  await page.keyboard.press("Control+z");

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+g");
  check(
    "grouping tags the selection",
    (await page.evaluate(() => window.axdraw.elements.filter((element) => element.groupIds.length).length)) > 1,
  );
  await page.keyboard.press("Control+Shift+g");
  check(
    "ungrouping clears the tags",
    (await page.evaluate(() => window.axdraw.elements.filter((element) => element.groupIds.length).length)) === 0,
  );

  /* ---------------- shape recognition ---------------- */

  // Assist ships off by default (the pen stays freehand); these tests cover
  // the recognition path, so switch it on.
  await page.evaluate(() => {
    window.axdraw.state.shapeRecognition = true;
  });
  await resetView();
  let result = await sketch([[400, 150], [500, 153], [600, 149], [700, 152]]);
  check("a rough stroke becomes a straight line", result.type === "line" && result.points === 2, JSON.stringify(result));

  result = await sketch([[400, 220], [520, 222], [640, 219], [700, 221], [672, 205], [700, 221], [674, 236]]);
  check("a shaft with a head becomes an arrow", result.type === "arrow", JSON.stringify(result));

  result = await sketch([[500, 300], [430, 420], [575, 418], [502, 303]]);
  check("three corners become a triangle", result.type === "line" && result.points >= 4, JSON.stringify(result));

  result = await sketch([[800, 300], [870, 360], [802, 422], [733, 361], [799, 303]]);
  check("a rough diamond becomes a diamond", result.type === "diamond", JSON.stringify(result));

  result = await sketch([[950, 300], [1060, 340], [1030, 420], [920, 378], [948, 303]]);
  check("a tilted box keeps its angle", result.type === "rectangle" && Math.abs(result.angle) > 0.1, JSON.stringify(result));

  result = await sketch([[400, 500], [440, 540], [410, 560], [470, 520], [430, 590], [500, 540], [460, 600], [520, 560]]);
  check("a scribble stays freehand", result.type === "freedraw", JSON.stringify(result));

  await page.evaluate(() => {
    window.axdraw.state.shapeRecognition = false;
  });
  result = await sketch([[700, 500], [800, 505], [805, 590], [702, 588], [699, 503]]);
  check("shape assist can be turned off", result.type === "freedraw", JSON.stringify(result));
  await page.evaluate(() => {
    window.axdraw.state.shapeRecognition = true;
  });

  /* ---------------- persistence ---------------- */

  const beforeReload = (await scene()).n;
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  check("the scene survives a reload", (await scene()).n === beforeReload);

  /* ---------------- export ---------------- */

  const svg = await page.evaluate(() => {
    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let captured = null;
    URL.createObjectURL = (blob) => {
      captured = blob;
      return originalCreate.call(URL, blob);
    };
    HTMLAnchorElement.prototype.click = function () {};
    window.axdraw.exportSvg({});
    HTMLAnchorElement.prototype.click = originalClick;
    URL.createObjectURL = originalCreate;
    return captured ? captured.text() : null;
  });
  check("SVG export is well formed", !!svg && svg.startsWith("<?xml") && svg.includes("</svg>"));
  const svgParsed = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    return { error: !!doc.querySelector("parsererror"), paths: doc.querySelectorAll("path").length };
  }, svg ?? "");
  check("SVG export parses and contains geometry", !svgParsed.error && svgParsed.paths > 0, JSON.stringify(svgParsed));

  const png = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    void canvas;
    const blob = await new Promise((resolve) => {
      const app = window.axdraw;
      const originalCreate = URL.createObjectURL;
      const originalClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (value) => {
        resolve(value);
        return originalCreate.call(URL, value);
      };
      HTMLAnchorElement.prototype.click = function () {};
      void app.exportPng({ scale: 1 }).then(() => {
        HTMLAnchorElement.prototype.click = originalClick;
        URL.createObjectURL = originalCreate;
      });
    });
    return { type: blob.type, size: blob.size };
  });
  check("PNG export produces an image", png.type === "image/png" && png.size > 1000, JSON.stringify(png));

  /* ---------------- scene file round trip ---------------- */

  const roundTrip = await page.evaluate(async () => {
    const app = window.axdraw;
    const before = app.elements.filter((element) => !element.isDeleted).length;
    const json = JSON.stringify({
      type: "axdraw",
      version: 1,
      source: "test",
      elements: app.elements.filter((element) => !element.isDeleted),
      appState: {},
      files: app.files,
    });
    await app.loadFromFile(new Blob([json], { type: "application/json" }));
    return { before, after: app.elements.filter((element) => !element.isDeleted).length };
  });
  check("a saved scene file loads back", roundTrip.before === roundTrip.after, JSON.stringify(roundTrip));

  /* ---------------- images ---------------- */

  const image = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const context = canvas.getContext("2d");
    context.fillStyle = "#1971c2";
    context.fillRect(0, 0, 120, 80);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await window.axdraw.addImage(blob, { x: 200, y: 200 });
    const element = window.axdraw.elements.find((item) => item.type === "image");
    return element ? { fileId: !!element.fileId, hasFile: !!window.axdraw.files[element.fileId] } : null;
  });
  check("images can be added to the scene", !!image?.fileId && image.hasFile, JSON.stringify(image));

  /* ---------------- snapping ---------------- */

  await resetView();
  await page.keyboard.press("r");
  await drag([400, 200], [520, 280]);
  await page.keyboard.press("r");
  await drag([700, 400], [820, 480]);
  await page.keyboard.press("v");
  await page.mouse.click(730, 400);
  await drag([730, 400], [733, 205], 20);
  const snapped = await page.evaluate(() => {
    const elements = window.axdraw.elements.filter((element) => !element.isDeleted);
    return { a: Math.round(elements[0].y), b: Math.round(elements[1].y) };
  });
  check("object snapping aligns edges", snapped.a === snapped.b, JSON.stringify(snapped));

  // Regression: Enter and Escape were the only ways out of multi-point mode.
  // Clicking again just extended the line, so a user trying to finish kept
  // adding segments — which is how a "straight line" ends up a long wandering
  // curve. The second click of a double-click lands on the point the first one
  // placed, and that now ends the line.
  await resetView();
  await page.keyboard.press("l");
  await page.mouse.click(400, 500);
  await page.mouse.click(550, 560);
  await page.mouse.click(700, 470);
  await page.mouse.dblclick(700, 470);
  await page.waitForTimeout(120);
  const afterDouble = await page.evaluate(() => {
    const line = window.axdraw.elements.filter((element) => !element.isDeleted).pop();
    return { type: line?.type, points: line?.points?.length ?? 0 };
  });
  // Moving away would extend the line if it were still being placed.
  await page.mouse.move(950, 650);
  await page.waitForTimeout(120);
  const settled = await page.evaluate(() => {
    const line = window.axdraw.elements.filter((element) => !element.isDeleted).pop();
    return line?.points?.length ?? 0;
  });
  check(
    "double-click finishes a multi-point line",
    afterDouble.type === "line" && afterDouble.points === 3 && settled === afterDouble.points,
    JSON.stringify({ ...afterDouble, settled }),
  );

  /* ---------------- canvas naming ---------------- */

  const nameField = ".board-name-input";
  const originalName = await page.$eval(nameField, (node) => node.value);
  await page.click(nameField);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("강의 1주차");
  // Tool shortcuts live on window; typing in the name must not reach them.
  const toolWhileTyping = await page.evaluate(() => window.axdraw.state.tool);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  const renamed = await page.evaluate(() => ({
    name: window.axdraw.currentBoardName(),
    stored: JSON.parse(localStorage.getItem("axdraw:boards") || "[]").map((board) => board.name),
  }));
  check(
    "the canvas can be renamed in place and is saved",
    renamed.name === "강의 1주차" && renamed.stored.includes("강의 1주차") && toolWhileTyping !== "line",
    JSON.stringify({ ...renamed, toolWhileTyping }),
  );

  await page.click(nameField);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("   ");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  check(
    "a blank canvas name is rejected",
    (await page.evaluate(() => window.axdraw.currentBoardName())) === "강의 1주차",
    await page.evaluate(() => window.axdraw.currentBoardName()),
  );

  await page.click(nameField);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("버리는 이름");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  check(
    "Escape abandons a name edit",
    (await page.evaluate(() => window.axdraw.currentBoardName())) === "강의 1주차",
    await page.evaluate(() => window.axdraw.currentBoardName()),
  );
  await page.evaluate(
    (name) => window.axdraw.renameBoard(window.axdraw.currentBoardId(), name),
    originalName,
  );


  /* ---------------- command palette ---------------- */

  await resetView();
  await page.keyboard.press("r");
  await drag([320, 260], [520, 400]);
  await page.keyboard.press("v");
  await page.mouse.click(320, 260);

  // Wait on the palette actually being open rather than a fixed delay: if the
  // next keystrokes land while it is still closed they hit the canvas as tool
  // shortcuts, which corrupts every test after this one.
  const openPalette = async () => {
    await page.keyboard.press("Control+k");
    await page.waitForFunction(
      () => {
        const backdrop = document.querySelector(".cp-backdrop");
        return !!backdrop && !backdrop.hidden && document.activeElement?.classList.contains("cp-input");
      },
      { timeout: 5000 },
    );
  };
  const closedPalette = () =>
    page.waitForFunction(
      () => {
        const backdrop = document.querySelector(".cp-backdrop");
        return !backdrop || backdrop.hidden;
      },
      { timeout: 5000 },
    );

  await openPalette();
  const paletteOpen = await page.evaluate(() => document.querySelectorAll(".cp-row").length > 0);
  check("Ctrl+K opens the command palette", paletteOpen);

  await page.keyboard.type("png");
  await page.waitForTimeout(120);
  const pngResults = await page.evaluate(() =>
    [...document.querySelectorAll(".cp-row .cp-label")].map((node) => node.textContent),
  );
  check(
    "the palette filters as you type",
    pngResults.length === 1 && pngResults[0].includes("PNG"),
    JSON.stringify(pngResults),
  );

  // Korean and English labels both match, so either language finds the row.
  await page.keyboard.press("Control+a");
  await page.keyboard.type("마름모");
  await page.waitForTimeout(120);
  const koResults = await page.evaluate(() =>
    // The primary label is localised; the Korean name sits in whichever of
    // the two spans the locale didn't claim, so check both.
    [...document.querySelectorAll(".cp-row .cp-label, .cp-row .cp-sub")].map((node) => node.textContent),
  );
  check("the palette matches Korean labels", koResults.includes("마름모"), JSON.stringify(koResults));

  await page.keyboard.press("Control+a");
  await page.keyboard.type("dark");
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
  await closedPalette();
  const afterEnter = await page.evaluate(() => document.documentElement.dataset.theme);
  check("Enter runs the highlighted command and closes", afterEnter === "dark", String(afterEnter));

  await page.evaluate(() => window.axdraw.setTheme("light"));

  // Reopening after running a command only works if focus went back to the
  // canvas. While the dismissed input still holds focus the app treats every
  // keystroke as typing and no shortcut fires at all.
  await openPalette();
  await page.keyboard.press("Escape");
  await closedPalette();
  const focusReturned = await page.evaluate(
    () => !document.activeElement?.classList.contains("cp-input"),
  );
  check("closing the palette returns focus to the canvas", focusReturned);

  await page.keyboard.press("o");
  const toolAfterClose = await page.evaluate(() => window.axdraw.state.tool);
  check("shortcuts still work after using the palette", toolAfterClose === "ellipse", toolAfterClose);

  /* ---------------- recognition chip ---------------- */

  await resetView();
  await page.keyboard.press("p");
  {
    const cx = 420;
    const cy = 330;
    const r = 95;
    await page.mouse.move(cx + r, cy);
    await page.mouse.down();
    for (let a = 0; a <= Math.PI * 2 + 0.15; a += 0.14) {
      const w = r + Math.sin(a * 5) * 4;
      await page.mouse.move(cx + Math.cos(a) * w, cy + Math.sin(a) * w * 0.92);
    }
    await page.mouse.up();
  }
  await page.waitForTimeout(250);

  const chipState = () =>
    page.evaluate(() => {
      const chip = document.querySelector(".ax-recognition-chip");
      const element = window.axdraw.elements.filter((item) => !item.isDeleted).at(-1);
      return {
        visible: !!chip && !chip.hidden,
        active: chip?.querySelector(".chip-option.active")?.textContent ?? null,
        type: element?.type,
      };
    });

  const afterSketch = await chipState();
  check(
    "a recognised stroke offers alternates",
    afterSketch.visible && afterSketch.type === "ellipse",
    JSON.stringify(afterSketch),
  );

  await page.click(".ax-recognition-chip .chip-option:nth-child(3)");
  await page.waitForTimeout(150);
  const asDiamond = await chipState();
  check(
    "picking an alternate reshapes the element",
    asDiamond.type === "diamond" && asDiamond.active === "마름모",
    JSON.stringify(asDiamond),
  );

  await page.click(".ax-recognition-chip .chip-option:nth-child(4)");
  await page.waitForTimeout(150);
  const asFreehand = await chipState();
  check(
    "the original freehand stroke stays reachable",
    asFreehand.type === "freedraw",
    JSON.stringify(asFreehand),
  );

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  const afterUndo = await page.evaluate(
    () => window.axdraw.elements.filter((item) => !item.isDeleted).at(-1)?.type,
  );
  check("undo walks back through the choices", afterUndo === "diamond", String(afterUndo));

  await page.mouse.click(820, 620);
  await page.waitForTimeout(150);
  const dismissed = await page.evaluate(() => {
    const chip = document.querySelector(".ax-recognition-chip");
    return !chip || chip.hidden;
  });
  check("the next canvas action dismisses the chip", dismissed);

  /* ---------------- resize cursors ---------------- */

  // Regression: the cursor was computed on hover but only written to the DOM
  // during a render. Approaching a handle across empty canvas schedules no
  // render, so the resize cursor never appeared. Each case below parks the
  // pointer far away first, so the only thing that can set the cursor is the
  // move onto the handle itself.
  await resetView();
  await page.keyboard.press("r");
  await drag([300, 250], [500, 400]);
  await page.keyboard.press("v");
  await page.mouse.click(300, 250);

  const cursorAt = async (x, y) => {
    await page.mouse.move(760, 640);
    await page.mouse.move(x, y, { steps: 3 });
    await page.waitForTimeout(60);
    return page.evaluate(() => document.getElementById("root").style.cursor);
  };

  const handleCursors = [
    ["nw", 300, 250, "nwse-resize"],
    ["ne", 500, 250, "nesw-resize"],
    ["sw", 300, 400, "nesw-resize"],
    ["se", 500, 400, "nwse-resize"],
    ["n", 400, 250, "ns-resize"],
    ["s", 400, 400, "ns-resize"],
    ["w", 300, 325, "ew-resize"],
    ["e", 500, 325, "ew-resize"],
  ];
  const wrongCursors = [];
  for (const [name, x, y, want] of handleCursors) {
    const got = await cursorAt(x, y);
    if (got !== want) wrongCursors.push(`${name}: ${got} != ${want}`);
  }
  check(
    "every transform handle shows its resize cursor",
    wrongCursors.length === 0,
    wrongCursors.join(", ") || `${handleCursors.length} handles`,
  );

  // The grab area has to be wider than the drawn handle, or the cursor only
  // appears when the pointer is dead centre on an 8px square.
  const nearMiss = await cursorAt(510, 410);
  check("the handle grab area extends past the drawn handle", nearMiss === "nwse-resize", nearMiss);

  const offHandle = await cursorAt(560, 460);
  check("the resize cursor clears away from the handle", offHandle !== "nwse-resize", offHandle);

  /* ---------------- every button ---------------- */

  // Clicks every visible control in the chrome and checks the app survives it.
  // This is a crash net, not a behaviour check: the point is that no button
  // throws, wedges the UI, or leaves a modal that swallows the next click.
  // A rebuild-during-blur crash in the canvas-name field is exactly the kind of
  // thing that passed every targeted test and broke the moment a real user
  // clicked something else.

  // Anything that would leave the page or hit the network is stubbed, so a
  // failure here means the app broke, not that the sandbox is offline.
  await page.route("**/*", (route) => {
    const url = route.request().url();
    // The share API is same-origin but has no server behind `vite preview`, so
    // it 404s and that lands in the console as an error the app did not cause.
    if (/\/api\//.test(url)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "e2e-stub" }),
      });
    }
    if (url.startsWith(BASE)) return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
  page.on("filechooser", (chooser) => void chooser.setFiles([]).catch(() => {}));

  const buttonInventory = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".ax-ui button")]
        .filter((node) => node.offsetWidth || node.offsetHeight)
        .map((node, index) => ({
          index,
          id:
            (node.getAttribute("title") || node.getAttribute("aria-label") || node.textContent || "")
              .trim()
              .slice(0, 40) || `(button ${index})`,
        })),
    );

  /** Put the editor back in a known state between clicks. */
  const settle = async () => {
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => {
      // Close anything modal that a button opened, without relying on each
      // dialog honouring Escape.
      for (const node of document.querySelectorAll(".modal-backdrop, .cp-backdrop, .menu, .popover")) {
        if (node.classList.contains("cp-backdrop")) node.hidden = true;
        else node.remove();
      }
    });
    await page.waitForTimeout(35);
  };

  const clickEveryButton = async (label, prepare) => {
    const broken = [];
    const inventory = await prepare();
    for (const entry of inventory) {
      const before = errors.length;
      const clicked = await page.evaluate((index) => {
        const nodes = [...document.querySelectorAll(".ax-ui button")].filter(
          (node) => node.offsetWidth || node.offsetHeight,
        );
        const node = nodes[index];
        if (!node) return false;
        node.click();
        return true;
      }, entry.index);
      if (!clicked) continue;
      await page.waitForTimeout(45);
      // Still alive? A wedged app fails this before it fails anything else.
      const alive = await page
        .evaluate(() => {
          window.axdraw.render();
          return typeof window.axdraw.currentBoardId() === "string";
        })
        .catch(() => false);
      const newErrors = errors.slice(before);
      if (!alive || newErrors.length) {
        broken.push(`${entry.id}${newErrors.length ? ` → ${newErrors[0].slice(0, 70)}` : " → wedged"}`);
      }
      await settle();
      await prepare();
    }
    check(`every ${label} button survives a click`, broken.length === 0, broken.join(" | ") || `${inventory.length} buttons`);
  };

  await resetView();
  await clickEveryButton("idle", async () => {
    await page.keyboard.press("v").catch(() => {});
    return buttonInventory();
  });

  await clickEveryButton("selection-panel", async () => {
    await page.evaluate(() => {
      const app = window.axdraw;
      if (app.elements.filter((element) => !element.isDeleted).length < 2) {
        app.clearCanvas();
      }
    });
    if ((await scene()).n < 2) {
      await page.keyboard.press("r");
      await drag([500, 300], [650, 420]);
      await page.keyboard.press("r");
      await drag([760, 300], [900, 420]);
    }
    await page.keyboard.press("v");
    await page.keyboard.press("Control+a");
    await page.waitForTimeout(35);
    return buttonInventory();
  });

  await page.unroute("**/*");
  await resetView();

  /* ---------------- view options ---------------- */

  await page.keyboard.press("Control+'");
  check("the grid toggles", await page.evaluate(() => window.axdraw.state.gridEnabled));
  await page.keyboard.press("Control+'");

  await page.evaluate(() => window.axdraw.setTheme("dark"));
  check("dark theme applies", await page.evaluate(() => document.documentElement.dataset.theme === "dark"));
  if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/dark.png` });
  await page.evaluate(() => window.axdraw.setTheme("light"));

  await page.keyboard.press("Shift+1");
  const zoom = await page.evaluate(() => window.axdraw.state.zoom);
  check("zoom to fit picks a sane zoom", zoom > 0.1 && zoom <= 1.5, `zoom = ${zoom.toFixed(2)}`);

  if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/final.png` });

  check("no console or page errors", errors.length === 0, errors.join(" | "));

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid);
  } catch {
    // Already gone.
  }
}

process.exit(failed === 0 ? 0 : 1);
