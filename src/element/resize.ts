/** Transform handles, resizing and rotation. */

import { HANDLE_HIT_RADIUS, HANDLE_SIZE, ROTATE_HANDLE_DISTANCE } from "../constants";
import type { AxElement, Bounds, Point, TextElement } from "../types";
import { getElementAbsoluteCoords, hasPoints, rotate } from "./bounds";
import { mutateElement } from "./factory";
import { measureText, wrapText } from "./text";

export type TransformHandleType =
  | "nw"
  | "ne"
  | "sw"
  | "se"
  | "n"
  | "s"
  | "e"
  | "w"
  | "rotation";

export interface TransformHandle {
  type: TransformHandleType;
  /** Centre in scene coordinates (already rotated with the element). */
  x: number;
  y: number;
}

export const CORNER_HANDLES: TransformHandleType[] = ["nw", "ne", "sw", "se"];

/**
 * Handle centres for a box. Side handles are omitted for boxes that are too
 * small to fit them, matching the way Excalidraw thins out its handles.
 */
export function getTransformHandles(
  bounds: Bounds,
  angle: number,
  zoom: number,
  options: { omitSides?: boolean; omitRotation?: boolean } = {},
): TransformHandle[] {
  const { x1, y1, x2, y2 } = bounds;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const width = x2 - x1;
  const height = y2 - y1;
  const handleSize = HANDLE_SIZE / zoom;

  const raw: [TransformHandleType, number, number][] = [
    ["nw", x1, y1],
    ["ne", x2, y1],
    ["sw", x1, y2],
    ["se", x2, y2],
  ];

  const sidesFit = width > handleSize * 4 && height > handleSize * 4;
  if (!options.omitSides && sidesFit) {
    raw.push(["n", cx, y1], ["s", cx, y2], ["w", x1, cy], ["e", x2, cy]);
  }
  if (!options.omitRotation) {
    raw.push(["rotation", cx, y1 - ROTATE_HANDLE_DISTANCE / zoom]);
  }

  return raw.map(([type, x, y]) => {
    const [rx, ry] = rotate(x, y, cx, cy, angle);
    return { type, x: rx, y: ry };
  });
}

/**
 * Find the transform handle under `point`.
 *
 * The grab area is deliberately larger than the drawn handle: an 8px square is
 * the right *look*, but aiming for a 14px box means the resize cursor never
 * appears when the pointer is visibly "on the corner". The hit radius is in
 * screen pixels (hence the zoom divide) so the target stays the same physical
 * size at every zoom level.
 *
 * Nearest handle wins. With a grab area this size the corner and side handles
 * of a small selection overlap, and picking the first match in array order
 * would hand back whichever happened to be pushed first.
 */
export function getHandleAtPosition(
  handles: TransformHandle[],
  point: Point,
  zoom: number,
  hitRadius = HANDLE_HIT_RADIUS,
): TransformHandle | null {
  const radius = hitRadius / zoom;
  let best: TransformHandle | null = null;
  let bestDistance = Infinity;
  for (const handle of handles) {
    const dx = Math.abs(handle.x - point.x);
    const dy = Math.abs(handle.y - point.y);
    if (dx > radius || dy > radius) continue;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = handle;
    }
  }
  return best;
}

export function getResizeCursor(type: TransformHandleType, angle: number): string {
  if (type === "rotation") return "grab";
  const base: Record<string, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const degrees = (base[type] + (angle * 180) / Math.PI + 360) % 360;
  const index = Math.round(degrees / 45) % 8;
  return ["ew", "nwse", "ns", "nesw", "ew", "nwse", "ns", "nesw"][index] + "-resize";
}

const MIN_SIZE = 1;

interface ResizeOptions {
  keepAspectRatio: boolean;
  fromCenter: boolean;
}

/** Resize a single element by dragging `handleType` to `pointer`. */
export function resizeSingleElement(
  element: AxElement,
  handleType: TransformHandleType,
  pointer: Point,
  options: ResizeOptions,
): void {
  const [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(element);
  // Work in the element's own (unrotated) frame.
  const [px, py] = rotate(pointer.x, pointer.y, cx, cy, -element.angle);

  let nx1 = x1;
  let ny1 = y1;
  let nx2 = x2;
  let ny2 = y2;

  if (handleType.includes("w")) nx1 = px;
  if (handleType.includes("e")) nx2 = px;
  if (handleType.includes("n")) ny1 = py;
  if (handleType.includes("s")) ny2 = py;

  if (options.fromCenter) {
    if (handleType.includes("w")) nx2 = x2 + (x1 - nx1);
    if (handleType.includes("e")) nx1 = x1 + (x2 - nx2);
    if (handleType.includes("n")) ny2 = y2 + (y1 - ny1);
    if (handleType.includes("s")) ny1 = y1 + (y2 - ny2);
  }

  let newWidth = nx2 - nx1;
  let newHeight = ny2 - ny1;

  const originalWidth = x2 - x1 || MIN_SIZE;
  const originalHeight = y2 - y1 || MIN_SIZE;
  const isCorner = CORNER_HANDLES.includes(handleType);
  const lockAspect = options.keepAspectRatio || element.type === "image" || element.type === "text";

  if (isCorner && lockAspect) {
    const ratio = originalWidth / originalHeight;
    if (Math.abs(newWidth) / Math.abs(newHeight || MIN_SIZE) > Math.abs(ratio)) {
      newWidth = Math.sign(newWidth) * Math.abs(newHeight) * Math.abs(ratio);
    } else {
      newHeight = (Math.sign(newHeight) * Math.abs(newWidth)) / Math.abs(ratio);
    }
    if (handleType.includes("w")) nx1 = nx2 - newWidth;
    else nx2 = nx1 + newWidth;
    if (handleType.includes("n")) ny1 = ny2 - newHeight;
    else ny2 = ny1 + newHeight;
  }

  // Flipping is allowed, but zero-size elements are not.
  if (Math.abs(newWidth) < MIN_SIZE) {
    newWidth = Math.sign(newWidth || 1) * MIN_SIZE;
    nx2 = nx1 + newWidth;
  }
  if (Math.abs(newHeight) < MIN_SIZE) {
    newHeight = Math.sign(newHeight || 1) * MIN_SIZE;
    ny2 = ny1 + newHeight;
  }

  const scaleX = newWidth / originalWidth;
  const scaleY = newHeight / originalHeight;

  // Keep the dragged box anchored in scene space despite the rotation.
  const newCenterLocal: Point = { x: (nx1 + nx2) / 2, y: (ny1 + ny2) / 2 };
  const [sceneCx, sceneCy] = rotate(newCenterLocal.x, newCenterLocal.y, cx, cy, element.angle);

  const absWidth = Math.abs(newWidth);
  const absHeight = Math.abs(newHeight);
  const updates: Partial<AxElement> = {
    x: sceneCx - absWidth / 2,
    y: sceneCy - absHeight / 2,
    width: absWidth,
    height: absHeight,
  };

  if (hasPoints(element)) {
    const flipX = scaleX < 0;
    const flipY = scaleY < 0;
    (updates as { points: [number, number][] }).points = element.points.map(([x, y]) => {
      const sx = x * Math.abs(scaleX);
      const sy = y * Math.abs(scaleY);
      return [flipX ? absWidth - sx : sx, flipY ? absHeight - sy : sy] as [number, number];
    });
  }

  if (element.type === "text") {
    const text = element as TextElement;
    if (isCorner) {
      const nextFontSize = Math.max(4, Math.round(text.fontSize * Math.abs(scaleY)));
      const metrics = measureText(text.text, nextFontSize, text.fontFamily, text.lineHeight);
      Object.assign(updates, { fontSize: nextFontSize, width: metrics.width, height: metrics.height });
    } else {
      // Side handles set an explicit wrap width.
      const wrapped = wrapText(text.originalText, text.fontSize, text.fontFamily, absWidth);
      const metrics = measureText(wrapped, text.fontSize, text.fontFamily, text.lineHeight);
      Object.assign(updates, { text: wrapped, autoResize: false, width: absWidth, height: metrics.height });
    }
  }

  mutateElement(element, updates as never);
}

/** Scale a group of elements inside a common bounding box. */
export function resizeMultipleElements(
  elements: readonly AxElement[],
  originalBounds: Bounds,
  handleType: TransformHandleType,
  pointer: Point,
  originalStates: Map<string, AxElement>,
  options: ResizeOptions,
): void {
  const { x1, y1, x2, y2 } = originalBounds;
  let nx1 = x1;
  let ny1 = y1;
  let nx2 = x2;
  let ny2 = y2;

  if (handleType.includes("w")) nx1 = pointer.x;
  if (handleType.includes("e")) nx2 = pointer.x;
  if (handleType.includes("n")) ny1 = pointer.y;
  if (handleType.includes("s")) ny2 = pointer.y;

  if (options.fromCenter) {
    if (handleType.includes("w")) nx2 = x2 + (x1 - nx1);
    if (handleType.includes("e")) nx1 = x1 + (x2 - nx2);
    if (handleType.includes("n")) ny2 = y2 + (y1 - ny1);
    if (handleType.includes("s")) ny1 = y1 + (y2 - ny2);
  }

  const originalWidth = Math.max(x2 - x1, MIN_SIZE);
  const originalHeight = Math.max(y2 - y1, MIN_SIZE);
  let scaleX = (nx2 - nx1) / originalWidth;
  let scaleY = (ny2 - ny1) / originalHeight;

  const isCorner = CORNER_HANDLES.includes(handleType);
  if (isCorner && options.keepAspectRatio) {
    const scale = Math.max(Math.abs(scaleX), Math.abs(scaleY));
    scaleX = Math.sign(scaleX || 1) * scale;
    scaleY = Math.sign(scaleY || 1) * scale;
  }
  if (!isCorner) {
    if (handleType === "n" || handleType === "s") scaleX = 1;
    if (handleType === "e" || handleType === "w") scaleY = 1;
  }

  scaleX = Math.abs(scaleX) < 0.01 ? Math.sign(scaleX || 1) * 0.01 : scaleX;
  scaleY = Math.abs(scaleY) < 0.01 ? Math.sign(scaleY || 1) * 0.01 : scaleY;

  const anchorX = handleType.includes("w") ? x2 : x1;
  const anchorY = handleType.includes("n") ? y2 : y1;

  for (const element of elements) {
    const original = originalStates.get(element.id);
    if (!original) continue;

    const width = original.width * Math.abs(scaleX);
    const height = original.height * Math.abs(scaleY);
    let x = anchorX + (original.x - anchorX) * scaleX;
    let y = anchorY + (original.y - anchorY) * scaleY;
    if (scaleX < 0) x -= width;
    if (scaleY < 0) y -= height;

    const updates: Partial<AxElement> = { x, y, width, height };

    if (hasPoints(original) && hasPoints(element)) {
      (updates as { points: [number, number][] }).points = original.points.map(([px, py]) => {
        const sx = px * Math.abs(scaleX);
        const sy = py * Math.abs(scaleY);
        return [scaleX < 0 ? width - sx : sx, scaleY < 0 ? height - sy : sy] as [number, number];
      });
    }

    if (original.type === "text") {
      const text = original as TextElement;
      const nextFontSize = Math.max(4, text.fontSize * Math.abs(scaleY));
      const metrics = measureText(text.text, nextFontSize, text.fontFamily, text.lineHeight);
      Object.assign(updates, { fontSize: nextFontSize, width: metrics.width, height: metrics.height });
    }

    mutateElement(element, updates as never);
  }
}

/** Rotate elements around `center` so the handle follows the pointer. */
export function rotateElements(
  elements: readonly AxElement[],
  originalStates: Map<string, AxElement>,
  center: Point,
  pointer: Point,
  startAngle: number,
  snap: boolean,
): void {
  let angle = Math.atan2(pointer.y - center.y, pointer.x - center.x) - startAngle;
  if (snap) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);

  for (const element of elements) {
    const original = originalStates.get(element.id);
    if (!original) continue;
    const originalCenter = {
      x: original.x + original.width / 2,
      y: original.y + original.height / 2,
    };
    const [cxRotated, cyRotated] = rotate(originalCenter.x, originalCenter.y, center.x, center.y, angle);
    mutateElement(element, {
      x: cxRotated - original.width / 2,
      y: cyRotated - original.height / 2,
      angle: normalizeAngle(original.angle + angle),
    });
  }
}

export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}
