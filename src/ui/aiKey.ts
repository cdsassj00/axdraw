/**
 * Bring-your-own-key form, shown when the server has no AI key (501).
 * Guides the user to console.groq.com (free tier), stores the key in
 * localStorage only, and retries the action that failed.
 */

import { getUserAiKey, setUserAiKey } from "../ai/draw";
import { t } from "../i18n";
import { h } from "./dom";

export function buildAiKeyForm(onSaved: () => void): HTMLElement {
  const input = h("input", {
    class: "ai-key-input",
    type: "password",
    placeholder: "gsk_…",
    value: getUserAiKey(),
  }) as HTMLInputElement;
  const save = (): void => {
    const key = input.value.trim();
    if (!key) return;
    setUserAiKey(key);
    onSaved();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
  });
  return h("div", { class: "ai-key-form" }, [
    h("div", { class: "ai-key-guide" }, [
      h("span", { text: t("Free AI drawing needs an API key. Get a free Groq key and paste it here — it stays in this browser only.") }),
      h("a", {
        href: "https://console.groq.com/keys",
        target: "_blank",
        rel: "noopener",
        text: "console.groq.com/keys →",
      }),
    ]),
    h("div", { class: "ai-key-row" }, [
      input,
      h("button", { class: "primary-btn", type: "button", text: t("Save key"), onclick: save }),
    ]),
  ]);
}
