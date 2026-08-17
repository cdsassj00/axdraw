/**
 * In-site AI drawing: send a prompt to the Worker's /api/ai/draw proxy
 * (Groq or OpenRouter behind a server-side key) and turn the returned
 * element spec into real elements, inserted like a template.
 */

import { DEFAULT_STYLE } from "../constants";
import { newLinearElement, newShapeElement, newTextElement } from "../element/factory";
import type { AxElement, ItemStyle } from "../types";

const API_BASE = (import.meta.env.VITE_SHARE_API as string | undefined) ?? "";

export interface AiSpecItem {
  type: "rectangle" | "ellipse" | "diamond" | "arrow" | "line" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  label?: string;
  points?: [number, number][];
  /** Arrow/line end point in absolute coordinates (start is x, y). */
  x2?: number;
  y2?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  fontSize?: number;
  angle?: number;
}

export class AiNotConfiguredError extends Error {}

export async function requestAiDrawing(prompt: string): Promise<AiSpecItem[]> {
  const response = await fetch(`${API_BASE}/api/ai/draw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (response.status === 501) throw new AiNotConfiguredError();
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `AI request failed (${response.status})`);
  return body.elements as AiSpecItem[];
}

function style(overrides: Partial<ItemStyle>): ItemStyle {
  return { ...DEFAULT_STYLE, ...overrides };
}

function styleFrom(item: AiSpecItem, extra: Partial<ItemStyle> = {}): ItemStyle {
  return style({
    // AI-generated text reads best in a clean Korean-friendly face.
    fontFamily: "pretendard",
    ...(item.strokeColor ? { strokeColor: item.strokeColor } : {}),
    ...(item.backgroundColor ? { backgroundColor: item.backgroundColor, fillStyle: "solid" as const } : {}),
    ...(item.strokeWidth ? { strokeWidth: item.strokeWidth } : {}),
    ...(item.fontSize ? { fontSize: item.fontSize } : {}),
    ...extra,
  });
}

/** A text element centred on (cx, cy). */
function centredText(text: string, cx: number, cy: number, base: ItemStyle): AxElement {
  const element = newTextElement({ x: 0, y: 0, style: { ...base, textAlign: "center" }, text });
  element.x = cx - element.width / 2;
  element.y = cy - element.height / 2;
  return element;
}

/** Models sometimes emit numbers as strings; coerce before giving up. */
const num = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
};

/** Convert the model's spec into real elements. Skips anything malformed. */
export function buildAiElements(spec: AiSpecItem[]): AxElement[] {
  const out: AxElement[] = [];
  for (const item of spec) {
    if (!item || typeof item !== "object") continue;
    const x = num(item.x, 0);
    const y = num(item.y, 0);
    const width = num(item.width, 160);
    const height = num(item.height, 70);
    const angle = num(item.angle, 0);
    try {
      switch (item.type) {
        case "rectangle":
        case "ellipse":
        case "diamond":
          out.push(newShapeElement(item.type, { x, y, width, height, angle, style: styleFrom(item) }));
          break;
        case "arrow":
        case "line": {
          const end: [number, number] | null =
            item.x2 != null || item.y2 != null
              ? [num(item.x2, x) - x, num(item.y2, y) - y]
              : null;
          const raw: [number, number][] = end
            ? [[0, 0], end]
            : Array.isArray(item.points) && item.points.length >= 2
              ? item.points
              : [[0, 0], [num(item.width, 100), num(item.height, 0)]];
          const points = raw
            .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
            .map((p) => [num(p[0], 0), num(p[1], 0)] as [number, number]);
          if (points.length < 2) break;
          const xs = points.map((p) => p[0]);
          const ys = points.map((p) => p[1]);
          out.push(
            newLinearElement(item.type, {
              x,
              y,
              width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys),
              angle,
              style: styleFrom(item, { endArrowhead: item.type === "arrow" ? "arrow" : "none" }),
              points,
            }),
          );
          break;
        }
        case "text": {
          const element = newTextElement({
            x,
            y,
            style: styleFrom(item, item.fontSize ? {} : { fontSize: 20 }),
            text: String(item.text ?? item.label ?? ""),
          });
          out.push(element);
          break;
        }
        default:
          break;
      }
      if (item.label && item.type !== "text") {
        // Labels stay dark and readable no matter what the shape's stroke is.
        const labelStyle = styleFrom(
          { ...item, backgroundColor: undefined, strokeColor: "#1e293b" },
          { fontSize: item.fontSize ?? 20 },
        );
        out.push(centredText(String(item.label), x + width / 2, y + height / 2, labelStyle));
      }
    } catch {
      // One bad item never sinks the drawing.
    }
  }
  return out;
}
