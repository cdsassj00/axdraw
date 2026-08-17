import type { FontFamily, ItemStyle, Theme } from "./types";

export const APP_NAME = "axdraw";
/** Maker credit shown in the corner chip. */
export const CREDIT_LABEL = "made by shinsungjin · CDSA.kr";
export const CREDIT_URL = "https://cdsa.kr";
/** Set to a Buy Me a Coffee (or similar) URL to show the ☕ button; empty hides it. */
export const COFFEE_URL = "";
export const FILE_EXTENSION = ".axdraw";
export const STORAGE_KEY = "axdraw:scene";
export const STORAGE_STATE_KEY = "axdraw:state";
export const SCENE_VERSION = 1;

/* ---------------------------------------------------------------- *
 * Palettes (Open Color based, same spirit as Excalidraw's defaults)
 * ---------------------------------------------------------------- */

export const STROKE_COLORS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];

export const BACKGROUND_COLORS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];

export const CANVAS_COLORS = ["#faf7f2", "#ffffff", "#f8f9fa", "#f5faff", "#fffce8"];

/** Full picker palette: 15 hues × 5 shades, plus greys. */
export const EXTENDED_PALETTE: Record<string, string[]> = {
  Grey: ["#ffffff", "#f8f9fa", "#e9ecef", "#ced4da", "#adb5bd", "#868e96", "#495057", "#343a40", "#212529", "#1e1e1e"],
  Red: ["#fff5f5", "#ffe3e3", "#ffc9c9", "#ffa8a8", "#ff8787", "#ff6b6b", "#fa5252", "#f03e3e", "#e03131", "#c92a2a"],
  Pink: ["#fff0f6", "#ffdeeb", "#fcc2d7", "#faa2c1", "#f783ac", "#f06595", "#e64980", "#d6336c", "#c2255c", "#a61e4d"],
  Grape: ["#f8f0fc", "#f3d9fa", "#eebefa", "#e599f7", "#da77f2", "#cc5de8", "#be4bdb", "#ae3ec9", "#9c36b5", "#862e9c"],
  Violet: ["#f3f0ff", "#e5dbff", "#d0bfff", "#b197fc", "#9775fa", "#845ef7", "#7950f2", "#7048e8", "#6741d9", "#5f3dc4"],
  Indigo: ["#edf2ff", "#dbe4ff", "#bac8ff", "#91a7ff", "#748ffc", "#5c7cfa", "#4c6ef5", "#4263eb", "#3b5bdb", "#364fc7"],
  Blue: ["#e7f5ff", "#d0ebff", "#a5d8ff", "#74c0fc", "#4dabf7", "#339af0", "#228be6", "#1c7ed6", "#1971c2", "#1864ab"],
  Cyan: ["#e3fafc", "#c5f6fa", "#99e9f2", "#66d9e8", "#3bc9db", "#22b8cf", "#15aabf", "#1098ad", "#0c8599", "#0b7285"],
  Teal: ["#e6fcf5", "#c3fae8", "#96f2d7", "#63e6be", "#38d9a9", "#20c997", "#12b886", "#0ca678", "#099268", "#087f5b"],
  Green: ["#ebfbee", "#d3f9d8", "#b2f2bb", "#8ce99a", "#69db7c", "#51cf66", "#40c057", "#37b24d", "#2f9e44", "#2b8a3e"],
  Lime: ["#f4fce3", "#e9fac8", "#d8f5a2", "#c0eb75", "#a9e34b", "#94d82d", "#82c91e", "#74b816", "#66a80f", "#5c940d"],
  Yellow: ["#fff9db", "#fff3bf", "#ffec99", "#ffe066", "#ffd43b", "#fcc419", "#fab005", "#f59f00", "#f08c00", "#e67700"],
  Orange: ["#fff4e6", "#ffe8cc", "#ffd8a8", "#ffc078", "#ffa94d", "#ff922b", "#fd7e14", "#f76707", "#e8590c", "#d9480f"],
};

/* ---------------------------------------------------------------- *
 * Style scales
 * ---------------------------------------------------------------- */

export const STROKE_WIDTHS = { thin: 1, bold: 2, extraBold: 4 } as const;
export const ROUGHNESS = { architect: 0, artist: 1, cartoonist: 2 } as const;
export const FONT_SIZES = { S: 16, M: 20, L: 28, XL: 36 } as const;

/**
 * Font stacks. "hand" leads with the two bundled handwriting families — Caveat
 * for Latin, Gaegu for Hangul — so the sketchy look is identical on every
 * machine, with system handwriting fonts as a fallback.
 */
export const FONT_STACKS: Record<FontFamily, string> = {
  hand: 'Caveat, Gaegu, "Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive',
  normal:
    '"Helvetica Neue", Helvetica, Arial, "Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  code: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, "D2Coding", "Nanum Gothic Coding", monospace',
  /* Free web fonts, loaded from CDN in index.html (display=swap, so text
     renders in the fallback until they arrive). */
  pretendard: '"Pretendard Variable", Pretendard, "Noto Sans KR", "Malgun Gothic", sans-serif',
  noto: '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  serif: '"Noto Serif KR", "Nanum Myeongjo", Batang, Georgia, serif',
};

/** Families that must be loaded before text can be measured accurately. */
export const BUNDLED_FONTS: { family: string; sample: string }[] = [
  { family: "Caveat", sample: "Aa" },
  { family: "Gaegu", sample: "가나" },
];

export const DEFAULT_LINE_HEIGHT = 1.25;

/** Corner radius model — proportional for small shapes, capped for big ones. */
export const ROUNDNESS_PROPORTION = 0.25;
export const ROUNDNESS_MAX_RADIUS = 32;

export const DEFAULT_STYLE: ItemStyle = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "hachure",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness: { type: "round" },
  fontSize: 20,
  fontFamily: "hand",
  textAlign: "left",
  startArrowhead: "none",
  endArrowhead: "arrow",
  elbowed: false,
};

/* ---------------------------------------------------------------- *
 * Interaction tuning
 * ---------------------------------------------------------------- */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;
export const DEFAULT_GRID_SIZE = 20;
/** Pointer slop (px) before a click becomes a drag. */
export const DRAG_THRESHOLD = 3;
/** Hit-test tolerance in screen px. */
export const HIT_THRESHOLD = 10;
/** Side of the drawn transform handle, in screen px. */
export const HANDLE_SIZE = 8;
/**
 * Half-side of the *grab* area around a transform handle, in screen px. Larger
 * than the drawn handle on purpose: 12 gives a 24px target, the WCAG 2.2
 * minimum, so the resize cursor shows up wherever the corner looks grabbable.
 */
export const HANDLE_HIT_RADIUS = 12;
/** Grab area for coarse pointers (touch, pen), which land far less precisely. */
export const HANDLE_HIT_RADIUS_COARSE = 20;
export const ROTATE_HANDLE_DISTANCE = 20;
export const LINE_CONFIRM_THRESHOLD = 8;
export const MAX_BINDING_GAP = 32;
export const SNAP_DISTANCE = 6;
export const ANGLE_SNAP = Math.PI / 12; // 15°
export const TEXT_CONTAINER_PADDING = 5;
export const LASER_TRAIL_MS = 1100;
export const ELEMENT_TRANSLATE_AMOUNT = 1;
export const EXPORT_PADDING = 10;

export const THEME_FILTER = "invert(93%) hue-rotate(180deg)";

/**
 * The canvas ground. Warm off-white rather than pure white: the strokes are
 * sketchy and the type is handwriting, and both sit better on paper than on a
 * lightbox. Pure white is still one click away in the canvas colour picker.
 */
export const CANVAS_BACKGROUND_BY_THEME: Record<Theme, string> = {
  light: "#faf7f2",
  dark: "#1a1715",
};
