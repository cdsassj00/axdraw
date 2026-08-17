/** "Draw with AI" dialog: prompt in, elements on the canvas out. */

import type { App } from "../app";
import { AiNotConfiguredError, buildAiElements, requestAiDrawing } from "../ai/draw";
import { t } from "../i18n";
import { h } from "./dom";

export function openAiDrawDialog(app: App): void {
  const backdrop = h("div", { class: "modal-backdrop" });
  const close = (): void => backdrop.remove();
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  window.addEventListener("keydown", function onKey(event) {
    if (event.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey);
    }
  });

  const input = h("textarea", {
    class: "ai-prompt",
    rows: "3",
    maxlength: "600",
    placeholder: t("Describe what to draw — e.g. login flow flowchart"),
  }) as HTMLTextAreaElement;
  const status = h("div", { class: "ai-status", text: "" });
  const generate = h("button", {
    class: "primary-btn",
    type: "button",
    text: t("Generate"),
  }) as HTMLButtonElement;

  let busy = false;
  const run = async (): Promise<void> => {
    const prompt = input.value.trim();
    if (!prompt || busy) return;
    busy = true;
    generate.disabled = true;
    status.textContent = t("Drawing…");
    try {
      const spec = await requestAiDrawing(prompt);
      const elements = buildAiElements(spec);
      if (!elements.length) throw new Error(t("The AI could not draw that — try rephrasing"));
      app.insertTemplate(elements);
      close();
    } catch (error) {
      status.textContent =
        error instanceof AiNotConfiguredError
          ? t("AI drawing is not set up on this server yet")
          : error instanceof Error
            ? error.message
            : t("The AI could not draw that — try rephrasing");
    } finally {
      busy = false;
      generate.disabled = false;
    }
  };
  generate.onclick = () => void run();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void run();
  });

  backdrop.append(
    h("div", { class: "modal island", style: { width: "min(480px, 100%)" } }, [
      h("div", { class: "modal-header" }, [
        h("h2", { text: `✨ ${t("Draw with AI")}` }),
        h("button", { class: "secondary-btn", type: "button", text: t("Close"), onclick: close }),
      ]),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, [
        input,
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } }, [generate, status]),
      ]),
    ]),
  );
  document.body.appendChild(backdrop);
  input.focus();
}
