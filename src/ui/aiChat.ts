/**
 * AI chat panel: a small assistant docked bottom-right. Every reply can be
 * pasted onto the canvas as text (Pretendard) or turned into a diagram via
 * the same /api/ai/draw pipeline the ✨ dialog uses.
 */

import type { App } from "../app";
import { AiNotConfiguredError, buildAiElements, requestAiDrawing } from "../ai/draw";
import { DEFAULT_STYLE } from "../constants";
import { newTextElement } from "../element/factory";
import { t } from "../i18n";
import { h } from "./dom";

const API_BASE = (import.meta.env.VITE_SHARE_API as string | undefined) ?? "";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

let panel: HTMLElement | null = null;
const history: ChatMessage[] = [];

export function toggleAiChat(app: App): void {
  if (panel) {
    panel.remove();
    panel = null;
    return;
  }
  panel = buildPanel(app);
  document.body.appendChild(panel);
  (panel.querySelector(".ai-chat-input") as HTMLTextAreaElement)?.focus();
}

function pasteAsText(app: App, content: string): void {
  const element = newTextElement({
    x: 0,
    y: 0,
    style: { ...DEFAULT_STYLE, fontFamily: "pretendard", fontSize: 20, textAlign: "left" },
    text: content,
  });
  app.insertTemplate([element]);
}

function buildPanel(app: App): HTMLElement {
  const log = h("div", { class: "ai-chat-log" });
  const input = h("textarea", {
    class: "ai-chat-input",
    rows: "2",
    placeholder: t("Ask anything — answers can go straight onto the canvas"),
  }) as HTMLTextAreaElement;
  const send = h("button", { class: "primary-btn", type: "button", text: t("Send") }) as HTMLButtonElement;

  const append = (message: ChatMessage): void => {
    const row = h("div", { class: `ai-chat-msg ai-chat-${message.role}` }, [
      h("div", { class: "ai-chat-bubble", text: message.content }),
    ]);
    if (message.role === "assistant") {
      row.appendChild(
        h("div", { class: "ai-chat-actions" }, [
          h("button", {
            class: "secondary-btn",
            type: "button",
            text: t("Paste to canvas"),
            onclick: () => pasteAsText(app, message.content),
          }),
          h("button", {
            class: "secondary-btn",
            type: "button",
            text: t("Draw as diagram"),
            onclick: (event: Event) => {
              const button = event.currentTarget as HTMLButtonElement;
              button.disabled = true;
              button.textContent = t("Drawing…");
              void requestAiDrawing(message.content.slice(0, 600))
                .then((spec) => {
                  const elements = buildAiElements(spec);
                  if (elements.length) app.insertTemplate(elements);
                })
                .catch(() => undefined)
                .finally(() => {
                  button.disabled = false;
                  button.textContent = t("Draw as diagram");
                });
            },
          }),
        ]),
      );
    }
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  };

  history.forEach(append);

  let busy = false;
  const run = async (): Promise<void> => {
    const content = input.value.trim();
    if (!content || busy) return;
    busy = true;
    send.disabled = true;
    input.value = "";
    const userMessage: ChatMessage = { role: "user", content };
    history.push(userMessage);
    append(userMessage);
    const pending = h("div", { class: "ai-chat-msg ai-chat-assistant" }, [
      h("div", { class: "ai-chat-bubble ai-chat-pending", text: "…" }),
    ]);
    log.appendChild(pending);
    log.scrollTop = log.scrollHeight;
    try {
      const response = await fetch(`${API_BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-12) }),
      });
      if (response.status === 501) throw new AiNotConfiguredError();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `AI request failed (${response.status})`);
      pending.remove();
      const reply: ChatMessage = { role: "assistant", content: body.reply };
      history.push(reply);
      append(reply);
    } catch (error) {
      pending.remove();
      append({
        role: "assistant",
        content:
          error instanceof AiNotConfiguredError
            ? t("AI drawing is not set up on this server yet")
            : error instanceof Error
              ? error.message
              : String(error),
      });
    } finally {
      busy = false;
      send.disabled = false;
    }
  };
  send.onclick = () => void run();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void run();
    }
  });

  return h("div", { class: "ai-chat island" }, [
    h("div", { class: "ai-chat-header" }, [
      h("span", { text: `💬 ${t("AI chat")}` }),
      h("button", {
        class: "secondary-btn",
        type: "button",
        text: t("Close"),
        onclick: () => {
          panel?.remove();
          panel = null;
        },
      }),
    ]),
    log,
    h("div", { class: "ai-chat-compose" }, [input, send]),
  ]);
}
