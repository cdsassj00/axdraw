/**
 * The editor chrome: toolbar, style panel, menus, zoom controls and stats.
 *
 * The UI is rebuilt from `app.state` whenever the app notifies a change, which
 * keeps it in sync without any bespoke diffing.
 */

import type { App } from "../app";
import {
  BACKGROUND_COLORS,
  CANVAS_COLORS,
  EXTENDED_PALETTE,
  FONT_SIZES,
  ROUGHNESS,
  STROKE_COLORS,
} from "../constants";
import type { Arrowhead, AxElement, FontFamily, ItemStyle, ToolType } from "../types";
import { openConfirmDialog, openExportDialog, openHelpDialog, showToast } from "./dialogs";
import { COFFEE_URL, CREDIT_LABEL, CREDIT_URL } from "../constants";
import { openTemplateDialog } from "./templates";
import { button, dismissable, h } from "./dom";
import { iconEl } from "./icons";
import { createCommandPalette } from "./commandPalette";
import { createRecognitionChip } from "./recognitionChip";

interface ToolDefinition {
  tool: ToolType;
  icon: string;
  label: string;
  shortcut: string;
}

const TOOLS: ToolDefinition[] = [
  { tool: "hand", icon: "hand", label: "Hand (pan)", shortcut: "H" },
  { tool: "selection", icon: "selection", label: "Selection", shortcut: "1" },
  { tool: "rectangle", icon: "rectangle", label: "Rectangle", shortcut: "2" },
  { tool: "diamond", icon: "diamond", label: "Diamond", shortcut: "3" },
  { tool: "ellipse", icon: "ellipse", label: "Ellipse", shortcut: "4" },
  { tool: "arrow", icon: "arrow", label: "Arrow", shortcut: "5" },
  { tool: "line", icon: "line", label: "Line", shortcut: "6" },
  { tool: "freedraw", icon: "freedraw", label: "Draw", shortcut: "7" },
  { tool: "text", icon: "text", label: "Text", shortcut: "8" },
  { tool: "image", icon: "image", label: "Image", shortcut: "9" },
  { tool: "eraser", icon: "eraser", label: "Eraser", shortcut: "0" },
  { tool: "frame", icon: "frame", label: "Frame", shortcut: "F" },
  { tool: "laser", icon: "laser", label: "Laser pointer", shortcut: "K" },
];

const SHAPE_TOOLS = new Set<ToolType>(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "frame"]);

export function createUI(app: App): void {
  const root = h("div", { class: "ax-ui" });
  app.container.appendChild(root);

  const topLeft = h("div", { class: "top-left" });
  const toolbar = h("div", { class: "toolbar island" });
  const topRight = h("div", { class: "top-right" });
  const bottomLeft = h("div", { class: "bottom-left" });
  const bottomRight = h("div", { class: "bottom-right" });
  const panel = h("div", { class: "panel island" });
  const welcome = h("div", { class: "welcome" });

  root.append(topLeft, toolbar, topRight, bottomLeft, bottomRight, panel, welcome);

  const credit = h("div", { class: "credit" });
  const creditLink = document.createElement("a");
  creditLink.href = CREDIT_URL;
  creditLink.target = "_blank";
  creditLink.rel = "noopener";
  creditLink.textContent = CREDIT_LABEL;
  credit.appendChild(creditLink);
  if (COFFEE_URL) {
    const coffee = document.createElement("a");
    coffee.href = COFFEE_URL;
    coffee.target = "_blank";
    coffee.rel = "noopener";
    coffee.textContent = "☕ Buy me a coffee";
    credit.appendChild(coffee);
  }
  bottomRight.appendChild(credit);

  createRecognitionChip(app, root);
  app.onToggleCommandPalette = createCommandPalette(app, root);

  let sliderActive = false;
  window.addEventListener("pointerup", () => {
    if (sliderActive) {
      sliderActive = false;
      render();
    }
  });

  app.onError = (message) => showToast(root, message);
  app.onMessage = (message) => showToast(root, message);
  app.onContextMenu = (_, clientX, clientY) => openContextMenu(app, root, clientX, clientY, render);

  /* ---------------------------------------------------------------- *
   * Toolbar
   * ---------------------------------------------------------------- */

  function renderToolbar(): void {
    toolbar.replaceChildren();
    toolbar.append(
      button({
        icon: iconEl(app.state.toolLocked ? "lock" : "unlock"),
        title: `Keep selected tool active after drawing — Q`,
        active: app.state.toolLocked,
        onClick: () => {
          app.state.toolLocked = !app.state.toolLocked;
          render();
        },
      }),
      h("div", { class: "separator" }),
    );

    for (const definition of TOOLS) {
      toolbar.append(
        button({
          icon: iconEl(definition.icon),
          title: `${definition.label} — ${definition.shortcut}`,
          shortcut: definition.shortcut,
          active: app.state.tool === definition.tool,
          onClick: () => {
            app.setTool(definition.tool);
          },
        }),
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Corner islands
   * ---------------------------------------------------------------- */

  function renderCorners(): void {
    topLeft.replaceChildren(
      h("div", { class: "island", style: { display: "flex", alignItems: "center", gap: "4px", padding: "6px" } }, [
        button({
          icon: iconEl("menu"),
          title: "Menu",
          onClick: (event) => {
            event.stopPropagation();
            openMainMenu(app, root, topLeft, render);
          },
        }),
        h("span", { class: "brand", text: "axdraw" }),
      ]),
      h("div", { class: "island", style: { padding: "6px" } }, [
        button({
          icon: iconEl("template"),
          label: "템플릿",
          className: "btn--wide",
          title: "Insert a diagram template",
          onClick: () => openTemplateDialog(app),
        }),
      ]),
    );

    topRight.replaceChildren(
      h("button", {
        class: "primary-btn share-btn",
        type: "button",
        text: "공유",
        title: "Copy an encrypted share link",
        onclick: () => void app.shareLink(),
      }),
      h("div", { class: "island", style: { display: "flex", gap: "2px", padding: "6px" } }, [
        button({
          icon: iconEl("wand"),
          title: `Shape assist — turn rough sketches into clean shapes (${app.state.shapeRecognition ? "on" : "off"})`,
          active: app.state.shapeRecognition,
          onClick: () => {
            app.state.shapeRecognition = !app.state.shapeRecognition;
            showToast(root, app.state.shapeRecognition ? "Shape assist on" : "Shape assist off");
            render();
          },
        }),
        button({
          icon: iconEl("grid"),
          title: "Show grid — Ctrl+'",
          active: app.state.gridEnabled,
          onClick: () => app.toggleGrid(),
        }),
        button({
          icon: iconEl(app.state.theme === "dark" ? "sun" : "moon"),
          title: "Toggle theme",
          onClick: () => app.setTheme(app.state.theme === "dark" ? "light" : "dark"),
        }),
        button({ icon: iconEl("help"), title: "Keyboard shortcuts — ?", onClick: () => openHelpDialog() }),
      ]),
    );

    const zoomIsland = h("div", { class: "island zoom-island" }, [
      button({ icon: iconEl("minus"), title: "Zoom out — Ctrl+-", onClick: () => app.setZoom(app.state.zoom / 1.1) }),
      h("button", {
        class: "zoom-value",
        type: "button",
        title: "Reset zoom — Ctrl+0",
        text: `${Math.round(app.state.zoom * 100)}%`,
        onclick: () => app.setZoom(1),
      }),
      button({ icon: iconEl("plus"), title: "Zoom in — Ctrl++", onClick: () => app.setZoom(app.state.zoom * 1.1) }),
      button({ icon: iconEl("zoomReset"), title: "Zoom to fit — Shift+1", onClick: () => app.zoomToFit() }),
    ]);

    const historyIsland = h("div", { class: "island", style: { display: "flex", gap: "2px", padding: "4px" } }, [
      button({ icon: iconEl("undo"), title: "Undo — Ctrl+Z", disabled: !app.canUndo, onClick: () => app.undo() }),
      button({ icon: iconEl("redo"), title: "Redo — Ctrl+Shift+Z", disabled: !app.canRedo, onClick: () => app.redo() }),
    ]);

    bottomLeft.replaceChildren(zoomIsland, historyIsland);
    bottomRight.replaceChildren();
    if (app.state.statsEnabled) bottomRight.append(renderStats(app));
  }

  /* ---------------------------------------------------------------- *
   * Style panel
   * ---------------------------------------------------------------- */

  function renderPanel(): void {
    const selected = app.getSelectedElements();
    const tool = app.state.tool;
    const visible = selected.length > 0 || SHAPE_TOOLS.has(tool) || tool === "text";

    panel.hidden = !visible || app.state.zenMode || app.state.viewMode;
    if (panel.hidden) return;

    const types = new Set<string>(selected.length ? selected.map((element) => element.type) : [tool]);
    const style = app.state.currentStyle;
    const has = (...candidates: string[]) => candidates.some((type) => types.has(type));

    const geometry = has("rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "frame");
    const fillable = has("rectangle", "diamond", "ellipse", "line", "arrow", "freedraw");
    const textual = has("text") || tool === "text";
    const linear = has("arrow");

    panel.replaceChildren();

    panel.append(
      section("Stroke", [
        swatchRow(STROKE_COLORS, style.strokeColor, (color) => app.setStyle({ strokeColor: color }), false),
      ]),
    );

    if (fillable) {
      panel.append(
        section("Background", [
          swatchRow(BACKGROUND_COLORS, style.backgroundColor, (color) => app.setStyle({ backgroundColor: color }), true),
        ]),
      );
      if (style.backgroundColor !== "transparent") {
        panel.append(
          section("Fill", [
            optionRow(
              [
                { value: "hachure", label: "▤", title: "Hachure" },
                { value: "cross-hatch", label: "▩", title: "Cross-hatch" },
                { value: "solid", label: "■", title: "Solid" },
                { value: "zigzag", label: "◪", title: "Zigzag" },
              ],
              style.fillStyle,
              (value) => app.setStyle({ fillStyle: value as ItemStyle["fillStyle"] }),
            ),
          ]),
        );
      }
    }

    if (geometry) {
      panel.append(
        section("Stroke width", [
          h("div", { class: "slider-row" }, [
            h("input", {
              type: "range",
              min: "1",
              max: "20",
              step: "1",
              value: String(style.strokeWidth),
              onpointerdown: () => {
                sliderActive = true;
              },
              oninput: (event: Event) => {
                sliderActive = true;
                app.setStyle({ strokeWidth: Number((event.target as HTMLInputElement).value) });
              },
            }),
            h("span", { text: `${style.strokeWidth}px`, style: { fontSize: "12px", minWidth: "34px" } }),
          ]),
        ]),
        section("Stroke style", [
          optionRow(
            [
              { value: "solid", label: "──", title: "Solid" },
              { value: "dashed", label: "╌╌", title: "Dashed" },
              { value: "dotted", label: "···", title: "Dotted" },
            ],
            style.strokeStyle,
            (value) => app.setStyle({ strokeStyle: value as ItemStyle["strokeStyle"] }),
          ),
        ]),
        section("Sloppiness", [
          optionRow(
            [
              { value: String(ROUGHNESS.architect), label: "⌐", title: "Architect" },
              { value: String(ROUGHNESS.artist), label: "≈", title: "Artist" },
              { value: String(ROUGHNESS.cartoonist), label: "∿", title: "Cartoonist" },
            ],
            String(style.roughness),
            (value) => app.setStyle({ roughness: Number(value) }),
          ),
        ]),
      );

      if (has("rectangle", "diamond", "line", "arrow", "frame")) {
        panel.append(
          section("Edges", [
            optionRow(
              [
                { value: "sharp", label: "◺", title: "Sharp" },
                { value: "round", label: "◜", title: "Round" },
              ],
              style.roundness?.type ?? "sharp",
              (value) => app.setStyle({ roundness: { type: value as "sharp" | "round" } }),
            ),
          ]),
        );
      }
    }

    if (linear) {
      panel.append(
        section("Arrowheads", [
          h("div", { class: "option-row" }, [
            arrowheadSelect(style.startArrowhead, (value) => app.setStyle({ startArrowhead: value }), "Start"),
            arrowheadSelect(style.endArrowhead, (value) => app.setStyle({ endArrowhead: value }), "End"),
          ]),
        ]),
      );
    }

    if (textual) {
      panel.append(
        section("Font family", [
          optionRow(
            [
              { value: "hand", label: "✎", title: "Hand-drawn (Caveat · Gaegu)" },
              { value: "normal", label: "A", title: "Normal (system)" },
              { value: "code", label: "</>", title: "Code" },
              { value: "pretendard", label: "Pr", title: "Pretendard" },
              { value: "noto", label: "노", title: "Noto Sans KR" },
              { value: "serif", label: "明", title: "Noto Serif KR" },
            ],
            style.fontFamily,
            (value) => app.setStyle({ fontFamily: value as FontFamily }),
          ),
        ]),
        section("Font size", [
          optionRow(
            Object.entries(FONT_SIZES).map(([label, value]) => ({
              value: String(value),
              label,
              title: `${label} (${value}px)`,
            })),
            String(style.fontSize),
            (value) => app.setStyle({ fontSize: Number(value) }),
          ),
        ]),
        section("Text align", [
          optionRow(
            [
              { value: "left", label: "⬅", title: "Left" },
              { value: "center", label: "↔", title: "Center" },
              { value: "right", label: "➡", title: "Right" },
            ],
            style.textAlign,
            (value) => app.setStyle({ textAlign: value as ItemStyle["textAlign"] }),
          ),
        ]),
      );
    }

    panel.append(
      section("Opacity", [
        h("div", { class: "slider-row" }, [
          h("input", {
            type: "range",
            min: "0",
            max: "100",
            step: "10",
            value: String(style.opacity),
            onpointerdown: () => {
              sliderActive = true;
            },
            oninput: (event: Event) => {
              sliderActive = true;
              app.setStyle({ opacity: Number((event.target as HTMLInputElement).value) });
            },
          }),
          h("span", { text: `${style.opacity}%`, style: { fontSize: "12px", minWidth: "34px" } }),
        ]),
      ]),
    );

    if (selected.length) {
      panel.append(
        section("Layers", [
          h("div", { class: "option-row" }, [
            iconOption("sendToBack", "Send to back — Ctrl+Shift+[", () => app.changeZ("back")),
            iconOption("sendBackward", "Send backward — Ctrl+[", () => app.changeZ("backward")),
            iconOption("bringForward", "Bring forward — Ctrl+]", () => app.changeZ("forward")),
            iconOption("bringToFront", "Bring to front — Ctrl+Shift+]", () => app.changeZ("front")),
          ]),
        ]),
      );

      if (selected.length > 1) {
        panel.append(
          section("Align", [
            h("div", { class: "option-row" }, [
              iconOption("alignLeft", "Align left", () => app.align("left")),
              iconOption("alignCenterH", "Centre horizontally", () => app.align("center")),
              iconOption("alignRight", "Align right", () => app.align("right")),
              iconOption("alignTop", "Align top", () => app.align("top")),
              iconOption("alignCenterV", "Centre vertically", () => app.align("middle")),
              iconOption("alignBottom", "Align bottom", () => app.align("bottom")),
              iconOption("distributeH", "Distribute horizontally", () => app.distribute("horizontal")),
              iconOption("distributeV", "Distribute vertically", () => app.distribute("vertical")),
            ]),
          ]),
        );
      }

      panel.append(
        section("Actions", [
          h("div", { class: "option-row" }, [
            iconOption("flipH", "Flip horizontal — Ctrl+Shift+H", () => app.flip("horizontal")),
            iconOption("flipV", "Flip vertical — Ctrl+Shift+V", () => app.flip("vertical")),
            iconOption("duplicate", "Duplicate — Ctrl+D", () => app.duplicate()),
            iconOption(
              selected.some((element) => element.locked) ? "unlock" : "lock",
              "Lock / unlock",
              () => app.toggleLock(),
            ),
            selected.length > 1 ? iconOption("group", "Group — Ctrl+G", () => app.group()) : null,
            selected.some((element) => element.groupIds.length)
              ? iconOption("ungroup", "Ungroup — Ctrl+Shift+G", () => app.ungroup())
              : null,
            iconOption("trash", "Delete — Del", () => app.deleteSelection()),
          ]),
        ]),
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Welcome hint
   * ---------------------------------------------------------------- */

  function renderWelcome(): void {
    const empty = app.elements.filter((element) => !element.isDeleted).length === 0;
    welcome.hidden = !empty;
    if (empty) {
      welcome.replaceChildren(
        h("strong", { text: "axdraw" }),
        h("div", { text: "Pick a tool and start drawing." }),
        h("div", { text: "Sketch a rough box or circle with the Draw tool — it snaps into a clean shape." }),
        h("div", { text: "Press ? or open the menu for all shortcuts." }),
      );
    }
  }

  function render(): void {
    if (sliderActive) {
      renderCorners();
      return;
    }
    renderToolbar();
    renderCorners();
    renderPanel();
    renderWelcome();
  }

  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
      event.preventDefault();
      openHelpDialog();
    }
  });

  app.subscribe(render);
  render();
}

/* ------------------------------------------------------------------ *
 * Panel building blocks
 * ------------------------------------------------------------------ */

function section(label: string, children: HTMLElement[]): HTMLElement {
  return h("div", { class: "panel-section" }, [h("div", { class: "panel-label", text: label }), ...children]);
}

function swatchRow(
  colors: string[],
  current: string,
  onPick: (color: string) => void,
  allowTransparent: boolean,
): HTMLElement {
  const row = h(
    "div",
    { class: "swatch-row" },
    colors.map((color) =>
      h("button", {
        class: `swatch${color === "transparent" ? " swatch--transparent" : ""}${color === current ? " is-active" : ""}`,
        type: "button",
        title: color,
        style: color === "transparent" ? {} : { background: color },
        onclick: () => onPick(color),
      }),
    ),
  );

  const currentSwatch = h("button", {
    class: `swatch swatch--current${current === "transparent" ? " swatch--transparent" : ""}`,
    type: "button",
    title: "More colours",
    style: current === "transparent" ? {} : { background: current },
    onclick: (event: MouseEvent) => {
      event.stopPropagation();
      openColorPicker(event.currentTarget as HTMLElement, current, onPick, allowTransparent);
    },
  });

  return h("div", { class: "swatches" }, [row, currentSwatch]);
}

function optionRow(
  options: { value: string; label: string; title: string }[],
  current: string,
  onPick: (value: string) => void,
): HTMLElement {
  return h(
    "div",
    { class: "option-row" },
    options.map((option) =>
      h("button", {
        class: `option${option.value === current ? " is-active" : ""}`,
        type: "button",
        title: option.title,
        text: option.label,
        onclick: () => onPick(option.value),
      }),
    ),
  );
}

function iconOption(icon: string, title: string, onClick: () => void): HTMLElement {
  const element = h("button", { class: "option", type: "button", title, onclick: onClick });
  element.innerHTML = iconEl(icon);
  return element;
}

const ARROWHEADS: { value: Arrowhead; label: string }[] = [
  { value: "none", label: "—" },
  { value: "arrow", label: "→" },
  { value: "triangle", label: "▶" },
  { value: "triangle-outline", label: "▷" },
  { value: "diamond", label: "◆" },
  { value: "dot", label: "●" },
  { value: "bar", label: "|" },
];

function arrowheadSelect(
  current: Arrowhead,
  onPick: (value: Arrowhead) => void,
  label: string,
): HTMLElement {
  const select = h(
    "select",
    {
      class: "option",
      style: { width: "88px" },
      title: `${label} arrowhead`,
      onchange: (event: Event) => onPick((event.target as HTMLSelectElement).value as Arrowhead),
    },
    ARROWHEADS.map((option) =>
      h("option", { value: option.value, text: `${label[0]} ${option.label}`, selected: option.value === current }),
    ),
  );
  return select;
}

function openColorPicker(
  anchor: HTMLElement,
  current: string,
  onPick: (color: string) => void,
  allowTransparent: boolean,
): void {
  const rect = anchor.getBoundingClientRect();
  const picker = h("div", { class: "dropdown island" });
  picker.style.left = `${Math.min(rect.right + 8, window.innerWidth - 260)}px`;
  picker.style.top = `${Math.min(rect.top, window.innerHeight - 340)}px`;
  picker.style.width = "244px";

  const close = () => {
    dispose();
    picker.remove();
  };

  if (allowTransparent) {
    picker.append(
      h("button", {
        class: "dropdown-item",
        type: "button",
        text: "Transparent",
        onclick: () => {
          onPick("transparent");
          close();
        },
      }),
    );
  }

  for (const [name, shades] of Object.entries(EXTENDED_PALETTE)) {
    picker.append(
      h("div", { class: "swatch-row", style: { marginBottom: "4px" }, title: name },
        shades.map((color) =>
          h("button", {
            class: `swatch${color === current ? " is-active" : ""}`,
            type: "button",
            title: color,
            style: { background: color, width: "20px", height: "20px" },
            onclick: () => {
              onPick(color);
              close();
            },
          }),
        ),
      ),
    );
  }

  picker.append(
    h("div", { class: "dropdown-separator" }),
    h("div", { class: "field-row" }, [
      h("input", {
        type: "color",
        value: current === "transparent" ? "#ffffff" : current,
        oninput: (event: Event) => onPick((event.target as HTMLInputElement).value),
        style: { width: "40px", height: "30px", padding: "0", border: "none", background: "none" },
      }),
      h("input", {
        type: "text",
        value: current,
        placeholder: "#1e1e1e",
        style: { flex: "1", padding: "6px", borderRadius: "6px", border: "1px solid var(--separator)", background: "transparent", color: "var(--text)" },
        onchange: (event: Event) => {
          const value = (event.target as HTMLInputElement).value.trim();
          if (/^#?[0-9a-fA-F]{3,8}$/.test(value)) {
            onPick(value.startsWith("#") ? value : `#${value}`);
            close();
          }
        },
      }),
    ]),
  );

  document.body.appendChild(picker);
  const dispose = dismissable(picker, close);
}

/* ------------------------------------------------------------------ *
 * Menus
 * ------------------------------------------------------------------ */

function menuItem(
  icon: string,
  label: string,
  shortcut: string | null,
  onClick: () => void,
  danger = false,
): HTMLElement {
  const element = h("button", {
    class: `dropdown-item${danger ? " danger" : ""}`,
    type: "button",
    onclick: onClick,
  });
  if (icon) {
    const span = document.createElement("span");
    span.innerHTML = iconEl(icon);
    element.append(span.firstElementChild ?? span);
  }
  element.append(document.createTextNode(label));
  if (shortcut) element.append(h("span", { class: "kbd", text: shortcut }));
  return element;
}

function openMainMenu(app: App, root: HTMLElement, anchor: HTMLElement, refresh: () => void): void {
  const existing = root.querySelector<HTMLElement>(".dropdown[data-menu='main']");
  if (existing) {
    existing.remove();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const menu = h("div", { class: "dropdown island", dataset: { menu: "main" } });
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 8}px`;

  const close = () => {
    dispose();
    menu.remove();
  };
  const run = (action: () => void) => () => {
    action();
    close();
    refresh();
  };

  menu.append(
    menuItem("upload", "Open…", "Ctrl+O", run(() => void app.openFile())),
    menuItem("download", "Save to file", "Ctrl+S", run(() => app.saveToFile())),
    menuItem("image", "Export image…", "Ctrl+E", run(() => openExportDialog(app))),
    menuItem("copy", "Copy canvas to clipboard", null, run(() => void app.copyPngToClipboard())),
    menuItem("link", "Share link…", null, run(() => void app.shareLink())),
    menuItem(
      "users",
      app.collab ? "Stop live collaboration" : "Live collaboration…",
      null,
      run(() => (app.collab ? app.stopCollab() : void app.startCollab())),
    ),
    h("div", { class: "dropdown-separator" }),
    menuItem("grid", `Grid: ${app.state.gridEnabled ? "on" : "off"}`, "Ctrl+'", run(() => app.toggleGrid())),
    menuItem("selection", `Object snapping: ${app.state.snapEnabled ? "on" : "off"}`, null, run(() => {
      app.state.snapEnabled = !app.state.snapEnabled;
    })),
    menuItem("wand", `Shape assist: ${app.state.shapeRecognition ? "on" : "off"}`, null, run(() => {
      app.state.shapeRecognition = !app.state.shapeRecognition;
    })),
    menuItem("zoomReset", `Stats: ${app.state.statsEnabled ? "on" : "off"}`, null, run(() => {
      app.state.statsEnabled = !app.state.statsEnabled;
    })),
    menuItem("frame", `View mode: ${app.state.viewMode ? "on" : "off"}`, null, run(() => {
      app.state.viewMode = !app.state.viewMode;
      app.setTool("selection", false);
    })),
    menuItem(app.state.theme === "dark" ? "sun" : "moon", "Toggle theme", null, run(() =>
      app.setTheme(app.state.theme === "dark" ? "light" : "dark"),
    )),
    h("div", { class: "dropdown-separator" }),
    h("div", { class: "dropdown-title", text: "Canvas background" }),
    h(
      "div",
      { class: "swatch-row", style: { padding: "4px 10px 8px" } },
      CANVAS_COLORS.map((color) =>
        h("button", {
          class: `swatch${color === app.state.viewBackgroundColor ? " is-active" : ""}`,
          type: "button",
          title: color,
          style: { background: color },
          onclick: () => {
            app.setViewBackgroundColor(color);
            refresh();
          },
        }),
      ),
    ),
    h("div", { class: "dropdown-separator" }),
    menuItem("help", "Keyboard shortcuts", "?", run(() => openHelpDialog())),
    menuItem(
      "trash",
      "Reset the canvas",
      null,
      run(() =>
        openConfirmDialog(
          "Clear canvas",
          "This removes every element from the canvas. You can still undo it afterwards.",
          "Clear canvas",
          () => app.clearCanvas(),
        ),
      ),
      true,
    ),
  );

  root.appendChild(menu);
  const dispose = dismissable(menu, close);
}

function openContextMenu(
  app: App,
  root: HTMLElement,
  clientX: number,
  clientY: number,
  refresh: () => void,
): void {
  root.querySelector(".dropdown[data-menu='context']")?.remove();

  const selected = app.getSelectedElements();
  const menu = h("div", { class: "dropdown island", dataset: { menu: "context" } });
  menu.style.left = `${Math.min(clientX, window.innerWidth - 240)}px`;
  menu.style.top = `${Math.min(clientY, window.innerHeight - 320)}px`;

  const close = () => {
    dispose();
    menu.remove();
  };
  const run = (action: () => void) => () => {
    action();
    close();
    refresh();
  };

  if (!selected.length) {
    menu.append(
      menuItem("copy", "Paste", "Ctrl+V", run(() => app.pasteFromClipboard())),
      menuItem("selection", "Select all", "Ctrl+A", run(() => app.selectAll())),
      menuItem("grid", `${app.state.gridEnabled ? "Hide" : "Show"} grid`, "Ctrl+'", run(() => app.toggleGrid())),
      menuItem("zoomReset", "Zoom to fit", "Shift+1", run(() => app.zoomToFit())),
      menuItem("unlock", "Unlock all elements", null, run(() => app.unlockAll())),
    );
  } else {
    menu.append(
      menuItem("copy", "Copy", "Ctrl+C", run(() => app.copySelection())),
      menuItem("duplicate", "Duplicate", "Ctrl+D", run(() => app.duplicate())),
      menuItem("copy", "Copy as PNG", null, run(() => void app.copyPngToClipboard())),
      h("div", { class: "dropdown-separator" }),
      menuItem("bringToFront", "Bring to front", "Ctrl+Shift+]", run(() => app.changeZ("front"))),
      menuItem("bringForward", "Bring forward", "Ctrl+]", run(() => app.changeZ("forward"))),
      menuItem("sendBackward", "Send backward", "Ctrl+[", run(() => app.changeZ("backward"))),
      menuItem("sendToBack", "Send to back", "Ctrl+Shift+[", run(() => app.changeZ("back"))),
      h("div", { class: "dropdown-separator" }),
    );
    if (selected.some((element: AxElement) => element.type === "freedraw")) {
      menu.append(
        menuItem("wand", "Convert to shape", null, run(() => app.convertSelectedFreedraw())),
        h("div", { class: "dropdown-separator" }),
      );
    }
    if (selected.length > 1) {
      menu.append(menuItem("group", "Group selection", "Ctrl+G", run(() => app.group())));
    }
    if (selected.some((element: AxElement) => element.groupIds.length)) {
      menu.append(menuItem("ungroup", "Ungroup selection", "Ctrl+Shift+G", run(() => app.ungroup())));
    }
    menu.append(
      menuItem("flipH", "Flip horizontal", "Ctrl+Shift+H", run(() => app.flip("horizontal"))),
      menuItem("flipV", "Flip vertical", "Ctrl+Shift+V", run(() => app.flip("vertical"))),
      menuItem(
        selected.some((element: AxElement) => element.locked) ? "unlock" : "lock",
        selected.some((element: AxElement) => element.locked) ? "Unlock" : "Lock",
        null,
        run(() => app.toggleLock()),
      ),
      h("div", { class: "dropdown-separator" }),
      menuItem("trash", "Delete", "Del", run(() => app.deleteSelection()), true),
    );
  }

  root.appendChild(menu);
  const dispose = dismissable(menu, close);
}

/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

function renderStats(app: App): HTMLElement {
  const stats = app.getStats();
  const selected = app.getSelectedElements();
  const container = h("div", { class: "island stats" }, [
    h("div", { class: "stats-title", text: "Canvas" }),
    row("Elements", String(stats.elements)),
    row("Zoom", `${Math.round(stats.zoom * 100)}%`),
    row("Pointer", `${Math.round(stats.pointer.x)}, ${Math.round(stats.pointer.y)}`),
  ]);

  if (selected.length === 1) {
    const element = selected[0];
    container.append(
      h("div", { class: "stats-title", text: "Selected" }),
      numberRow("X", Math.round(element.x), (value) => app.setElementProperty("x", value)),
      numberRow("Y", Math.round(element.y), (value) => app.setElementProperty("y", value)),
      numberRow("W", Math.round(element.width), (value) => app.setElementProperty("width", value)),
      numberRow("H", Math.round(element.height), (value) => app.setElementProperty("height", value)),
      numberRow("A", Math.round((element.angle * 180) / Math.PI), (value) =>
        app.setElementProperty("angle", value),
      ),
    );
  } else if (selected.length > 1) {
    container.append(h("div", { class: "stats-title", text: "Selected" }), row("Count", String(selected.length)));
  }

  return container;
}

function row(label: string, value: string): HTMLElement {
  return h("div", { class: "stats-row" }, [h("span", { text: label }), h("strong", { text: value })]);
}

function numberRow(label: string, value: number, onChange: (value: number) => void): HTMLElement {
  return h("div", { class: "stats-row" }, [
    h("span", { text: label }),
    h("input", {
      type: "number",
      value: String(value),
      onchange: (event: Event) => {
        const parsed = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(parsed)) onChange(parsed);
      },
    }),
  ]);
}
