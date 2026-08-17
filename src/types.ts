/** The scene data model and editor state. */

export type ShapeType =
  | "rectangle"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "image"
  | "frame";

export type ToolType =
  | ShapeType
  | "selection"
  | "hand"
  | "eraser"
  | "laser";

export type FillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type StrokeStyle = "solid" | "dashed" | "dotted";
export type FontFamily = "hand" | "normal" | "code" | "pretendard" | "noto" | "serif";
export type TextAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";
export type Arrowhead = "none" | "arrow" | "triangle" | "triangle-outline" | "dot" | "bar" | "diamond";
export type Roundness = null | { type: "sharp" | "round" };

export interface Binding {
  elementId: string;
  /** Where along the bound element's edge the arrow points, in [-1, 1]. */
  focus: number;
  /** Distance kept between the arrow tip and the bound shape. */
  gap: number;
}

export interface BoundElement {
  id: string;
  type: "text" | "arrow";
}

export interface BaseElement {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness: number;
  opacity: number;
  roundness: Roundness;
  seed: number;
  version: number;
  groupIds: string[];
  frameId: string | null;
  boundElements: BoundElement[] | null;
  locked: boolean;
  isDeleted: boolean;
  link: string | null;
  updated: number;
}

export interface RectangleElement extends BaseElement {
  type: "rectangle";
}
export interface DiamondElement extends BaseElement {
  type: "diamond";
}
export interface EllipseElement extends BaseElement {
  type: "ellipse";
}
export interface FrameElement extends BaseElement {
  type: "frame";
  name: string | null;
}

export interface LinearElement extends BaseElement {
  type: "line" | "arrow";
  /** Points relative to (x, y). The first point is always [0, 0]. */
  points: [number, number][];
  startBinding: Binding | null;
  endBinding: Binding | null;
  startArrowhead: Arrowhead;
  endArrowhead: Arrowhead;
  /** Elbow arrows route with right angles instead of straight segments. */
  elbowed: boolean;
}

export interface FreedrawElement extends BaseElement {
  type: "freedraw";
  points: [number, number][];
  pressures: number[];
  simulatePressure: boolean;
}

export interface TextElement extends BaseElement {
  type: "text";
  text: string;
  originalText: string;
  fontSize: number;
  fontFamily: FontFamily;
  textAlign: TextAlign;
  verticalAlign: VerticalAlign;
  containerId: string | null;
  lineHeight: number;
  letterSpacing: number;
  autoResize: boolean;
}

export interface ImageElement extends BaseElement {
  type: "image";
  fileId: string | null;
  scale: [number, number];
  status: "pending" | "saved" | "error";
}

export type AxElement =
  | RectangleElement
  | DiamondElement
  | EllipseElement
  | FrameElement
  | LinearElement
  | FreedrawElement
  | TextElement
  | ImageElement;

export interface BinaryFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
  /** Original filename — set for non-image attachments shown as file cards. */
  name?: string;
  /** Size in bytes, shown on the file card. */
  size?: number;
}

export type BinaryFiles = Record<string, BinaryFile>;

export interface ItemStyle {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness: number;
  opacity: number;
  roundness: Roundness;
  fontSize: number;
  fontFamily: FontFamily;
  textAlign: TextAlign;
  lineHeight: number;
  letterSpacing: number;
  startArrowhead: Arrowhead;
  endArrowhead: Arrowhead;
  elbowed: boolean;
}

export type Theme = "light" | "dark";

export interface AppState {
  tool: ToolType;
  /** Keep the active tool after drawing instead of falling back to selection. */
  toolLocked: boolean;
  scrollX: number;
  scrollY: number;
  zoom: number;
  theme: Theme;
  viewBackgroundColor: string;
  gridEnabled: boolean;
  gridSize: number;
  snapEnabled: boolean;
  /** Convert rough freehand strokes into clean shapes. */
  shapeRecognition: boolean;
  zenMode: boolean;
  viewMode: boolean;
  statsEnabled: boolean;
  selectedIds: Set<string>;
  editingTextId: string | null;
  currentStyle: ItemStyle;
}

export interface SceneData {
  type: "axdraw";
  version: number;
  source: string;
  elements: AxElement[];
  appState: Partial<AppState> & { viewBackgroundColor?: string };
  files: BinaryFiles;
}

/** A point in scene coordinates. */
export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A reading of a freehand stroke the user can switch to after shape assist. */
export type RecognitionChoiceType = "rectangle" | "ellipse" | "diamond" | "freedraw";

export interface RecognitionChoiceOption {
  type: RecognitionChoiceType;
  label: string;
}

/**
 * State behind the "did you mean" chip: what shape assist landed on, the
 * original stroke so freehand stays reachable, and the fitted box the
 * alternates are drawn into.
 */
export interface RecognitionChoice {
  elementId: string;
  original: FreedrawElement;
  frame: { cx: number; cy: number; width: number; height: number; angle: number };
  options: RecognitionChoiceOption[];
  active: RecognitionChoiceType;
}
