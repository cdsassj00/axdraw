/**
 * Replays generated op-sets onto a 2D canvas context, or into an SVG path
 * string for export. Both consumers share the same geometry, so what you see
 * is exactly what you export.
 */

import type { Drawable, Op, OpSet } from "./types";

export function opsToPath(ops: Op[]): string {
  const parts: string[] = [];
  for (const item of ops) {
    switch (item.op) {
      case "move":
        parts.push(`M${round(item.data[0])} ${round(item.data[1])}`);
        break;
      case "lineTo":
        parts.push(`L${round(item.data[0])} ${round(item.data[1])}`);
        break;
      case "bcurveTo":
        parts.push(
          `C${round(item.data[0])} ${round(item.data[1])}, ${round(item.data[2])} ${round(
            item.data[3],
          )}, ${round(item.data[4])} ${round(item.data[5])}`,
        );
        break;
    }
  }
  return parts.join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function applyOps(ctx: CanvasRenderingContext2D, ops: Op[]): void {
  ctx.beginPath();
  for (const item of ops) {
    switch (item.op) {
      case "move":
        ctx.moveTo(item.data[0], item.data[1]);
        break;
      case "lineTo":
        ctx.lineTo(item.data[0], item.data[1]);
        break;
      case "bcurveTo":
        ctx.bezierCurveTo(
          item.data[0],
          item.data[1],
          item.data[2],
          item.data[3],
          item.data[4],
          item.data[5],
        );
        break;
    }
  }
}

export function drawOpSet(
  ctx: CanvasRenderingContext2D,
  set: OpSet,
  drawable: Drawable,
): void {
  const o = drawable.options;
  switch (set.type) {
    case "path":
      ctx.save();
      ctx.strokeStyle = o.stroke === "none" ? "transparent" : o.stroke;
      ctx.lineWidth = o.strokeWidth;
      applyOps(ctx, set.ops);
      ctx.stroke();
      ctx.restore();
      break;
    case "fillPath":
      ctx.save();
      ctx.fillStyle = o.fill || "transparent";
      applyOps(ctx, set.ops);
      ctx.fill(drawable.shape === "curve" || drawable.shape === "closedCurve" ? "evenodd" : "nonzero");
      ctx.restore();
      break;
    case "fillSketch": {
      ctx.save();
      let fweight = o.fillWeight;
      if (fweight < 0) fweight = o.strokeWidth / 2;
      ctx.strokeStyle = o.fill || "transparent";
      ctx.lineWidth = fweight;
      // Hachure strokes must never inherit the outline's dash pattern.
      ctx.setLineDash([]);
      applyOps(ctx, set.ops);
      ctx.stroke();
      ctx.restore();
      break;
    }
  }
}

export function draw(ctx: CanvasRenderingContext2D, drawable: Drawable): void {
  for (const set of drawable.sets) {
    drawOpSet(ctx, set, drawable);
  }
}
