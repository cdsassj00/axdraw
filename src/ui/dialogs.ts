/** Modal dialogs: keyboard help, image export, and confirmation. */

import type { App } from "../app";
import { button, h } from "./dom";
import { iconEl } from "./icons";

function modal(title: string, body: HTMLElement, footer?: HTMLElement): HTMLElement {
  const close = () => backdrop.remove();
  const backdrop = h(
    "div",
    {
      class: "modal-backdrop",
      onclick: (event: MouseEvent) => {
        if (event.target === backdrop) close();
      },
    },
    [
      h("div", { class: "modal island" }, [
        h("div", { class: "modal-header" }, [
          h("h2", { text: title }),
          button({ icon: iconEl("close"), title: "Close", onClick: close }),
        ]),
        body,
        footer ?? null,
      ]),
    ],
  );
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey, true);
    }
  };
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(backdrop);
  return backdrop;
}

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: "Tools",
    items: [
      ["Selection", "V / 1"],
      ["Rectangle", "R / 2"],
      ["Diamond", "D / 3"],
      ["Ellipse", "O / 4"],
      ["Arrow", "A / 5"],
      ["Line", "L / 6"],
      ["Draw", "P / 7"],
      ["Text", "T / 8"],
      ["Image", "9"],
      ["Eraser", "E / 0"],
      ["Frame", "F"],
      ["Laser pointer", "K"],
      ["Hand (pan)", "H / Space"],
      ["Keep tool active", "Q"],
    ],
  },
  {
    group: "Editor",
    items: [
      ["Undo", "Ctrl+Z"],
      ["Redo", "Ctrl+Shift+Z"],
      ["Delete", "Delete"],
      ["Duplicate", "Ctrl+D / Alt+drag"],
      ["Copy / Paste / Cut", "Ctrl+C / V / X"],
      ["Select all", "Ctrl+A"],
      ["Group / Ungroup", "Ctrl+G / Ctrl+Shift+G"],
      ["Bring forward / To front", "Ctrl+] / Ctrl+Shift+]"],
      ["Send backward / To back", "Ctrl+[ / Ctrl+Shift+["],
      ["Flip horizontal / vertical", "Ctrl+Shift+H / V"],
      ["Edit text / label", "Enter or double-click"],
      ["Move by 1px / 10px", "Arrows / Shift+Arrows"],
    ],
  },
  {
    group: "View",
    items: [
      ["Zoom in / out", "Ctrl++ / Ctrl+-"],
      ["Reset zoom", "Ctrl+0"],
      ["Zoom to fit", "Shift+1"],
      ["Zoom to selection", "Shift+2"],
      ["Toggle grid", "Ctrl+'"],
      ["Pan", "Space+drag / middle drag"],
      ["Save / Open", "Ctrl+S / Ctrl+O"],
      ["Export image", "Ctrl+E"],
    ],
  },
  {
    group: "While drawing",
    items: [
      ["Constrain to square/circle", "Shift+drag"],
      ["Draw from centre", "Alt+drag"],
      ["Snap line to 15°", "Shift"],
      ["Multi-point line", "Click, click, … Enter"],
      ["Finish / cancel", "Enter / Escape"],
      ["Straighten a sketch", "Draw with shape assist on"],
    ],
  },
];

export function openHelpDialog(): void {
  const body = h(
    "div",
    { class: "modal-grid" },
    SHORTCUTS.map((section) =>
      h("div", { class: "shortcut-list" }, [
        h("h3", { text: section.group }),
        ...section.items.map(([label, keys]) =>
          h("div", { class: "shortcut-row" }, [h("span", { text: label }), h("span", { text: keys })]),
        ),
      ]),
    ),
  );
  modal("Keyboard shortcuts", body);
}

export function openExportDialog(app: App): void {
  const hasSelection = app.getSelectedElements().length > 0;
  const state = {
    background: true,
    selectionOnly: hasSelection,
    scale: 2,
  };

  const checkbox = (label: string, checked: boolean, onChange: (value: boolean) => void) =>
    h("label", {}, [
      h("input", {
        type: "checkbox",
        checked,
        onchange: (event: Event) => onChange((event.target as HTMLInputElement).checked),
      }),
      document.createTextNode(label),
    ]);

  const scaleRow = h(
    "div",
    { class: "option-row" },
    [1, 2, 3].map((scale) =>
      h("button", {
        class: `option${scale === state.scale ? " is-active" : ""}`,
        type: "button",
        text: `${scale}×`,
        onclick: (event: MouseEvent) => {
          state.scale = scale;
          const parent = (event.currentTarget as HTMLElement).parentElement!;
          for (const child of Array.from(parent.children)) child.classList.remove("is-active");
          (event.currentTarget as HTMLElement).classList.add("is-active");
        },
      }),
    ),
  );

  const body = h("div", {}, [
    h("div", { class: "field-row" }, [
      checkbox("Include background", state.background, (value) => (state.background = value)),
    ]),
    hasSelection
      ? h("div", { class: "field-row" }, [
          checkbox("Only selected elements", state.selectionOnly, (value) => (state.selectionOnly = value)),
        ])
      : null,
    h("div", { class: "field-row" }, [h("span", { text: "Scale" }), scaleRow]),
  ]);

  // Assigned by modal() below; the actions need to dismiss the dialog they
  // are declared inside.
  let dismiss = () => {};
  const options = () => ({
    background: state.background,
    selectionOnly: state.selectionOnly,
    scale: state.scale,
  });

  const footer = h("div", { class: "field-row", style: { justifyContent: "flex-end", marginTop: "18px" } }, [
    h("button", {
      class: "secondary-btn",
      type: "button",
      text: "Copy PNG",
      onclick: () => {
        void app.copyPngToClipboard();
        dismiss();
      },
    }),
    h("button", {
      class: "secondary-btn",
      type: "button",
      text: "SVG",
      onclick: () => {
        app.exportSvg(options());
        dismiss();
      },
    }),
    h("button", {
      class: "primary-btn",
      type: "button",
      text: "PNG",
      onclick: () => {
        void app.exportPng(options());
        dismiss();
      },
    }),
  ]);

  // A download gives no on-page signal, so a dialog that just sits there after
  // the click looks exactly like a dialog that did nothing. Closing it is the
  // confirmation; the app raises a message if the export actually failed.
  const backdrop = modal("Export image", body, footer);
  dismiss = () => backdrop.remove();
}

export function openConfirmDialog(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void,
): void {
  const body = h("p", { text: message, style: { color: "var(--text-muted)", fontSize: "13px" } });
  const footer = h("div", { class: "field-row", style: { justifyContent: "flex-end", marginTop: "18px" } }, [
    h("button", {
      class: "secondary-btn",
      type: "button",
      text: "Cancel",
      onclick: () => backdrop.remove(),
    }),
    h("button", {
      class: "primary-btn",
      type: "button",
      text: confirmLabel,
      onclick: () => {
        onConfirm();
        backdrop.remove();
      },
    }),
  ]);
  const backdrop = modal(title, body, footer);
}

let toastTimer: number | null = null;

export function showToast(container: HTMLElement, message: string): void {
  const existing = container.querySelector(".toast");
  existing?.remove();
  const toast = h("div", { class: "toast", text: message });
  container.appendChild(toast);
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.remove(), 2600);
}
