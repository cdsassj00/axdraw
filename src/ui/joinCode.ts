/**
 * Join-code screens: the big code + QR + short link a teacher shows the
 * class, and the box a student types a code into.
 */

import type { App } from "../app";
import { t } from "../i18n";
import { JOIN_CODE_PATTERN, resolveJoinCode, shortJoinLink, spacedCode } from "../scene/joinCode";
import { qrSvg } from "../utils/qr";
import { button, h } from "./dom";
import { iconEl } from "./icons";
import { openBoardBySlug } from "./classBoard";

function modal(title: string, body: HTMLElement[]): HTMLElement {
  const close = () => {
    backdrop.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  const backdrop = h(
    "div",
    { class: "modal-backdrop join-backdrop", onclick: (event: MouseEvent) => event.target === backdrop && close() },
    [
      h("div", { class: "modal island join-modal" }, [
        h("div", { class: "modal-header" }, [h("h2", { text: title }), button({ icon: iconEl("close"), title: "Close", onClick: close })]),
        ...body,
      ]),
    ],
  );
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(backdrop);
  return backdrop;
}

/**
 * The code to show the class: large digits for the projector, a QR for
 * phones, and the short link to paste into a chat.
 */
export function openJoinCodeDialog(options: { title: string; code: string; note: string; onMessage?: (text: string) => void }): void {
  const link = shortJoinLink(options.code);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      options.onMessage?.(t("Link copied"));
    } catch {
      prompt(t("Link"), link);
    }
  };
  modal(options.title, [
    h("div", { class: "join-code", "aria-label": options.code, text: spacedCode(options.code) }),
    h("div", { class: "join-qr", html: qrSvg(link, 220) }),
    h("div", { class: "join-link-row" }, [
      h("input", { class: "share-url", readonly: true, value: link, onclick: (event: Event) => (event.target as HTMLInputElement).select() }),
      h("button", { class: "primary-btn", type: "button", text: t("Copy"), onclick: () => void copy() }),
    ]),
    h("p", { class: "join-how", text: t("Students: scan the QR, open the link, or go to axdraw.org → menu → Join with a code.") }),
    h("p", { class: "join-note", text: options.note }),
  ]);
}

/** Opens whatever a code stands for: a live room, or a class board. */
export async function joinWithCode(app: App, code: string): Promise<void> {
  try {
    const target = await resolveJoinCode(code);
    if (target.kind === "board") {
      await openBoardBySlug(app, target.slug);
      return;
    }
    history.replaceState(null, "", `${location.pathname}${location.search}#room=${target.room.id},${target.room.key}`);
    await app.joinCollabFromHash();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    app.onError?.(t(/no such code/.test(text) ? "That code does not exist or has expired" : text));
  }
}

/** The box a student types a code into. */
export function openEnterCodeDialog(app: App): void {
  const input = h("input", {
    class: "join-input",
    inputmode: "numeric",
    autocomplete: "one-time-code",
    maxlength: "7",
    placeholder: "000 000",
    "aria-label": t("Join code"),
  }) as HTMLInputElement;
  const go = async () => {
    const code = input.value.replace(/\D/g, "");
    if (!JOIN_CODE_PATTERN.test(code)) {
      app.onError?.(t("A join code has six digits"));
      return;
    }
    backdrop.remove();
    await joinWithCode(app, code);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void go();
  });
  const backdrop = modal(t("Join with a code"), [
    h("p", { class: "join-how", text: t("Type the six digits your teacher shows.") }),
    input,
    h("button", { class: "primary-btn join-go", type: "button", text: t("Join"), onclick: () => void go() }),
  ]);
  setTimeout(() => input.focus(), 0);
}
