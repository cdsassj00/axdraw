/**
 * The two ways to hand a canvas to someone else, and cloud saving.
 *
 * "Share" used to make a frozen snapshot straight away, and live
 * collaboration sat in a menu under a different name. People handed out the
 * snapshot expecting a live canvas, and nobody could tell the two links
 * apart. Both now open from the one Share button, side by side, each saying
 * in plain words what the person receiving it gets.
 */

import type { App } from "../app";
import { t } from "../i18n";
import { h } from "./dom";
import {
  cloudLink,
  deleteCloudAccount,
  disconnectCloud,
  fetchAccount,
  setMarketingConsent,
} from "../scene/cloud";

function modal(width: string, children: (Node | null)[]): { close: () => void } {
  const backdrop = h("div", { class: "modal-backdrop" });
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  const close = (): void => {
    backdrop.remove();
    window.removeEventListener("keydown", onKey);
  };
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  window.addEventListener("keydown", onKey);
  backdrop.append(h("div", { class: "modal island", style: { width } }, children));
  document.body.appendChild(backdrop);
  return { close };
}

/* ---------------------------------------------------------------- share */

export function openShareDialog(app: App): void {
  const live = h("div", { class: "share-option is-recommended" });
  const renderLive = (): void => {
    const session = app.collab;
    live.replaceChildren(
      h("div", { class: "share-option-head" }, [
        h("h3", { text: t("Draw together — live link") }),
        h("span", { class: "share-badge", text: t("Recommended for classes") }),
      ]),
      h("ul", { class: "share-points" }, [
        h("li", { text: t("Everyone with the link sees and edits this same canvas, live.") }),
        h("li", { text: t("One canvas, one link: it never changes, and the drawing is saved on the server.") }),
        h("li", { text: t("Opening the link again later picks up exactly where the class left off.") }),
      ]),
      session
        ? h("div", { class: "share-live" }, [
            h("input", { class: "share-url", readonly: true, value: session.url, onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
            h("div", { class: "share-actions" }, [
              h("button", {
                class: "primary-btn",
                type: "button",
                text: t("Copy live link"),
                onclick: () => void app.startCollab(),
              }),
              h("button", {
                class: "secondary-btn",
                type: "button",
                text: t("Stop sharing live"),
                onclick: () => {
                  app.stopCollab();
                  renderLive();
                },
              }),
            ]),
          ])
        : h("div", { class: "share-actions" }, [
            h("button", {
              class: "primary-btn share-live-start",
              type: "button",
              text: t("Create live link and copy"),
              onclick: async () => {
                await app.startCollab();
                renderLive();
              },
            }),
          ]),
    );
  };
  renderLive();

  const snapshot = h("div", { class: "share-option" }, [
    h("div", { class: "share-option-head" }, [h("h3", { text: t("Send a copy — snapshot link") })]),
    h("ul", { class: "share-points" }, [
      h("li", { text: t("Sends the drawing as it is right now, like attaching a file.") }),
      h("li", { text: t("The recipient gets their own copy; later changes on either side are not shared.") }),
      h("li", { text: t("For handing out a finished drawing. Each press makes a new link.") }),
    ]),
    h("div", { class: "share-actions" }, [
      h("button", {
        class: "secondary-btn share-snapshot",
        type: "button",
        text: t("Copy snapshot link"),
        onclick: () => void app.shareLink(),
      }),
    ]),
  ]);

  modal("min(560px, 100%)", [
    h("div", { class: "modal-header" }, [h("h2", { text: t("Share this canvas") })]),
    live,
    snapshot,
    h("p", {
      class: "rooms-note",
      text: t("Both links are end-to-end encrypted: the key is in the link itself and never reaches the server."),
    }),
  ]);
}

/* ---------------------------------------------------------------- cloud */

/** Status text for the chip beside the canvas name. */
export function cloudChipLabel(app: App): { text: string; title: string; state: string } {
  switch (app.cloud.status) {
    case "off":
      return { text: t("☁ Save to cloud"), title: t("Only in this browser — leave an email to keep every canvas in the cloud, free"), state: "off" };
    case "saving":
      return { text: t("☁ Saving…"), title: t("Saving to the cloud"), state: "saving" };
    case "error":
      return { text: t("☁ Not saved"), title: app.cloud.lastError || t("Cloud saving failed"), state: "error" };
    default:
      return { text: t("☁ Saved"), title: t("Every canvas is backed up to the cloud"), state: "saved" };
  }
}

export function openCloudDialog(app: App): void {
  if (app.cloud.account) openCloudAccount(app);
  else openCloudSignup(app);
}

const PRIVACY_TERMS = [
  "Collected: email address",
  "Purpose: identifying your cloud storage, and notices about the service (outages, changes)",
  "Kept until: you delete your cloud data",
  "You may decline; cloud saving then stays off, and saving in this browser keeps working.",
];

const MARKETING_TERMS = [
  "Collected: email address",
  "Purpose: CDSA newsletter, classes and events",
  "Kept until: you withdraw (from this same window, at any time)",
  "Declining does not affect cloud saving.",
];

function terms(lines: string[]): HTMLElement {
  return h("ul", { class: "consent-terms" }, lines.map((line) => h("li", { text: t(line) })));
}

function openCloudSignup(app: App): void {
  const email = h("input", {
    class: "cloud-email",
    type: "email",
    required: true,
    autocomplete: "email",
    placeholder: "name@example.com",
  });
  const privacy = h("input", { type: "checkbox", class: "consent-privacy" });
  const marketing = h("input", { type: "checkbox", class: "consent-marketing" });
  const error = h("p", { class: "cloud-error" });
  const submit = h("button", { class: "primary-btn cloud-submit", type: "submit", text: t("Save to cloud for free") });

  const form = h("form", { class: "cloud-form" }, [
    h("label", { class: "cloud-label", text: t("Email") }),
    email,
    h("label", { class: "consent" }, [privacy, h("span", { text: t("[Required] I agree to the collection and use of my personal information") })]),
    terms(PRIVACY_TERMS),
    h("label", { class: "consent" }, [marketing, h("span", { text: t("[Optional] Send me the newsletter and news about classes") })]),
    terms(MARKETING_TERMS),
    error,
    submit,
  ]);

  const dialog = modal("min(480px, 100%)", [
    h("div", { class: "modal-header" }, [h("h2", { text: t("Keep every canvas in the cloud") })]),
    h("p", {
      class: "rooms-note",
      text: t("Right now your canvases live only in this browser: clearing it, or switching computers, loses them. Leave an email and every canvas is saved to the cloud — free. Drawings are encrypted in your browser first; not even the operator can open them."),
    }),
    form,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    if (!email.value.trim() || !email.checkValidity()) {
      error.textContent = t("Please enter a valid email address");
      return;
    }
    if (!privacy.checked) {
      error.textContent = t("The required consent is needed to save to the cloud");
      return;
    }
    submit.disabled = true;
    try {
      await app.enableCloud(email.value, { privacy: true, marketing: marketing.checked });
      dialog.close();
    } catch (failure) {
      error.textContent = failure instanceof Error ? t(failure.message) : String(failure);
      submit.disabled = false;
    }
  });
  setTimeout(() => email.focus());
}

function openCloudAccount(app: App): void {
  const account = app.cloud.account;
  if (!account) return;
  const chip = cloudChipLabel(app);
  const marketing = h("input", { type: "checkbox", class: "consent-marketing", disabled: true });
  const note = h("p", { class: "cloud-error" });
  const emailText = h("strong", { text: account.email || "…" });

  void fetchAccount(account)
    .then((info) => {
      marketing.checked = info.marketing;
      marketing.disabled = false;
      emailText.textContent = info.email;
    })
    .catch((failure) => {
      note.textContent = failure instanceof Error ? t(failure.message) : String(failure);
    });
  marketing.addEventListener("change", async () => {
    marketing.disabled = true;
    try {
      await setMarketingConsent(account, marketing.checked);
      app.onMessage?.(marketing.checked ? t("Subscribed to the newsletter") : t("Unsubscribed from the newsletter"));
    } catch (failure) {
      marketing.checked = !marketing.checked;
      note.textContent = failure instanceof Error ? t(failure.message) : String(failure);
    }
    marketing.disabled = false;
  });

  const dialog = modal("min(480px, 100%)", [
    h("div", { class: "modal-header" }, [h("h2", { text: t("Cloud saving") })]),
    h("p", { class: "cloud-status" }, [t("Signed up as "), emailText, ` · ${chip.title}`]),
    h("div", { class: "share-option" }, [
      h("h3", { text: t("Open on another device") }),
      h("p", {
        class: "rooms-note",
        text: t("Open this link on your other computer or tablet to see the same canvases. Anyone with it can open all of them — keep it to yourself."),
      }),
      h("button", {
        class: "secondary-btn cloud-copy-link",
        type: "button",
        text: t("Copy my canvases link"),
        onclick: () => {
          void navigator.clipboard.writeText(cloudLink(account));
          app.onMessage?.(t("Link copied — open it on your other device"));
        },
      }),
    ]),
    h("label", { class: "consent" }, [marketing, h("span", { text: t("Send me the newsletter and news about classes") })]),
    note,
    h("div", { class: "share-actions" }, [
      h("button", {
        class: "secondary-btn",
        type: "button",
        text: t("Disconnect this browser"),
        title: t("Stops saving from this browser. Canvases stay in the cloud and here."),
        onclick: () => {
          disconnectCloud();
          void app.cloud.reconcile();
          dialog.close();
        },
      }),
      h("button", {
        class: "secondary-btn danger-btn",
        type: "button",
        text: t("Delete all cloud data"),
        onclick: async () => {
          if (!window.confirm(t("Delete every canvas saved in the cloud, and your email? Canvases in this browser are kept."))) return;
          try {
            await deleteCloudAccount(account);
            await app.cloud.reconcile();
            app.onMessage?.(t("Cloud data deleted"));
            dialog.close();
          } catch (failure) {
            note.textContent = failure instanceof Error ? t(failure.message) : String(failure);
          }
        },
      }),
    ]),
  ]);
}
