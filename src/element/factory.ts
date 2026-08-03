/** Element construction and mutation. */

import { DEFAULT_LINE_HEIGHT } from "../constants";
import type {
  AxElement,
  FreedrawElement,
  FrameElement,
  ImageElement,
  ItemStyle,
  LinearElement,
  ShapeType,
  TextElement,
} from "../types";
import { randomId, randomSeed } from "../utils/random";
import { invalidateShape } from "./shapes";
import { measureText } from "./text";

interface BaseOptions {
  x: number;
  y: number;
  width?: number;
  height?: number;
  style: ItemStyle;
  angle?: number;
  groupIds?: string[];
}

function base(type: ShapeType, options: BaseOptions) {
  const { style } = options;
  return {
    id: randomId(),
    type,
    x: options.x,
    y: options.y,
    width: options.width ?? 0,
    height: options.height ?? 0,
    angle: options.angle ?? 0,
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    roughness: style.roughness,
    opacity: style.opacity,
    roundness: style.roundness,
    seed: randomSeed(),
    version: 1,
    groupIds: options.groupIds ?? [],
    frameId: null,
    boundElements: null,
    locked: false,
    isDeleted: false,
    link: null,
    updated: Date.now(),
  };
}

export function newShapeElement(
  type: "rectangle" | "diamond" | "ellipse",
  options: BaseOptions,
): AxElement {
  return { ...base(type, options), type } as AxElement;
}

export function newFrameElement(options: BaseOptions): FrameElement {
  return {
    ...base("frame", options),
    type: "frame",
    name: null,
    backgroundColor: "transparent",
    roundness: { type: "sharp" },
    roughness: 0,
    strokeColor: "#bbb",
  } as FrameElement;
}

export function newLinearElement(
  type: "line" | "arrow",
  options: BaseOptions & { points?: [number, number][] },
): LinearElement {
  const style = options.style;
  return {
    ...base(type, options),
    type,
    points: options.points ?? [[0, 0]],
    startBinding: null,
    endBinding: null,
    startArrowhead: type === "arrow" ? style.startArrowhead : "none",
    endArrowhead: type === "arrow" ? style.endArrowhead : "none",
    elbowed: type === "arrow" ? style.elbowed : false,
  } as LinearElement;
}

export function newFreedrawElement(
  options: BaseOptions & { simulatePressure: boolean },
): FreedrawElement {
  return {
    ...base("freedraw", options),
    type: "freedraw",
    points: [[0, 0]],
    pressures: [],
    simulatePressure: options.simulatePressure,
    backgroundColor: "transparent",
  } as FreedrawElement;
}

export function newTextElement(
  options: BaseOptions & {
    text: string;
    containerId?: string | null;
    verticalAlign?: TextElement["verticalAlign"];
    autoResize?: boolean;
  },
): TextElement {
  const { style } = options;
  const metrics = measureText(options.text, style.fontSize, style.fontFamily, DEFAULT_LINE_HEIGHT);
  return {
    ...base("text", options),
    type: "text",
    text: options.text,
    originalText: options.text,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    textAlign: style.textAlign,
    verticalAlign: options.verticalAlign ?? "top",
    containerId: options.containerId ?? null,
    lineHeight: DEFAULT_LINE_HEIGHT,
    autoResize: options.autoResize ?? true,
    width: options.width ?? metrics.width,
    height: options.height ?? metrics.height,
    backgroundColor: "transparent",
  } as TextElement;
}

export function newImageElement(
  options: BaseOptions & { fileId: string | null },
): ImageElement {
  return {
    ...base("image", options),
    type: "image",
    fileId: options.fileId,
    scale: [1, 1],
    status: options.fileId ? "saved" : "pending",
    backgroundColor: "transparent",
    strokeColor: "transparent",
  } as ImageElement;
}

/** Apply updates in place, bumping the version so caches invalidate. */
export function mutateElement<T extends AxElement>(element: T, updates: Partial<T>): T {
  Object.assign(element, updates);
  element.version += 1;
  element.updated = Date.now();
  invalidateShape(element.id);
  return element;
}

export function duplicateElement<T extends AxElement>(element: T, offset = { x: 10, y: 10 }): T {
  const copy = structuredClone(element) as T;
  copy.id = randomId();
  copy.x += offset.x;
  copy.y += offset.y;
  copy.seed = randomSeed();
  copy.version = 1;
  copy.updated = Date.now();
  copy.boundElements = null;
  return copy;
}
