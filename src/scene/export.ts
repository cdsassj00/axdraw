/** Export and import: PNG, SVG, and the .axdraw scene file. */

import {
  APP_NAME,
  EXPORT_PADDING,
  FONT_STACKS,
  SCENE_VERSION,
  THEME_FILTER,
} from "../constants";
import { getCommonBounds } from "../element/bounds";
import { getDashArray, getElementShape, getFreedrawStroke } from "../element/shapes";
import { opsToPath } from "../rough/render";
import type { AppState, AxElement, BinaryFiles, SceneData, TextElement, Theme } from "../types";
import { renderStaticScene } from "./renderer";

export interface ExportOptions {
  exportBackground: boolean;
  viewBackgroundColor: string;
  scale: number;
  theme: Theme;
  padding?: number;
  /** Export only these elements (defaults to everything). */
  elements?: readonly AxElement[];
}

function visible(elements: readonly AxElement[]): AxElement[] {
  return elements.filter((element) => !element.isDeleted);
}

/* ------------------------------------------------------------------ *
 * Raster export
 * ------------------------------------------------------------------ */

export function exportToCanvas(
  elements: readonly AxElement[],
  files: BinaryFiles,
  options: ExportOptions,
): HTMLCanvasElement {
  const list = visible(options.elements ?? elements);
  const padding = options.padding ?? EXPORT_PADDING;
  const bounds = getCommonBounds(list);
  const width = Math.max(1, Math.ceil(bounds.x2 - bounds.x1 + padding * 2));
  const height = Math.max(1, Math.ceil(bounds.y2 - bounds.y1 + padding * 2));

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * options.scale);
  canvas.height = Math.ceil(height * options.scale);

  renderStaticScene(canvas, list, files, {
    scrollX: -bounds.x1 + padding,
    scrollY: -bounds.y1 + padding,
    zoom: 1,
    width,
    height,
    theme: options.theme,
    viewBackgroundColor: options.exportBackground ? options.viewBackgroundColor : "rgba(0,0,0,0)",
    gridEnabled: false,
    gridSize: 20,
    devicePixelRatio: options.scale,
  });

  return canvas;
}

export async function exportToBlob(
  elements: readonly AxElement[],
  files: BinaryFiles,
  options: ExportOptions,
): Promise<Blob> {
  const canvas = exportToCanvas(elements, files, options);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode PNG"));
    }, "image/png");
  });
}

/* ------------------------------------------------------------------ *
 * SVG export
 * ------------------------------------------------------------------ */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function elementToSvg(element: AxElement, files: BinaryFiles): string {
  const parts: string[] = [];
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  const transform = element.angle
    ? ` transform="rotate(${(element.angle * 180) / Math.PI} ${cx} ${cy})"`
    : "";
  const opacity = element.opacity / 100;

  switch (element.type) {
    case "rectangle":
    case "diamond":
    case "ellipse":
    case "line":
    case "arrow": {
      const shape = getElementShape(element);
      if (!shape) break;
      const dash = getDashArray(element);
      const dashAttr = dash ? ` stroke-dasharray="${dash.join(" ")}"` : "";
      for (const drawable of shape.drawables) {
        for (const set of drawable.sets) {
          const d = opsToPath(set.ops);
          if (!d) continue;
          if (set.type === "path") {
            parts.push(
              `<path d="${d}" stroke="${drawable.options.stroke}" stroke-width="${drawable.options.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"${dashAttr}/>`,
            );
          } else if (set.type === "fillPath") {
            parts.push(`<path d="${d}" fill="${drawable.options.fill ?? "none"}" stroke="none"/>`);
          } else {
            const weight =
              drawable.options.fillWeight < 0
                ? drawable.options.strokeWidth / 2
                : drawable.options.fillWeight;
            parts.push(
              `<path d="${d}" stroke="${drawable.options.fill ?? "none"}" stroke-width="${weight}" fill="none"/>`,
            );
          }
        }
      }
      break;
    }
    case "freedraw": {
      const { svg } = getFreedrawStroke(element);
      if (svg) parts.push(`<path d="${svg}" fill="${element.strokeColor}"/>`);
      break;
    }
    case "text": {
      const text = element as TextElement;
      const lines = text.text.split("\n");
      const lineHeight = text.fontSize * text.lineHeight;
      const anchor =
        text.textAlign === "center" ? "middle" : text.textAlign === "right" ? "end" : "start";
      const anchorX =
        text.textAlign === "center"
          ? text.x + text.width / 2
          : text.textAlign === "right"
            ? text.x + text.width
            : text.x;
      const baseline = text.fontSize * 0.86 + (lineHeight - text.fontSize) / 2;
      lines.forEach((line, index) => {
        parts.push(
          `<text x="${anchorX}" y="${text.y + index * lineHeight + baseline}" font-family='${FONT_STACKS[text.fontFamily].replace(/"/g, "&quot;")}' font-size="${text.fontSize}px" letter-spacing="${text.letterSpacing ?? 0}px" fill="${text.strokeColor}" text-anchor="${anchor}" style="white-space:pre">${escapeXml(line)}</text>`,
        );
      });
      break;
    }
    case "image": {
      const fileId = (element as { fileId?: string | null }).fileId;
      const file = fileId ? files[fileId] : null;
      if (file) {
        parts.push(
          `<image x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" href="${file.dataURL}" preserveAspectRatio="none"/>`,
        );
      }
      break;
    }
    case "frame": {
      parts.push(
        `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" fill="none" stroke="#bbbbbb" stroke-width="2" rx="6"/>`,
      );
      break;
    }
  }

  if (!parts.length) return "";
  return `<g opacity="${opacity}"${transform}>${parts.join("")}</g>`;
}

export function exportToSvgString(
  elements: readonly AxElement[],
  files: BinaryFiles,
  options: ExportOptions,
): string {
  const list = visible(options.elements ?? elements);
  const padding = options.padding ?? EXPORT_PADDING;
  const bounds = getCommonBounds(list);
  const width = Math.max(1, Math.ceil(bounds.x2 - bounds.x1 + padding * 2));
  const height = Math.max(1, Math.ceil(bounds.y2 - bounds.y1 + padding * 2));
  const offsetX = -bounds.x1 + padding;
  const offsetY = -bounds.y1 + padding;

  const body = list.map((element) => elementToSvg(element, files)).join("\n");
  const background = options.exportBackground
    ? `<rect width="${width}" height="${height}" fill="${options.viewBackgroundColor}"/>`
    : "";
  const filter = options.theme === "dark" ? ` filter="${THEME_FILTER}"` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width * options.scale}" height="${height * options.scale}" viewBox="0 0 ${width} ${height}">
  <!-- Created with ${APP_NAME} -->
  <g${filter}>
    ${background}
    <g transform="translate(${offsetX} ${offsetY})">
${body}
    </g>
  </g>
</svg>`;
}

/* ------------------------------------------------------------------ *
 * Scene file
 * ------------------------------------------------------------------ */

export function serializeScene(
  elements: readonly AxElement[],
  files: BinaryFiles,
  appState: AppState,
): string {
  const data: SceneData = {
    type: "axdraw",
    version: SCENE_VERSION,
    source: APP_NAME,
    elements: visible(elements),
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridEnabled: appState.gridEnabled,
      theme: appState.theme,
    },
    files,
  };
  return JSON.stringify(data, null, 2);
}

export interface ParsedScene {
  elements: AxElement[];
  files: BinaryFiles;
  appState: Partial<AppState>;
}

/**
 * Fill in defaults and translate the numeric enums used by Excalidraw scene
 * files, so foreign scenes open without special-casing them later.
 */
export function normalizeImportedElement(raw: Record<string, unknown>): AxElement {
  const element = { ...raw } as Record<string, unknown>;

  if (typeof element.fontFamily === "number") {
    element.fontFamily = element.fontFamily === 2 ? "normal" : element.fontFamily === 3 ? "code" : "hand";
  }
  const roundness = element.roundness as { type?: unknown } | null | undefined;
  if (roundness && typeof roundness.type === "number") {
    element.roundness = { type: "round" };
  }
  if (element.roundness === undefined) element.roundness = null;

  element.id = String(element.id ?? Math.random().toString(36).slice(2));
  element.angle = Number(element.angle ?? 0);
  element.opacity = Number(element.opacity ?? 100);
  element.seed = Number(element.seed ?? Math.floor(Math.random() * 2 ** 31));
  element.version = Number(element.version ?? 1);
  element.groupIds = Array.isArray(element.groupIds) ? element.groupIds : [];
  element.boundElements = Array.isArray(element.boundElements) ? element.boundElements : null;
  element.frameId = (element.frameId as string | null) ?? null;
  element.locked = Boolean(element.locked);
  element.isDeleted = Boolean(element.isDeleted);
  element.link = (element.link as string | null) ?? null;
  element.updated = Number(element.updated ?? Date.now());
  element.strokeStyle = (element.strokeStyle as string) ?? "solid";
  element.fillStyle = (element.fillStyle as string) ?? "hachure";
  element.strokeWidth = Number(element.strokeWidth ?? 1);
  element.roughness = Number(element.roughness ?? 1);
  element.backgroundColor = (element.backgroundColor as string) ?? "transparent";
  element.strokeColor = (element.strokeColor as string) ?? "#1e1e1e";

  if (element.type === "freedraw") {
    element.pressures = Array.isArray(element.pressures) ? element.pressures : [];
    element.simulatePressure = element.simulatePressure !== false;
  }
  if (element.type === "arrow" || element.type === "line") {
    element.points = Array.isArray(element.points) ? element.points : [[0, 0]];
    element.startArrowhead = (element.startArrowhead as string) ?? "none";
    element.endArrowhead = (element.endArrowhead as string) ?? (element.type === "arrow" ? "arrow" : "none");
    element.elbowed = Boolean(element.elbowed);
    element.startBinding = (element.startBinding as unknown) ?? null;
    element.endBinding = (element.endBinding as unknown) ?? null;
  }
  if (element.type === "text") {
    element.text = String(element.text ?? "");
    element.originalText = String(element.originalText ?? element.text);
    element.fontSize = Number(element.fontSize ?? 20);
    element.textAlign = (element.textAlign as string) ?? "left";
    element.verticalAlign = (element.verticalAlign as string) ?? "top";
    element.containerId = (element.containerId as string | null) ?? null;
    element.lineHeight = Number(element.lineHeight ?? 1.25);
    element.letterSpacing = Number(element.letterSpacing ?? 0);
    element.autoResize = element.autoResize !== false;
  }
  if (element.type === "image") {
    element.scale = Array.isArray(element.scale) ? element.scale : [1, 1];
    element.status = (element.status as string) ?? "saved";
  }

  return element as unknown as AxElement;
}

/** Accepts our own files and Excalidraw scene files. */
export function parseScene(json: string): ParsedScene {
  const data = JSON.parse(json) as Partial<SceneData> & { type?: string };
  if (!data || !Array.isArray(data.elements)) {
    throw new Error("Not a valid scene file");
  }
  if (data.type && data.type !== "axdraw" && data.type !== "excalidraw") {
    throw new Error(`Unsupported scene type: ${data.type}`);
  }
  return {
    elements: (data.elements as unknown as Record<string, unknown>[]).map(normalizeImportedElement),
    files: (data.files as BinaryFiles) ?? {},
    appState: (data.appState as Partial<AppState>) ?? {},
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
