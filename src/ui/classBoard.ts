/**
 * The class board screen: a Padlet-style wall of post-its paired with the
 * open canvas. "📋 Board" in the top bar opens it (making a board for the
 * canvas the first time); "← Canvas" goes back. A #board=… link opens the
 * board straight away, on a canvas of its own.
 *
 * Wall shows every post in a grid, Shelf one column per category. The
 * composer sits inline at the top — a card that grows in place rather than a
 * pop-up, so dragging a file onto it or selecting text never closes it.
 */

import type { App } from "../app";
import { t } from "../i18n";
import {
  BOARD_COLORS,
  askBoardAi,
  authorName,
  commentOnBoardPost,
  createBoardPost,
  createClassBoard,
  deleteBoardPost,
  fetchClassBoard,
  forgetBoardPassword,
  isStudentView,
  rememberBoardPassword,
  setBoardPassword,
  setStudentView,
  fileUrl,
  hasLiked,
  knownBoards,
  likeBoardPost,
  postKeyOf,
  rememberAuthor,
  updateClassBoard,
  uploadBoardFile,
  type BoardColor,
  type BoardFile,
  type BoardPost,
  type ClassBoard,
} from "../scene/classBoard";
import { h } from "./dom";
import { openConfirmDialog } from "./dialogs";
import { createJoinCode } from "../scene/joinCode";
import { openJoinCodeDialog } from "./joinCode";

const REFRESH_MS = 10000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

interface State {
  board: ClassBoard;
  posts: BoardPost[];
  isOwner: boolean;
  /** No instructor password yet: anyone may set one and take the role. */
  canClaim: boolean;
  view: "wall" | "shelf";
  filter: string | null;
  query: string;
  openComments: Set<number>;
}

let layer: HTMLElement | null = null;
let state: State | null = null;
let refreshTimer: number | null = null;
let currentApp: App | null = null;

function message(text: string): void {
  currentApp?.onMessage?.(text);
}

function failure(error: unknown): void {
  currentApp?.onError?.(t(error instanceof Error ? error.message : String(error)));
}

function sizeLabel(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function timeLabel(at: number): string {
  const date = new Date(at);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fileIcon(file: BoardFile): string {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (file.type === "application/pdf" || ext === "pdf") return "📕";
  if (["ppt", "pptx", "key"].includes(ext)) return "📊";
  if (["xls", "xlsx", "csv"].includes(ext)) return "📗";
  if (["doc", "docx", "hwp", "hwpx", "txt", "md"].includes(ext)) return "📘";
  if (["zip", "rar", "7z"].includes(ext)) return "🗜️";
  return "📄";
}

const INLINE_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Opens the board paired with the open canvas, making one the first time. */
export async function openBoardForCanvas(app: App): Promise<void> {
  currentApp = app;
  let slug = app.classBoardSlug();
  if (!slug) {
    // Whoever makes the board is not its instructor by that alone: the
    // instructor is whoever knows the password, so choose it now.
    const password = await askPassword({
      title: t("New class board"),
      text: t("Choose an instructor password. Only someone who knows it can add or remove categories, lock the board, or remove posts — on any device. Students do not need it."),
      action: t("Create the board"),
      skip: t("Create without a password"),
    });
    if (password === null) return;
    try {
      const board = await createClassBoard(app.currentBoardName(), password);
      app.linkClassBoard(board.slug);
      slug = board.slug;
    } catch (error) {
      failure(error);
      return;
    }
  }
  await showBoard(app, slug);
}

/** Opens a board by its slug (a #board=… link), on the canvas paired with it. */
export async function openBoardBySlug(app: App, slug: string): Promise<void> {
  currentApp = app;
  await showBoard(app, slug, true);
}

export function closeBoard(): void {
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = null;
  layer?.remove();
  layer = null;
  state = null;
  if (location.hash.startsWith("#board=")) history.replaceState(null, "", `${location.pathname}${location.search}`);
}

export function isBoardOpen(): boolean {
  return layer !== null;
}

async function showBoard(app: App, slug: string, pairCanvas = false): Promise<void> {
  let loaded;
  try {
    loaded = await fetchClassBoard(slug);
  } catch (error) {
    failure(error);
    return;
  }
  if (pairCanvas) app.openCanvasForClassBoard(slug, loaded.board.title);
  state = {
    board: loaded.board,
    posts: loaded.posts,
    isOwner: loaded.isOwner,
    canClaim: loaded.canClaim,
    view: state?.board.slug === slug ? state.view : "wall",
    filter: null,
    query: "",
    openComments: new Set(),
  };
  history.replaceState(null, "", `${location.pathname}${location.search}#board=${slug}`);
  if (!layer) {
    layer = h("div", { class: "class-board", role: "dialog", "aria-label": t("Class board") });
    document.body.appendChild(layer);
  }
  render(app);
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void refresh(app), REFRESH_MS);
}

/** Picks up other people's posts, unless someone is typing on the page. */
async function refresh(app: App, force = false): Promise<void> {
  if (!state || !layer) return;
  if (!force && (document.visibilityState !== "visible" || layer.contains(document.activeElement) && (document.activeElement as HTMLElement).matches("input, textarea, select"))) {
    return;
  }
  try {
    const loaded = await fetchClassBoard(state.board.slug);
    if (!state) return;
    state.board = loaded.board;
    state.posts = loaded.posts;
    const roleChanged = state.isOwner !== loaded.isOwner || state.canClaim !== loaded.canClaim;
    state.isOwner = loaded.isOwner;
    state.canClaim = loaded.canClaim;
    if (roleChanged) render(app);
    else renderBody(app);
  } catch {
    // Offline for a moment: the next tick tries again.
  }
}

function render(app: App): void {
  if (!layer || !state) return;
  const s = state;
  const header = h("div", { class: "cb-header" }, [
    h("div", { class: "cb-row" }, [
      h("button", { class: "cb-btn", type: "button", text: t("← Canvas"), title: t("Back to the paired canvas"), onclick: closeBoard }),
      h("h1", {
        class: `cb-title${s.isOwner ? " is-editable" : ""}`,
        text: s.board.title,
        title: s.isOwner ? t("Click to rename the board") : undefined,
        onclick: s.isOwner
          ? async () => {
              const name = prompt(t("Board name"), s.board.title)?.trim();
              if (!name || name === s.board.title) return;
              try {
                s.board = await updateClassBoard(s.board.slug, { title: name });
                render(app);
              } catch (error) {
                failure(error);
              }
            }
          : undefined,
      }),
      s.board.locked ? h("span", { class: "cb-badge", text: t("🔒 Locked") }) : null,
      h("span", { class: "cb-badge is-muted", text: `🔗 ${t("paired with")} ${app.currentBoardName()}` }),
    ]),
    h("div", { class: "cb-row" }, [
      h("div", { class: "cb-segment" }, [
        h("button", { class: `cb-btn${s.view === "wall" ? " is-active" : ""}`, type: "button", text: t("Wall"), onclick: () => { s.view = "wall"; render(app); } }),
        h("button", { class: `cb-btn${s.view === "shelf" ? " is-active" : ""}`, type: "button", text: t("Shelf"), onclick: () => { s.view = "shelf"; render(app); } }),
      ]),
      h("input", {
        class: "cb-search",
        type: "search",
        placeholder: t("Search this board"),
        value: s.query,
        oninput: (event: Event) => {
          s.query = (event.target as HTMLInputElement).value;
          renderBody(app);
        },
      }),
      h("button", { class: "cb-btn", type: "button", text: t("✨ AI summary"), onclick: () => void runAi(s.board.slug, "summary") }),
      h("button", { class: "cb-btn", type: "button", text: t("📝 AI quiz"), onclick: () => void runAi(s.board.slug, "quiz") }),
      h("button", {
        class: "cb-btn is-primary cb-code",
        type: "button",
        text: t("🔑 Join code · QR"),
        onclick: async () => {
          try {
            // Before the link goes out to a class, give the board an
            // instructor — otherwise the first student to try could take it.
            if (s.canClaim && !(await claimBoard(app, true))) return;
            const code = await createJoinCode({ kind: "board", slug: s.board.slug });
            openJoinCodeDialog({
              title: t("Join code for this board"),
              code,
              note: t("Anyone with the code, the QR or the link can read and post. Lock the board to stop new posts."),
              onMessage: (text) => message(text),
            });
          } catch (error) {
            failure(error);
          }
        },
      }),
      h("button", { class: "cb-btn", type: "button", text: t("📂 My boards"), onclick: () => openBoardList(app) }),
      h("button", {
        class: `cb-btn cb-instructor${s.isOwner ? " is-active" : ""}`,
        type: "button",
        text: s.isOwner ? t("🛡️ Instructor mode ON") : t("🛡️ Instructor mode"),
        title: s.isOwner ? t("Click to see the board as students do") : t("Enter the instructor password to manage this board"),
        onclick: () => void toggleInstructor(app),
      }),
      s.isOwner
        ? h("button", {
            class: "cb-btn",
            type: "button",
            text: s.board.locked ? t("🔓 Unlock") : t("🔒 Lock"),
            title: t("A locked board can be read but not posted to"),
            onclick: async () => {
              try {
                s.board = await updateClassBoard(s.board.slug, { locked: !s.board.locked });
                render(app);
              } catch (error) {
                failure(error);
              }
            },
          })
        : null,
    ]),
  ]);
  const body = h("div", { class: "cb-body" });
  layer.replaceChildren(header, composer(app), body);
  renderBody(app);
}

function renderBody(app: App): void {
  if (!layer || !state) return;
  const s = state;
  const body = layer.querySelector(".cb-body");
  if (!body) return;
  const sections = [...s.board.sections];
  for (const post of s.posts) if (!sections.includes(post.section)) sections.push(post.section);

  const q = s.query.trim().toLowerCase();
  const visible = s.posts.filter(
    (post) =>
      (!s.filter || post.section === s.filter) &&
      (!q || [post.title, post.content, post.author, post.link ?? "", post.file?.name ?? ""].some((field) => field.toLowerCase().includes(q))),
  );

  const pills = h("div", { class: "cb-pills" }, [
    h("button", { class: `cb-pill${s.filter === null ? " is-active" : ""}`, type: "button", text: t("All"), onclick: () => { s.filter = null; renderBody(app); } }),
    ...sections.map((section) =>
      h("button", {
        class: `cb-pill${s.filter === section ? " is-active" : ""}`,
        type: "button",
        text: `${section} ${s.posts.filter((post) => post.section === section).length}`,
        onclick: () => { s.filter = section; renderBody(app); },
      }),
    ),
    s.isOwner ? h("button", { class: "cb-pill is-add", type: "button", text: t("＋ Category"), onclick: () => void addCategory(app) }) : null,
    // With a category picked, its owner can rename or remove it right here.
    ...(s.isOwner && s.filter && s.board.sections.includes(s.filter) ? categoryTools(app, s.filter) : []),
  ]);

  let cards: HTMLElement;
  if (s.view === "shelf") {
    cards = h("div", { class: "cb-shelf" }, [
      ...sections
        .filter((section) => !s.filter || section === s.filter)
        .map((section) => {
          const items = visible.filter((post) => post.section === section);
          return h("div", { class: "cb-column" }, [
            h("div", { class: "cb-column-title" }, [
              h("span", { text: section }),
              h("span", { class: "cb-column-tools" }, [
                ...(s.isOwner && s.board.sections.includes(section) ? categoryTools(app, section, true) : []),
                h("span", { class: "cb-count", text: String(items.length) }),
              ]),
            ]),
            ...(items.length ? items.map((post) => card(app, post)) : [h("p", { class: "cb-empty", text: t("No posts yet") })]),
          ]);
        }),
      s.isOwner ? h("button", { class: "cb-column is-add", type: "button", text: t("＋ New category column"), onclick: () => void addCategory(app) }) : null,
    ]);
  } else {
    cards = h(
      "div",
      { class: "cb-wall" },
      visible.length
        ? visible.map((post) => card(app, post))
        : [h("p", { class: "cb-empty is-wide", text: s.posts.length ? t("Nothing matches") : t("No posts yet — write the first one above") })],
    );
  }
  body.replaceChildren(pills, cards);
}

/**
 * Asks for a password in a small window. Resolves with the password, with ""
 * when the optional step is skipped, or with null when it is closed.
 */
function askPassword(options: { title: string; text: string; action: string; skip?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      resolve(value);
    };
    const input = h("input", {
      class: "cb-input cb-pass-input",
      type: "password",
      autocomplete: "off",
      maxlength: "100",
      placeholder: t("Instructor password (4+ characters)"),
    }) as HTMLInputElement;
    const submit = () => {
      const value = input.value.trim();
      if (value.length < 4) {
        failure(new Error("the password needs at least 4 characters"));
        return;
      }
      finish(value);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    const backdrop = h("div", { class: "modal-backdrop", onclick: (event: MouseEvent) => event.target === backdrop && finish(null) }, [
      h("div", { class: "modal island cb-ai cb-pass" }, [
        h("div", { class: "modal-header" }, [
          h("h2", { text: options.title }),
          h("button", { class: "cb-btn", type: "button", text: "✕", onclick: () => finish(null) }),
        ]),
        h("p", { class: "cb-hint", text: options.text }),
        input,
        h("div", { class: "cb-row cb-pass-actions" }, [
          options.skip ? h("button", { class: "cb-btn cb-pass-skip", type: "button", text: options.skip, onclick: () => finish("") }) : null,
          h("button", { class: "cb-btn is-primary cb-pass-go", type: "button", text: options.action, onclick: submit }),
        ]),
      ]),
    ]);
    document.body.appendChild(backdrop);
    setTimeout(() => input.focus(), 0);
  });
}

/**
 * Sets the instructor password on a board that has none. Returns false only
 * when the window was closed; skipping (where allowed) carries on.
 */
async function claimBoard(app: App, skippable = false): Promise<boolean> {
  if (!state) return false;
  const password = await askPassword({
    title: t("🛡️ Become this board's instructor?"),
    text: t("This board has no instructor yet. Choose a password: whoever knows it manages the board (categories, lock, removing posts) from any device."),
    action: t("Set the password"),
    skip: skippable ? t("Not now") : undefined,
  });
  if (password === null) return false;
  if (!password) return true;
  try {
    await setBoardPassword(state.board, password);
    setStudentView(state.board.slug, false);
    await refresh(app, true);
    message(t("Instructor mode is on"));
  } catch (error) {
    failure(error);
  }
  return true;
}

/** The 🛡️ button: on with the password, off to see what students see. */
async function toggleInstructor(app: App): Promise<void> {
  if (!state) return;
  const s = state;
  const slug = s.board.slug;
  if (s.isOwner) {
    setStudentView(slug, true);
    await refresh(app, true);
    message(t("Instructor mode is off — this is what students see"));
    return;
  }
  if (isStudentView(slug)) {
    setStudentView(slug, false);
    await refresh(app, true);
    if (state?.isOwner) {
      message(t("Instructor mode is on"));
      return;
    }
  }
  if (s.canClaim) {
    await claimBoard(app);
    return;
  }
  const password = await askPassword({
    title: t("🛡️ Instructor mode"),
    text: t("Enter this board's instructor password to add or remove categories, lock the board and remove posts."),
    action: t("Confirm"),
  });
  if (!password) return;
  rememberBoardPassword(s.board, password);
  await refresh(app, true);
  if (state?.isOwner) {
    message(t("Instructor mode is on"));
  } else {
    forgetBoardPassword(slug);
    failure(new Error("Wrong instructor password"));
  }
}

/** Rename and remove buttons for one category (icons only in a column head). */
function categoryTools(app: App, section: string, compact = false): HTMLElement[] {
  return [
    h("button", {
      class: `cb-cat-tool${compact ? " is-compact" : ""}`,
      type: "button",
      title: t("Rename this category"),
      "aria-label": t("Rename this category"),
      dataset: { catRename: section },
      text: compact ? "✏️" : `✏️ ${t("Rename")}`,
      onclick: () => void renameCategory(app, section),
    }),
    h("button", {
      class: `cb-cat-tool${compact ? " is-compact" : ""}`,
      type: "button",
      title: t("Remove this category"),
      "aria-label": t("Remove this category"),
      dataset: { catRemove: section },
      text: compact ? "🗑" : `🗑 ${t("Remove")}`,
      onclick: () => removeCategory(app, section),
    }),
  ];
}

async function renameCategory(app: App, section: string): Promise<void> {
  if (!state) return;
  const name = prompt(t("New name for this category"), section)?.trim();
  if (!name || name === section) return;
  try {
    state.board = await updateClassBoard(state.board.slug, { rename: { from: section, to: name } });
    if (state.filter === section) state.filter = name;
    await refresh(app, true);
    render(app);
  } catch (error) {
    failure(error);
  }
}

function removeCategory(app: App, section: string): void {
  if (!state) return;
  const s = state;
  if (s.board.sections.length <= 1) {
    failure(new Error("a board needs at least one category"));
    return;
  }
  const count = s.posts.filter((post) => post.section === section).length;
  const moveTo = s.board.sections.find((name) => name !== section)!;
  const question = count
    ? t("Remove '{name}'? Its {n} posts move to '{to}'.").replace("{name}", section).replace("{n}", String(count)).replace("{to}", moveTo)
    : t("Remove the empty category '{name}'?").replace("{name}", section);
  openConfirmDialog(t("Remove this category"), question, t("Remove"), async () => {
    try {
      s.board = await updateClassBoard(s.board.slug, { remove: section, moveTo });
      if (s.filter === section) s.filter = null;
      await refresh(app, true);
      render(app);
    } catch (error) {
      failure(error);
    }
  });
}

async function addCategory(app: App): Promise<void> {
  if (!state) return;
  const name = prompt(t("New category name"))?.trim();
  if (!name) return;
  if (state.board.sections.includes(name)) return;
  try {
    state.board = await updateClassBoard(state.board.slug, { sections: [...state.board.sections, name] });
    renderBody(app);
    const select = layer?.querySelector<HTMLSelectElement>(".cb-composer select");
    if (select) select.append(h("option", { value: name, text: name }));
  } catch (error) {
    failure(error);
  }
}

function card(app: App, post: BoardPost): HTMLElement {
  const s = state!;
  const slug = s.board.slug;
  const canDelete = s.isOwner || Boolean(postKeyOf(post.id));
  const liked = hasLiked(post.id);
  const commentsOpen = s.openComments.has(post.id);

  let link: HTMLElement | null = null;
  if (post.link) {
    let host = post.link;
    try {
      host = new URL(post.link).hostname;
    } catch {
      // Shown as written.
    }
    link = h("a", { class: "cb-link", href: post.link, target: "_blank", rel: "noopener noreferrer" }, [
      h("span", { class: "cb-link-icon", text: "🔗" }),
      h("span", { class: "cb-link-meta" }, [h("span", { class: "cb-link-host", text: host }), h("span", { class: "cb-link-url", text: post.link })]),
      h("span", { class: "cb-link-go", text: "↗" }),
    ]);
  }

  let file: HTMLElement | null = null;
  if (post.file) {
    const f = post.file;
    if (INLINE_IMAGES.includes(f.type)) {
      file = h("a", { class: "cb-image", href: fileUrl(slug, f), target: "_blank", rel: "noopener" }, [
        h("img", { src: fileUrl(slug, f), alt: f.name, loading: "lazy" }),
      ]);
    } else {
      file = h("div", { class: "cb-file" }, [
        h("span", { class: "cb-file-icon", text: fileIcon(f) }),
        h("span", { class: "cb-link-meta" }, [h("span", { class: "cb-link-host", text: f.name }), h("span", { class: "cb-link-url", text: sizeLabel(f.size) })]),
        f.type === "application/pdf" ? h("a", { class: "cb-btn is-small", href: fileUrl(slug, f), target: "_blank", rel: "noopener", text: t("View") }) : null,
        h("a", { class: "cb-btn is-small is-primary", href: fileUrl(slug, f, true), text: t("Download") }),
      ]);
    }
  }

  const comments = commentsOpen
    ? h("div", { class: "cb-comments" }, [
        ...post.comments.map((comment) => h("p", { class: "cb-comment" }, [h("b", { text: comment.author }), ` ${comment.content}`])),
        h("form", {
          class: "cb-comment-form",
          onsubmit: async (event: Event) => {
            event.preventDefault();
            const input = (event.target as HTMLFormElement).querySelector("input")!;
            const content = input.value.trim();
            if (!content) return;
            try {
              await commentOnBoardPost(slug, post.id, authorName() || t("Anonymous"), content);
              input.value = "";
              await refresh(app, true);
            } catch (error) {
              failure(error);
            }
          },
        }, [h("input", { class: "cb-input", placeholder: t("Write a comment"), maxlength: "1000" }), h("button", { class: "cb-btn is-small is-primary", type: "submit", text: t("Post") })]),
      ])
    : null;

  return h("article", { class: `cb-card cb-${post.color}`, dataset: { post: String(post.id) } }, [
    h("div", { class: "cb-card-meta" }, [h("span", {}, [h("b", { text: post.author }), ` · ${post.section}`]), h("span", { text: timeLabel(post.createdAt) })]),
    post.title ? h("h3", { class: "cb-card-title", text: post.title }) : null,
    post.content ? h("p", { class: "cb-card-text", text: post.content }) : null,
    link,
    file,
    h("div", { class: "cb-card-foot" }, [
      h("div", {}, [
        h("button", {
          class: `cb-act${liked ? " is-active" : ""}`,
          type: "button",
          text: `❤️ ${post.likes}`,
          disabled: liked,
          onclick: async () => {
            try {
              post.likes = await likeBoardPost(slug, post.id);
              renderBody(app);
            } catch (error) {
              failure(error);
            }
          },
        }),
        h("button", {
          class: "cb-act",
          type: "button",
          text: `💬 ${post.comments.length}`,
          onclick: () => {
            if (commentsOpen) s.openComments.delete(post.id);
            else s.openComments.add(post.id);
            renderBody(app);
          },
        }),
      ]),
      canDelete
        ? h("button", {
            class: "cb-act",
            type: "button",
            text: "🗑",
            title: t("Remove this post"),
            onclick: () =>
              openConfirmDialog(t("Remove this post"), t("Remove this post from the board for everyone?"), t("Remove"), async () => {
                try {
                  await deleteBoardPost(slug, post.id);
                  await refresh(app, true);
                } catch (error) {
                  failure(error);
                }
              }),
          })
        : null,
    ]),
    comments,
  ]);
}

/** The inline composer: a card that opens in place and stays open while used. */
function composer(app: App): HTMLElement {
  const s = state!;
  let color: BoardColor = "yellow";
  let file: File | null = null;

  const wrap = h("div", { class: "cb-composer-wrap" });
  const collapsed = h("button", {
    class: "cb-composer-collapsed",
    type: "button",
    text: s.board.locked && !s.isOwner ? t("This board is locked") : t("＋ Write a post-it — text, a link to your site, or a file (drop it here)"),
    disabled: s.board.locked && !s.isOwner,
  });
  const authorInput = h("input", { class: "cb-input", placeholder: t("Your name"), value: authorName(), maxlength: "40" }) as HTMLInputElement;
  const sectionSelect = h(
    "select",
    { class: "cb-input" },
    s.board.sections.map((section) => h("option", { value: section, text: section, selected: section === s.filter })),
  ) as HTMLSelectElement;
  const titleInput = h("input", { class: "cb-input is-title", placeholder: t("Title"), maxlength: "200" }) as HTMLInputElement;
  const textInput = h("textarea", { class: "cb-input", rows: "3", placeholder: t("Write something, or drop a file onto this card"), maxlength: "5000" }) as HTMLTextAreaElement;
  const linkInput = h("input", { class: "cb-input", type: "url", placeholder: t("🔗 Link to a site you made, or a reference (optional)"), maxlength: "2000" }) as HTMLInputElement;
  const fileName = h("span", { class: "cb-file-name" });
  const fileInput = h("input", { type: "file", hidden: true }) as HTMLInputElement;
  const submit = h("button", { class: "cb-btn is-primary", type: "button", text: t("Post to the board") }) as HTMLButtonElement;

  const cardEl = h("div", { class: "cb-composer cb-yellow" }, [
    h("div", { class: "cb-row" }, [authorInput, sectionSelect]),
    titleInput,
    textInput,
    linkInput,
    h("div", { class: "cb-row is-spread" }, [
      h("div", { class: "cb-row" }, [
        ...BOARD_COLORS.map((name) =>
          h("button", {
            class: `cb-dot cb-${name}${name === color ? " is-active" : ""}`,
            type: "button",
            title: t(name),
            "aria-label": t(name),
            onclick: (event: Event) => {
              color = name;
              cardEl.className = `cb-composer cb-${name}`;
              cardEl.querySelectorAll(".cb-dot").forEach((dot) => dot.classList.remove("is-active"));
              (event.currentTarget as HTMLElement).classList.add("is-active");
            },
          }),
        ),
        h("label", { class: "cb-btn is-small" }, [t("📎 File"), fileInput]),
        fileName,
      ]),
      h("div", { class: "cb-row" }, [h("button", { class: "cb-btn", type: "button", text: t("Close"), onclick: () => close() }), submit]),
    ]),
  ]);
  cardEl.hidden = true;

  const setFile = (next: File | null) => {
    if (next && next.size > MAX_FILE_BYTES) {
      failure(new Error("The file is larger than 50 MB"));
      return;
    }
    file = next;
    fileName.textContent = next ? `📎 ${next.name} (${sizeLabel(next.size)})` : "";
  };
  const open = () => {
    collapsed.hidden = true;
    cardEl.hidden = false;
    titleInput.focus();
  };
  const close = () => {
    cardEl.hidden = true;
    collapsed.hidden = false;
  };
  collapsed.addEventListener("click", open);
  fileInput.addEventListener("change", () => setFile(fileInput.files?.[0] ?? null));
  for (const target of [collapsed, cardEl]) {
    target.addEventListener("dragover", (event) => {
      event.preventDefault();
      cardEl.classList.add("is-dragover");
    });
    target.addEventListener("dragleave", () => cardEl.classList.remove("is-dragover"));
    target.addEventListener("drop", (event) => {
      event.preventDefault();
      cardEl.classList.remove("is-dragover");
      const dropped = (event as DragEvent).dataTransfer?.files?.[0];
      if (dropped) {
        open();
        setFile(dropped);
      }
    });
  }

  submit.addEventListener("click", async () => {
    const title = titleInput.value.trim();
    const content = textInput.value.trim();
    const link = linkInput.value.trim();
    if (!title && !content && !link && !file) {
      failure(new Error("Write a title, some text, a link or attach a file"));
      return;
    }
    const author = authorInput.value.trim();
    if (author) rememberAuthor(author);
    submit.disabled = true;
    submit.textContent = t("Posting…");
    try {
      const stored = file ? await uploadBoardFile(s.board.slug, file) : null;
      await createBoardPost(s.board.slug, {
        author: author || t("Anonymous"),
        section: sectionSelect.value,
        title,
        content,
        color,
        link: link || undefined,
        file: stored,
      });
      titleInput.value = "";
      textInput.value = "";
      linkInput.value = "";
      fileInput.value = "";
      setFile(null);
      close();
      await refresh(app, true);
    } catch (error) {
      failure(error);
    } finally {
      submit.disabled = false;
      submit.textContent = t("Post to the board");
    }
  });

  wrap.append(collapsed, cardEl);
  return wrap;
}

/** Inline **bold** and `code`, as DOM nodes — never as HTML. */
function inlineMarkdown(text: string): (Node | string)[] {
  const parts: (Node | string)[] = [];
  const pattern = /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[3] !== undefined) parts.push(h("code", { text: match[3] }));
    else parts.push(h("strong", { text: match[1] ?? match[2] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * The AI's answer as headings, lists and bold text. Models write markdown
 * whatever they are told, and shown raw it is a page of asterisks. Built
 * from DOM nodes only, so nothing in the answer can run as markup.
 */
export function renderMarkdown(source: string): HTMLElement {
  const root = h("div", { class: "cb-md" });
  let list: HTMLElement | null = null;
  const closeList = () => {
    list = null;
  };
  for (const raw of source.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      closeList();
      root.append(h("hr"));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line);
    if (heading) {
      closeList();
      root.append(h("h3", {}, inlineMarkdown(heading[1].replace(/\*\*/g, ""))));
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag);
        root.append(list);
      }
      list.append(h("li", {}, inlineMarkdown((bullet ?? numbered)![1])));
      continue;
    }
    closeList();
    root.append(h("p", {}, inlineMarkdown(line)));
  }
  return root;
}

async function runAi(slug: string, mode: "summary" | "quiz"): Promise<void> {
  const output = h("div", { class: "cb-ai-text", text: t("Reading the board…") });
  const backdrop = h("div", { class: "modal-backdrop", onclick: (event: MouseEvent) => event.target === backdrop && backdrop.remove() }, [
    h("div", { class: "modal island cb-ai" }, [
      h("div", { class: "modal-header" }, [
        h("h2", { text: mode === "quiz" ? t("📝 AI quiz") : t("✨ AI summary") }),
        h("button", { class: "cb-btn", type: "button", text: "✕", onclick: () => backdrop.remove() }),
      ]),
      output,
    ]),
  ]);
  document.body.appendChild(backdrop);
  try {
    output.replaceChildren(renderMarkdown(await askBoardAi(slug, mode)));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    output.textContent = t(/not configured/.test(text) ? "AI is not set up on this server yet" : text);
  }
}

function openBoardList(app: App): void {
  const boards = knownBoards();
  const close = () => backdrop.remove();
  const list = boards.length
    ? boards.map((board) =>
        h("div", { class: "cb-board-row" }, [
          h("span", {}, [h("b", { text: board.title }), board.ownerKey ? h("span", { class: "cb-badge", text: t("mine") }) : null]),
          h("button", {
            class: "cb-btn is-small is-primary",
            type: "button",
            text: t("Open"),
            onclick: () => {
              close();
              void openBoardBySlug(app, board.slug);
            },
          }),
        ]),
      )
    : [h("p", { class: "cb-empty", text: t("No boards yet") })];
  const backdrop = h("div", { class: "modal-backdrop", onclick: (event: MouseEvent) => event.target === backdrop && close() }, [
    h("div", { class: "modal island cb-ai" }, [
      h("div", { class: "modal-header" }, [h("h2", { text: t("📂 My boards") }), h("button", { class: "cb-btn", type: "button", text: "✕", onclick: close })]),
      h("p", { class: "cb-hint", text: t("Boards you made or opened in this browser. Each one is paired with a canvas.") }),
      ...list,
    ]),
  ]);
  document.body.appendChild(backdrop);
}
