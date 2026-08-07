/**
 * The "did you mean" chip.
 *
 * Shape assist has to guess from a rough stroke, and it is deliberately
 * conservative — an ambiguous scribble stays freehand rather than becoming the
 * wrong shape. That is the right default and the wrong dead end: the user is
 * left redrawing the same circle until it takes.
 *
 * So after every recognised stroke the alternates sit next to the result for
 * one action. Confirming costs nothing (keep drawing), correcting costs one
 * click, and the geometry is reused rather than re-guessed, so switching is
 * exact instead of another approximation.
 *
 * Positioned in screen space under the shape's box, clamped to the viewport so
 * it never lands off-canvas for a stroke drawn near an edge.
 */

import type { App } from "../app";
import type { RecognitionChoiceType } from "../types";
import { h } from "./dom";

/** Corners of the fitted box, rotated, in scene coordinates. */
function frameCorners(frame: {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}): [number, number][] {
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const cos = Math.cos(frame.angle);
  const sin = Math.sin(frame.angle);
  return (
    [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ] as [number, number][]
  ).map(([x, y]) => [frame.cx + x * cos - y * sin, frame.cy + x * sin + y * cos]);
}

export function createRecognitionChip(app: App, parent: HTMLElement): void {
  const chip = h("div", {
    class: "ax-recognition-chip",
    role: "group",
    "aria-label": "Shape suggestion",
  });
  chip.hidden = true;
  parent.appendChild(chip);

  // The chip sits over the canvas; a pointerdown here must not reach the canvas
  // handler, which retires the suggestion before the click is processed.
  chip.addEventListener("pointerdown", (event) => event.stopPropagation());

  const render = (): void => {
    const choice = app.recognitionChoice;
    if (!choice) {
      if (!chip.hidden) {
        chip.hidden = true;
        chip.replaceChildren();
      }
      return;
    }

    const { zoom, scrollX, scrollY, width: vw, height: vh } = app.viewport;
    const corners = frameCorners(choice.frame);
    const screenXs = corners.map(([x]) => (x + scrollX) * zoom);
    const screenYs = corners.map(([, y]) => (y + scrollY) * zoom);
    const left = (Math.min(...screenXs) + Math.max(...screenXs)) / 2;
    const bottom = Math.max(...screenYs);

    chip.replaceChildren(
      ...choice.options.map((option) => {
        const active = option.type === choice.active;
        return h(
          "button",
          {
            class: `chip-option${active ? " active" : ""}`,
            type: "button",
            "aria-pressed": active ? "true" : "false",
            title: option.label,
            onclick: () => app.applyRecognitionChoice(option.type as RecognitionChoiceType),
          },
          [option.label],
        );
      }),
    );

    chip.hidden = false;
    // Measure after content is in, so the clamp uses the real width.
    const rect = chip.getBoundingClientRect();
    const margin = 8;
    const x = Math.min(Math.max(left - rect.width / 2, margin), vw - rect.width - margin);
    const y = Math.min(bottom + 12, vh - rect.height - margin);
    chip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  app.subscribe(render);
  render();
}
