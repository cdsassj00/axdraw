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
import { deleteCloudAccount, fetchAccount, setMarketingConsent } from "../scene/cloud";

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
                class: "secondary-btn share-gather",
                type: "button",
                text: t("Bring everyone to my view"),
                title: t("Every participant's screen moves to what you are looking at, so nobody draws on top of someone else's work"),
                onclick: () => app.gatherEveryone(),
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
  const who = app.cloud.account?.email ?? "";
  switch (app.cloud.status) {
    case "off":
      return { text: t("☁ Log in"), title: t("Log in with your email and every canvas is kept in your account, on any device"), state: "off" };
    case "saving":
      return { text: t("☁ Saving…"), title: who, state: "saving" };
    case "error":
      return { text: t("☁ Not saved"), title: app.cloud.lastError || t("Cloud saving failed"), state: "error" };
    default:
      return { text: t("☁ Saved"), title: who, state: "saved" };
  }
}

export function openCloudDialog(app: App): void {
  if (app.cloud.account) openCloudAccount(app);
  else openLogin(app, "login");
}

const PRIVACY_TERMS = [
  "Collected: email address",
  "Purpose: your account, and notices about the service (outages, changes)",
  "Kept until: you delete your account",
  "You may decline; you can then still draw, saved in this browser only.",
];

const MARKETING_TERMS = [
  "Collected: email address",
  "Purpose: CDSA newsletter, classes and events",
  "Kept until: you withdraw (from the account window, at any time)",
  "Declining does not affect your account.",
];

function terms(lines: string[]): HTMLElement {
  return h("ul", { class: "consent-terms" }, lines.map((line) => h("li", { text: t(line) })));
}

/**
 * Log in, or sign up. One window, two modes: the email and password are the
 * whole of it, so that "open my drawings on this computer" is the same act
 * everywhere — the way any other online service works.
 */
function openLogin(app: App, mode: "login" | "signup"): void {
  const email = h("input", { class: "cloud-email", type: "email", required: true, autocomplete: "email", placeholder: "name@example.com" });
  const password = h("input", {
    class: "cloud-password",
    type: "password",
    required: true,
    minlength: "6",
    autocomplete: mode === "login" ? "current-password" : "new-password",
    placeholder: t("Password (6+ characters)"),
  });
  const confirm = h("input", { class: "cloud-password-confirm", type: "password", autocomplete: "new-password", placeholder: t("Password again") });
  const privacy = h("input", { type: "checkbox", class: "consent-privacy" });
  const marketing = h("input", { type: "checkbox", class: "consent-marketing" });
  const error = h("p", { class: "cloud-error" });
  const submit = h("button", {
    class: "primary-btn cloud-submit",
    type: "submit",
    text: mode === "login" ? t("Log in") : t("Sign up and save my canvases"),
  });
  const signupOnly = mode === "signup"
    ? [
        confirm,
        h("label", { class: "consent" }, [privacy, h("span", { text: t("[Required] I agree to the collection and use of my personal information") })]),
        terms(PRIVACY_TERMS),
        h("label", { class: "consent" }, [marketing, h("span", { text: t("[Optional] Send me the newsletter and news about classes") })]),
        terms(MARKETING_TERMS),
      ]
    : [];
  const form = h("form", { class: "cloud-form" }, [
    h("label", { class: "cloud-label", text: t("Email") }),
    email,
    h("label", { class: "cloud-label", text: t("Password") }),
    password,
    ...signupOnly,
    error,
    submit,
  ]);
  const swap = h("button", {
    class: "link-btn cloud-swap",
    type: "button",
    text: mode === "login" ? t("New here? Create an account") : t("Already have an account? Log in"),
    onclick: () => {
      dialog.close();
      openLogin(app, mode === "login" ? "signup" : "login");
    },
  });

  const dialog = modal("min(440px, 100%)", [
    h("div", { class: "modal-header" }, [h("h2", { text: mode === "login" ? t("Log in") : t("Create an account") })]),
    h("p", {
      class: "rooms-note",
      text: t("Log in with the same email on any computer or phone and all your canvases are there — including the live rooms you joined."),
    }),
    form,
    swap,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    if (!email.value.trim() || !email.checkValidity()) {
      error.textContent = t("Please enter a valid email address");
      return;
    }
    if (password.value.length < 6) {
      error.textContent = t("The password needs at least 6 characters");
      return;
    }
    if (mode === "signup") {
      if (confirm.value !== password.value) {
        error.textContent = t("The two passwords do not match");
        return;
      }
      if (!privacy.checked) {
        error.textContent = t("The required consent is needed to create an account");
        return;
      }
    }
    submit.disabled = true;
    try {
      if (mode === "login") await app.login(email.value, password.value);
      else await app.signup(email.value, password.value, { privacy: true, marketing: marketing.checked });
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

  const dialog = modal("min(440px, 100%)", [
    h("div", { class: "modal-header" }, [h("h2", { text: t("My account") })]),
    h("p", { class: "cloud-status" }, [emailText, ` · ${cloudChipLabel(app).text}`]),
    h("p", {
      class: "rooms-note",
      text: t("Every canvas, including live rooms you joined, is saved to this account. Log in with this email on another device to open them there."),
    }),
    h("label", { class: "consent" }, [marketing, h("span", { text: t("Send me the newsletter and news about classes") })]),
    note,
    h("div", { class: "share-actions" }, [
      h("button", {
        class: "primary-btn cloud-logout",
        type: "button",
        text: t("Log out"),
        title: t("On a shared computer, log out: your canvases are removed from this device and stay in your account."),
        onclick: async () => {
          await app.logout();
          dialog.close();
        },
      }),
      h("button", {
        class: "secondary-btn danger-btn",
        type: "button",
        text: t("Delete account"),
        onclick: async () => {
          if (!window.confirm(t("Delete your account, your email and every canvas saved in it? Canvases in this browser are kept."))) return;
          try {
            await deleteCloudAccount(account);
            await app.cloud.reconcile();
            app.onMessage?.(t("Account deleted"));
            dialog.close();
          } catch (failure) {
            note.textContent = failure instanceof Error ? t(failure.message) : String(failure);
          }
        },
      }),
    ]),
  ]);
}
