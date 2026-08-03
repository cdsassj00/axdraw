/**
 * Geometry primitives shared by the hand-drawn generator and the renderers.
 *
 * The generator never touches a canvas: it emits `OpSet`s (lists of move /
 * line / cubic commands) which both the canvas renderer and the SVG exporter
 * replay. That keeps rendering deterministic and lets us cache the expensive
 * part (geometry generation) per element version.
 */

export type Point = [number, number];

export type Op =
  | { op: "move"; data: [number, number] }
  | { op: "lineTo"; data: [number, number] }
  | { op: "bcurveTo"; data: [number, number, number, number, number, number] };

export type OpSetType = "path" | "fillPath" | "fillSketch";

export interface OpSet {
  type: OpSetType;
  ops: Op[];
}

export interface Drawable {
  shape: string;
  sets: OpSet[];
  options: ResolvedOptions;
}

export type FillStyle =
  | "hachure"
  | "cross-hatch"
  | "solid"
  | "zigzag"
  | "dots"
  | "dashed";

export interface RoughOptions {
  seed?: number;
  roughness?: number;
  bowing?: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string | null;
  fillStyle?: FillStyle;
  fillWeight?: number;
  hachureAngle?: number;
  hachureGap?: number;
  curveFitting?: number;
  curveTightness?: number;
  curveStepCount?: number;
  maxRandomnessOffset?: number;
  disableMultiStroke?: boolean;
  disableMultiStrokeFill?: boolean;
  preserveVertices?: boolean;
  dashOffset?: number;
  dashGap?: number;
  zigzagOffset?: number;
}

export interface ResolvedOptions extends Required<Omit<RoughOptions, "fill">> {
  fill: string | null;
  /** Seeded random source, injected by the generator. */
  random: () => number;
}

export const DEFAULT_OPTIONS: Omit<ResolvedOptions, "random"> = {
  seed: 1,
  roughness: 1,
  bowing: 1,
  stroke: "#1e1e1e",
  strokeWidth: 1,
  fill: null,
  fillStyle: "hachure",
  fillWeight: -1,
  hachureAngle: -41,
  hachureGap: -1,
  curveFitting: 0.95,
  curveTightness: 0,
  curveStepCount: 9,
  maxRandomnessOffset: 2,
  disableMultiStroke: false,
  disableMultiStrokeFill: false,
  preserveVertices: false,
  dashOffset: -1,
  dashGap: -1,
  zigzagOffset: -1,
};
