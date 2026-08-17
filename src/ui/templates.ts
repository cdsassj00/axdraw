/**
 * Built-in diagram templates.
 *
 * A template is a factory returning plain elements laid out around the
 * origin; insertion re-ids them, drops them at the viewport centre and
 * selects the lot (via the same path as paste), so a template behaves
 * exactly like something you drew — fully editable, one undo step.
 */

import type { App } from "../app";
import { DEFAULT_STYLE } from "../constants";
import { newLinearElement, newShapeElement, newTextElement } from "../element/factory";
import type { AxElement, ItemStyle } from "../types";
import { h } from "./dom";

function style(overrides: Partial<ItemStyle> = {}): ItemStyle {
  return { ...DEFAULT_STYLE, ...overrides };
}

function shape(
  type: "rectangle" | "diamond" | "ellipse",
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Partial<ItemStyle> = {},
): AxElement {
  return newShapeElement(type, { x, y, width, height, style: style(overrides) });
}

/** A text element centred on (cx, cy). */
function label(text: string, cx: number, cy: number, fontSize = 20): AxElement {
  const element = newTextElement({
    x: 0,
    y: 0,
    style: style({ fontSize, textAlign: "center" }),
    text,
  });
  element.x = cx - element.width / 2;
  element.y = cy - element.height / 2;
  return element;
}

/** Arrows/lines are laid out left-to-right / top-down so extents stay positive. */
function connector(type: "arrow" | "line", x1: number, y1: number, x2: number, y2: number): AxElement {
  return newLinearElement(type, {
    x: x1,
    y: y1,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    style: style(),
    points: [
      [0, 0],
      [x2 - x1, y2 - y1],
    ],
  }) as AxElement;
}

interface Template {
  name: string;
  description: string;
  emoji: string;
  build: () => AxElement[];
}

const PASTELS = { blue: "#a5d8ff", green: "#b2f2bb", yellow: "#ffec99", red: "#ffc9c9" };

const TEMPLATES: Template[] = [
  {
    name: "플로우차트",
    description: "시작 → 처리 → 판단 분기",
    emoji: "🔀",
    build: () => [
      shape("ellipse", 40, 0, 160, 64, { backgroundColor: PASTELS.green, fillStyle: "solid" }),
      label("시작", 120, 32),
      connector("arrow", 120, 68, 120, 128),
      shape("rectangle", 30, 132, 180, 64, { backgroundColor: PASTELS.blue, fillStyle: "solid" }),
      label("처리", 120, 164),
      connector("arrow", 120, 200, 120, 260),
      shape("diamond", 20, 264, 200, 96, { backgroundColor: PASTELS.yellow, fillStyle: "solid" }),
      label("판단?", 120, 312),
      connector("arrow", 120, 364, 120, 424),
      label("예", 138, 394, 16),
      shape("ellipse", 40, 428, 160, 64, { backgroundColor: PASTELS.red, fillStyle: "solid" }),
      label("끝", 120, 460),
      connector("arrow", 224, 312, 320, 312),
      label("아니오", 272, 292, 16),
      shape("rectangle", 324, 280, 170, 64, { backgroundColor: PASTELS.blue, fillStyle: "solid" }),
      label("다시 처리", 409, 312),
    ],
  },
  {
    name: "마인드맵",
    description: "중심 주제와 가지 4개",
    emoji: "🧠",
    build: () => {
      const elements: AxElement[] = [
        shape("ellipse", 200, 130, 200, 90, { backgroundColor: PASTELS.yellow, fillStyle: "solid" }),
        label("주제", 300, 175, 24),
      ];
      const branches: [string, number, number, string][] = [
        ["아이디어 1", 0, 0, PASTELS.blue],
        ["아이디어 2", 440, 0, PASTELS.green],
        ["아이디어 3", 0, 300, PASTELS.green],
        ["아이디어 4", 440, 300, PASTELS.blue],
      ];
      for (const [text, x, y, color] of branches) {
        elements.push(shape("rectangle", x, y, 160, 56, { backgroundColor: color, fillStyle: "solid" }));
        elements.push(label(text, x + 80, y + 28, 18));
        const [cx, cy] = [x + 80, y + 28];
        elements.push(
          connector("line", Math.min(300, cx), Math.min(175, cy), Math.max(300, cx), Math.max(175, cy)),
        );
      }
      return elements;
    },
  },
  {
    name: "칸반 보드",
    description: "할 일 · 진행 중 · 완료",
    emoji: "📋",
    build: () => {
      const columns: [string, string][] = [
        ["할 일", PASTELS.red],
        ["진행 중", PASTELS.yellow],
        ["완료", PASTELS.green],
      ];
      const elements: AxElement[] = [];
      columns.forEach(([title, color], index) => {
        const x = index * 240;
        elements.push(shape("rectangle", x, 0, 220, 440));
        elements.push(shape("rectangle", x + 10, 12, 200, 44, { backgroundColor: color, fillStyle: "solid" }));
        elements.push(label(title, x + 110, 34, 18));
        elements.push(shape("rectangle", x + 10, 72, 200, 60));
        elements.push(label("카드", x + 110, 102, 16));
      });
      return elements;
    },
  },
  {
    name: "4분면",
    description: "SWOT · 중요도/긴급도",
    emoji: "🧭",
    build: () => [
      shape("rectangle", 0, 0, 520, 400),
      connector("line", 260, 0, 260, 400),
      connector("line", 0, 200, 520, 200),
      label("1. 중요 · 긴급", 130, 100, 18),
      label("2. 중요 · 여유", 390, 100, 18),
      label("3. 위임", 130, 300, 18),
      label("4. 제거", 390, 300, 18),
    ],
  },
];

export function openTemplateDialog(app: App): void {
  const backdrop = h("div", { class: "modal-backdrop" });
  const close = (): void => backdrop.remove();
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  window.addEventListener("keydown", function onKey(event) {
    if (event.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey);
    }
  });

  const cards = TEMPLATES.map((template) =>
    h(
      "button",
      {
        class: "tpl-card",
        type: "button",
        onclick: () => {
          app.insertTemplate(template.build());
          close();
        },
      },
      [
        h("div", { class: "tpl-emoji", text: template.emoji }),
        h("div", { class: "tpl-name", text: template.name }),
        h("div", { class: "tpl-desc", text: template.description }),
      ],
    ),
  );

  backdrop.append(
    h("div", { class: "modal island", style: { width: "min(560px, 100%)" } }, [
      h("div", { class: "modal-header" }, [
        h("h2", { text: "템플릿" }),
        h("button", { class: "secondary-btn", type: "button", text: "닫기", onclick: close }),
      ]),
      h("div", { class: "tpl-grid" }, cards),
    ]),
  );
  document.body.appendChild(backdrop);
}
