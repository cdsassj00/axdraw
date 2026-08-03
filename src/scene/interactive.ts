/** Selection UI, handles, guides and the laser pointer. */

import { HANDLE_SIZE, LASER_TRAIL_MS } from "../constants";
import { getElementAbsoluteCoords, getElementBounds, rotate } from "../element/bounds";
import type { TransformHandle } from "../element/resize";
import type { AxElement, Bounds, LinearElement, Theme } from "../types";
import type { Viewport } from "./renderer";

export interface SnapLine {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface LaserPoint {
  x: number;
  y: number;
  time: number;
}

export interface InteractiveState {
  elements: readonly AxElement[];
  selectedIds: Set<string>;
  viewport: Viewport;
  devicePixelRatio: number;
  theme: Theme;
  marquee: Bounds | null;
  handles: TransformHandle[];
  selectionBounds: Bounds | null;
  selectionAngle: number;
  editingLinear: LinearElement | null;
  editingLinearPointIndex: number | null;
  bindingHighlightId: string | null;
  snapLines: SnapLine[];
  laserPoints: LaserPoint[];
  hoveredElementId: string | null;
}

const ACCENT = "#6965db";
const ACCENT_SOFT = "rgba(105, 101, 219, 0.5)";

export function renderInteractiveScene(canvas: HTMLCanvasElement, state: InteractiveState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { viewport, devicePixelRatio: dpr } = state;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = dpr * viewport.zoom;
  ctx.setTransform(scale, 0, 0, scale, viewport.scrollX * scale, viewport.scrollY * scale);

  const px = 1 / viewport.zoom;

  // Binding target highlight.
  if (state.bindingHighlightId) {
    const target = state.elements.find((element) => element.id === state.bindingHighlightId);
    if (target) {
      const [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(target);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(target.angle);
      ctx.translate(-cx, -cy);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([]);
      const pad = 4 * px;
      ctx.strokeRect(x1 - pad, y1 - pad, x2 - x1 + pad * 2, y2 - y1 + pad * 2);
      ctx.restore();
    }
  }

  // Hover outline (selection tool, nothing selected yet).
  if (state.hoveredElementId && !state.selectedIds.has(state.hoveredElementId)) {
    const hovered = state.elements.find((element) => element.id === state.hoveredElementId);
    if (hovered) {
      drawElementOutline(ctx, hovered, px, "rgba(105, 101, 219, 0.28)", 1);
    }
  }

  // Per-element outlines.
  if (state.selectedIds.size > 0) {
    for (const element of state.elements) {
      if (!state.selectedIds.has(element.id) || element.isDeleted) continue;
      drawElementOutline(ctx, element, px, ACCENT_SOFT, 1);
    }
  }

  // Common bounding box + handles.
  if (state.selectionBounds) {
    const b = state.selectionBounds;
    const cx = (b.x1 + b.x2) / 2;
    const cy = (b.y1 + b.y2) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(state.selectionAngle);
    ctx.translate(-cx, -cy);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = px;
    ctx.setLineDash([]);
    ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
    ctx.restore();
  }

  for (const handle of state.handles) {
    drawHandle(ctx, handle, state.selectionAngle, viewport.zoom);
  }

  // Linear element editor points.
  if (state.editingLinear) {
    const element = state.editingLinear;
    const cx = element.x + element.width / 2;
    const cy = element.y + element.height / 2;
    element.points.forEach(([lx, ly], index) => {
      const [x, y] = rotate(element.x + lx, element.y + ly, cx, cy, element.angle);
      const radius = (index === state.editingLinearPointIndex ? 6 : 5) * px;
      ctx.beginPath();
      ctx.fillStyle = index === state.editingLinearPointIndex ? ACCENT : "#ffffff";
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5 * px;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    // Midpoint hints for adding new points.
    for (let i = 0; i < element.points.length - 1; i++) {
      const [x1, y1] = element.points[i];
      const [x2, y2] = element.points[i + 1];
      const [mx, my] = rotate(element.x + (x1 + x2) / 2, element.y + (y1 + y2) / 2, cx, cy, element.angle);
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.strokeStyle = ACCENT_SOFT;
      ctx.lineWidth = px;
      ctx.arc(mx, my, 3 * px, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Marquee.
  if (state.marquee) {
    const { x1, y1, x2, y2 } = state.marquee;
    ctx.save();
    ctx.fillStyle = "rgba(105, 101, 219, 0.10)";
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = px;
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.restore();
  }

  // Snap guides.
  if (state.snapLines.length) {
    ctx.save();
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = px;
    ctx.setLineDash([]);
    for (const line of state.snapLines) {
      ctx.beginPath();
      ctx.moveTo(line.from.x, line.from.y);
      ctx.lineTo(line.to.x, line.to.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Laser trail.
  if (state.laserPoints.length > 1) {
    const now = performance.now();
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < state.laserPoints.length; i++) {
      const point = state.laserPoints[i];
      const previous = state.laserPoints[i - 1];
      const age = (now - point.time) / LASER_TRAIL_MS;
      if (age >= 1) continue;
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = "#ff2d2d";
      ctx.lineWidth = (10 - age * 6) * px;
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawElementOutline(
  ctx: CanvasRenderingContext2D,
  element: AxElement,
  px: number,
  color: string,
  lineWidth: number,
): void {
  const [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(element);
  const pad = 4 * px;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(element.angle);
  ctx.translate(-cx, -cy);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth * px;
  ctx.setLineDash([4 * px, 4 * px]);
  ctx.strokeRect(x1 - pad, y1 - pad, x2 - x1 + pad * 2, y2 - y1 + pad * 2);
  ctx.restore();
}

function drawHandle(
  ctx: CanvasRenderingContext2D,
  handle: TransformHandle,
  angle: number,
  zoom: number,
): void {
  const size = HANDLE_SIZE / zoom;
  ctx.save();
  ctx.translate(handle.x, handle.y);
  ctx.rotate(angle);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1 / zoom;
  if (handle.type === "rotation") {
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.roundRect(-size / 2, -size / 2, size, size, 2 / zoom);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Bounds of the current selection (union of rotated element bounds). */
export function getSelectionBounds(elements: readonly AxElement[]): Bounds | null {
  if (!elements.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const element of elements) {
    const b = getElementBounds(element);
    x1 = Math.min(x1, b.x1);
    y1 = Math.min(y1, b.y1);
    x2 = Math.max(x2, b.x2);
    y2 = Math.max(y2, b.y2);
  }
  return { x1, y1, x2, y2 };
}
