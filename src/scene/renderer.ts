/**
 * Canvas rendering.
 *
 * The scene is painted on two stacked canvases, like Excalidraw: a *static*
 * canvas holding the elements (repainted only when the scene or viewport
 * changes) and an *interactive* canvas holding selection UI, snap guides and
 * the laser pointer (repainted freely, it is cheap).
 */

import { THEME_FILTER } from "../constants";
import { getElementBounds, getElementCenter } from "../element/bounds";
import { getElementShape, getFreedrawStroke } from "../element/shapes";
import { getFontString } from "../element/text";
import { draw as drawRough } from "../rough/render";
import type { AxElement, BinaryFiles, TextElement, Theme } from "../types";
import { drawFileCard } from "../element/filecard";
import { ensureImage, getCachedImage } from "./images";

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
}

export interface StaticRenderConfig extends Viewport {
  theme: Theme;
  viewBackgroundColor: string;
  gridEnabled: boolean;
  gridSize: number;
  devicePixelRatio: number;
  onImageLoad?: () => void;
}

export function screenToScene(x: number, y: number, viewport: Viewport): { x: number; y: number } {
  return { x: x / viewport.zoom - viewport.scrollX, y: y / viewport.zoom - viewport.scrollY };
}

function applyViewport(ctx: CanvasRenderingContext2D, config: StaticRenderConfig): void {
  const scale = config.devicePixelRatio * config.zoom;
  ctx.setTransform(
    scale,
    0,
    0,
    scale,
    config.scrollX * scale,
    config.scrollY * scale,
  );
}

function drawGrid(ctx: CanvasRenderingContext2D, config: StaticRenderConfig): void {
  const { gridSize, zoom } = config;
  if (gridSize * zoom < 4) return;

  const left = -config.scrollX;
  const top = -config.scrollY;
  const right = left + config.width / zoom;
  const bottom = top + config.height / zoom;

  const startX = Math.floor(left / gridSize) * gridSize;
  const startY = Math.floor(top / gridSize) * gridSize;

  ctx.save();
  ctx.lineWidth = 1 / zoom;
  for (let x = startX; x <= right; x += gridSize) {
    ctx.strokeStyle = Math.round(x / gridSize) % 5 === 0 ? "rgba(0,0,0,0.12)" : "rgba(0,0,0,0.05)";
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let y = startY; y <= bottom; y += gridSize) {
    ctx.strokeStyle = Math.round(y / gridSize) % 5 === 0 ? "rgba(0,0,0,0.12)" : "rgba(0,0,0,0.05)";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw one element in scene coordinates (caller has set up the viewport). */
export function renderElement(
  ctx: CanvasRenderingContext2D,
  element: AxElement,
  files: BinaryFiles,
  onImageLoad?: () => void,
): void {
  if (element.isDeleted) return;

  ctx.save();
  ctx.globalAlpha = element.opacity / 100;

  if (element.angle) {
    const center = getElementCenter(element);
    ctx.translate(center.x, center.y);
    ctx.rotate(element.angle);
    ctx.translate(-center.x, -center.y);
  }

  switch (element.type) {
    case "rectangle":
    case "diamond":
    case "ellipse":
    case "line":
    case "arrow": {
      const shape = getElementShape(element);
      if (shape) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (shape.lineDash) ctx.setLineDash(shape.lineDash);
        for (const drawable of shape.drawables) drawRough(ctx, drawable);
        ctx.setLineDash([]);
      }
      break;
    }
    case "freedraw": {
      const { path } = getFreedrawStroke(element);
      if (element.backgroundColor !== "transparent") {
        ctx.fillStyle = element.backgroundColor;
        const shapePath = new Path2D();
        const points = element.points;
        if (points.length > 1) {
          shapePath.moveTo(element.x + points[0][0], element.y + points[0][1]);
          for (const [px, py] of points.slice(1)) shapePath.lineTo(element.x + px, element.y + py);
          shapePath.closePath();
          ctx.fill(shapePath);
        }
      }
      ctx.fillStyle = element.strokeColor;
      ctx.fill(path);
      break;
    }
    case "text": {
      renderText(ctx, element as TextElement);
      break;
    }
    case "image": {
      renderImage(ctx, element, files, onImageLoad);
      break;
    }
    case "frame": {
      ctx.strokeStyle = "#bbbbbb";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      roundRectPath(ctx, element.x, element.y, element.width, element.height, 6);
      ctx.stroke();
      const name = (element as { name?: string | null }).name || "Frame";
      ctx.fillStyle = "#888888";
      ctx.font = "14px sans-serif";
      ctx.textBaseline = "bottom";
      ctx.fillText(name, element.x + 2, element.y - 6);
      break;
    }
  }

  ctx.restore();
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function renderText(ctx: CanvasRenderingContext2D, element: TextElement): void {
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${element.letterSpacing ?? 0}px`;
  const lines = element.text.split("\n");
  const lineHeight = element.fontSize * element.lineHeight;
  ctx.font = getFontString(element.fontSize, element.fontFamily);
  ctx.fillStyle = element.strokeColor;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = element.textAlign === "center" ? "center" : element.textAlign === "right" ? "right" : "left";

  const anchorX =
    element.textAlign === "center"
      ? element.x + element.width / 2
      : element.textAlign === "right"
        ? element.x + element.width
        : element.x;

  // Approximate the ascender so lines sit inside the element box.
  const baselineOffset = element.fontSize * 0.86 + (lineHeight - element.fontSize) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], anchorX, element.y + i * lineHeight + baselineOffset);
  }
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
}

function renderImage(
  ctx: CanvasRenderingContext2D,
  element: AxElement,
  files: BinaryFiles,
  onImageLoad?: () => void,
): void {
  const fileId = (element as { fileId?: string | null }).fileId;
  if (!fileId) return;
  const file = files[fileId];
  if (file && !file.mimeType.startsWith("image/")) {
    drawFileCard(ctx, element, file);
    return;
  }
  const image = getCachedImage(fileId);
  if (!image) {
    if (onImageLoad) ensureImage(fileId, files, onImageLoad);
    ctx.fillStyle = "rgba(0,0,0,0.06)";
    ctx.fillRect(element.x, element.y, element.width, element.height);
    return;
  }
  ctx.drawImage(image, element.x, element.y, element.width, element.height);
}

let offscreen: HTMLCanvasElement | null = null;

/** Repaint the element canvas. */
export function renderStaticScene(
  canvas: HTMLCanvasElement,
  elements: readonly AxElement[],
  files: BinaryFiles,
  config: StaticRenderConfig,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const paint = (target: CanvasRenderingContext2D) => {
    // The background is painted inside the filtered pass so that dark mode
    // inverts it along with the drawing, exactly like the elements.
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.fillStyle = config.viewBackgroundColor;
    target.fillRect(0, 0, canvas.width, canvas.height);
    applyViewport(target, config);
    if (config.gridEnabled) drawGrid(target, config);
    // Viewport culling: with thousands of elements, painting only what is on
    // screen is the difference between a laggy canvas and a smooth one. The
    // margin absorbs the sketchy renderer's overshoot past exact bounds.
    const margin = 100;
    const left = -config.scrollX - margin;
    const top = -config.scrollY - margin;
    const right = -config.scrollX + config.width / config.zoom + margin;
    const bottom = -config.scrollY + config.height / config.zoom + margin;
    for (const element of elements) {
      if (element.isDeleted) continue;
      const bounds = getElementBounds(element);
      if (bounds.x2 < left || bounds.x1 > right || bounds.y2 < top || bounds.y1 > bottom) continue;
      renderElement(target, element, files, config.onImageLoad);
    }
  };

  if (config.theme === "dark") {
    // One filtered composite per frame beats filtering every stroke.
    if (!offscreen) offscreen = document.createElement("canvas");
    if (offscreen.width !== canvas.width || offscreen.height !== canvas.height) {
      offscreen.width = canvas.width;
      offscreen.height = canvas.height;
    }
    const offCtx = offscreen.getContext("2d")!;
    offCtx.setTransform(1, 0, 0, 1, 0, 0);
    offCtx.clearRect(0, 0, offscreen.width, offscreen.height);
    paint(offCtx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = THEME_FILTER;
    ctx.drawImage(offscreen, 0, 0);
    ctx.filter = "none";
  } else {
    paint(ctx);
  }
}
