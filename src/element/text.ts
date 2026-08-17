/** Text measurement, wrapping and shape-label (container) handling. */

import { DEFAULT_LINE_HEIGHT, FONT_STACKS, TEXT_CONTAINER_PADDING } from "../constants";
import type { AxElement, FontFamily, TextElement } from "../types";

let measureContext: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureContext) {
    const canvas = document.createElement("canvas");
    measureContext = canvas.getContext("2d")!;
  }
  return measureContext;
}

export function getFontString(fontSize: number, fontFamily: FontFamily): string {
  return `${fontSize}px ${FONT_STACKS[fontFamily]}`;
}

export function measureLineWidth(line: string, font: string, letterSpacing = 0): number {
  const ctx = getMeasureContext();
  ctx.font = font;
  // canvas letterSpacing (Chrome 99+/Safari 17+); older engines just ignore it.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${letterSpacing}px`;
  return ctx.measureText(line).width;
}

export interface TextMetrics {
  width: number;
  height: number;
  lines: string[];
}

export function measureText(text: string, fontSize: number, fontFamily: FontFamily, lineHeight = DEFAULT_LINE_HEIGHT, letterSpacing = 0): TextMetrics {
  const font = getFontString(fontSize, fontFamily);
  const lines = text.split("\n");
  let width = 0;
  for (const line of lines) width = Math.max(width, measureLineWidth(line, font, letterSpacing));
  return { width, height: lines.length * fontSize * lineHeight, lines };
}

/** True for scripts that may wrap between any two characters (CJK). */
function isBreakableChar(char: string): boolean {
  return /[ᄀ-ᇿ　-ヿ㄰-㆏一-鿿가-힯＀-￯]/.test(char);
}

/**
 * Greedy word wrap that also breaks inside CJK runs and inside words that are
 * longer than the available width.
 */
export function wrapText(text: string, fontSize: number, fontFamily: FontFamily, maxWidth: number, letterSpacing = 0): string {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return text;
  const font = getFontString(fontSize, fontFamily);
  const output: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      output.push("");
      continue;
    }

    let line = "";
    const pushLine = () => {
      output.push(line);
      line = "";
    };

    // Tokenise into words, keeping trailing spaces attached and splitting CJK
    // into single characters so they can wrap anywhere.
    const tokens: string[] = [];
    let buffer = "";
    for (const char of paragraph) {
      if (isBreakableChar(char)) {
        if (buffer) {
          tokens.push(buffer);
          buffer = "";
        }
        tokens.push(char);
      } else if (char === " ") {
        buffer += char;
        tokens.push(buffer);
        buffer = "";
      } else {
        buffer += char;
      }
    }
    if (buffer) tokens.push(buffer);

    for (const token of tokens) {
      const candidate = line + token;
      if (measureLineWidth(candidate.trimEnd(), font, letterSpacing) <= maxWidth || line === "") {
        if (line === "" && measureLineWidth(token.trimEnd(), font, letterSpacing) > maxWidth) {
          // A single token wider than the box: hard-break it per character.
          let chunk = "";
          for (const char of token) {
            if (measureLineWidth(chunk + char, font, letterSpacing) > maxWidth && chunk !== "") {
              output.push(chunk);
              chunk = char;
            } else {
              chunk += char;
            }
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        line = line.trimEnd();
        pushLine();
        line = token.trimStart() === "" ? "" : token;
      }
    }
    output.push(line.trimEnd());
  }

  return output.join("\n");
}

export function isTextElement(element: AxElement): element is TextElement {
  return element.type === "text";
}

export function canContainText(element: AxElement): boolean {
  return (
    element.type === "rectangle" ||
    element.type === "diamond" ||
    element.type === "ellipse" ||
    element.type === "arrow" ||
    element.type === "line" ||
    element.type === "frame"
  );
}

export function getBoundTextElement(
  container: AxElement | null,
  elements: readonly AxElement[],
): TextElement | null {
  if (!container?.boundElements) return null;
  const entry = container.boundElements.find((bound) => bound.type === "text");
  if (!entry) return null;
  const text = elements.find((element) => element.id === entry.id && !element.isDeleted);
  return text && isTextElement(text) ? text : null;
}

export function getContainerElement(
  text: TextElement,
  elements: readonly AxElement[],
): AxElement | null {
  if (!text.containerId) return null;
  return elements.find((element) => element.id === text.containerId && !element.isDeleted) ?? null;
}

/** Usable text width inside a container (ellipses get an inscribed box). */
export function getContainerTextWidth(container: AxElement): number {
  const padding = TEXT_CONTAINER_PADDING * 2;
  if (container.type === "ellipse") {
    return Math.max(container.width / Math.sqrt(2) - padding, 0);
  }
  if (container.type === "diamond") {
    return Math.max(container.width / 2 - padding, 0);
  }
  if (container.type === "arrow" || container.type === "line") {
    return Math.max(container.width, 40);
  }
  return Math.max(container.width - padding, 0);
}
