/**
 * AXPad Classroom Board + Cloudflare X-Ray Learning Overlay
 * Mounted cleanly alongside the full axdraw infinite canvas engine.
 */
import type { App } from "./app";

const DEFAULT_SECTIONS = [
  "1교시: 개념 이해",
  "2교시: 실습 미션",
  "질문 있어요 🙋",
  "아이디어 / 피드백 💡",
];

interface TraceItem {
  service: string;
  action: string;
  durationMs?: number;
  detail?: string;
  explain?: string;
  time?: string;
}

interface PostItem {
  id: number;
  section: string;
  author: string;
  title: string;
  content: string;
  color: string;
  media_key?: string | null;
  media_type?: string | null;
  media_name?: string | null;
  media_size?: number | null;
  link_url?: string | null;
  likes: number;
  comments?: Array<{ id: number; author: string; content: string }>;
}

interface BoardInfo {
  slug: string;
  title: string;
  notice: string;
  locked: boolean;
  sections: string[];
}

function escapeHtml(str: unknown): string {
  return String(str ?? "").replace(/[&<>"']/g, (m) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[m] ?? m;
  });
}

function badgeClass(service: string): string {
  const s = (service || "").toLowerCase();
  if (s.includes("zero") || s.includes("access") || s.includes("secret")) return "axp-b-zt";
  if (s.includes("d1")) return "axp-b-d1";
  if (s.includes("kv")) return "axp-b-kv";
  if (s.includes("r2")) return "axp-b-r2";
  if (s.includes("ai")) return "axp-b-ai";
  return "axp-b-pages";
}

const STYLE_CSS = `
.axp-mode-bar {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 60;
  display: flex; align-items: center; gap: 4px; padding: 5px 6px;
  background: var(--island-bg); border: 1px solid var(--island-border);
  border-radius: 14px; box-shadow: var(--shadow);
  backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass);
  font-family: var(--font-ui);
}
.axp-btn {
  display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 11px;
  border: none; border-radius: 9px; background: transparent; color: var(--text);
  font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  text-decoration: none; white-space: nowrap; transition: background 0.14s, transform 0.12s;
}
.axp-btn:hover { background: var(--button-hover); }
.axp-btn:active { transform: scale(0.95); }
.axp-btn.active { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
.axp-btn.primary { background: var(--accent); color: #fff; font-weight: 600; }
.axp-btn.primary:hover { background: var(--accent-strong); color: #fff; }
.axp-sep { width: 1px; height: 18px; background: var(--separator); margin: 0 2px; }

/* Padlet Board Overlay */
.axp-board-layer {
  position: fixed; inset: 0; z-index: 50; display: none; flex-direction: column;
  background: var(--bg, #f8f9fb);
  background-image: radial-gradient(rgba(128,128,128,0.16) 1px, transparent 1px);
  background-size: 24px 24px;
  padding: 68px 24px 84px 24px; overflow: auto;
  font-family: var(--font-ui); color: var(--text);
}
:root[data-theme="dark"] .axp-board-layer { background-color: #121214; }
.axp-board-layer.open { display: flex; }
.axp-board-layer.with-xray { padding-right: 404px; }

.axp-header-row {
  max-width: 1240px; width: 100%; margin: 0 auto 14px auto;
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
}
.axp-pill-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.axp-pill {
  padding: 6px 13px; border-radius: 999px; font-size: 12.5px; font-weight: 500;
  background: var(--island-bg); border: 1px solid var(--island-border); color: var(--text-muted);
  cursor: pointer; font-family: inherit; backdrop-filter: var(--glass);
}
.axp-pill:hover { color: var(--text); border-color: var(--accent); }
.axp-pill.active { background: var(--text); color: var(--island-bg); border-color: var(--text); font-weight: 600; }
.axp-pill.add { border-style: dashed; color: var(--accent); font-weight: 600; }

.axp-wall {
  max-width: 1240px; width: 100%; margin: 0 auto;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; align-items: start;
}
.axp-shelf {
  display: flex; gap: 16px; align-items: flex-start; min-height: 60vh; padding-bottom: 24px;
}
.axp-col {
  min-width: 296px; max-width: 316px; background: var(--island-bg);
  border: 1px solid var(--island-border); border-radius: 16px; padding: 14px;
  display: flex; flex-direction: column; gap: 12px; backdrop-filter: var(--glass);
}
.axp-col-title { font-size: 13.5px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
.axp-col-add {
  min-width: 230px; border: 2px dashed var(--separator); border-radius: 16px; padding: 24px 16px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  color: var(--text-muted); font-weight: 600; font-size: 13.5px;
}
.axp-col-add:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

.axp-card {
  border-radius: 15px; padding: 16px; border: 1px solid rgba(0,0,0,0.06);
  box-shadow: 0 2px 10px rgba(0,0,0,0.05); display: flex; flex-direction: column; gap: 8px;
}
.axp-c-white { background: #fff; color: #1d1d1f; }
.axp-c-yellow { background: #fef7cd; color: #1d1d1f; }
.axp-c-mint { background: #dcfce7; color: #1d1d1f; }
.axp-c-blue { background: #e0f2fe; color: #1d1d1f; }
.axp-c-pink { background: #fce7f3; color: #1d1d1f; }
.axp-c-purple { background: #ede9fe; color: #1d1d1f; }
:root[data-theme="dark"] .axp-c-white { background: #232326; color: #f5f5f7; }
:root[data-theme="dark"] .axp-c-yellow { background: #3b3519; color: #fef9c3; }
:root[data-theme="dark"] .axp-c-mint { background: #143326; color: #d1fae5; }
:root[data-theme="dark"] .axp-c-blue { background: #132c42; color: #e0f2fe; }
:root[data-theme="dark"] .axp-c-pink { background: #3b192d; color: #fce7f3; }
:root[data-theme="dark"] .axp-c-purple { background: #291e42; color: #ede9fe; }

.axp-card-meta { display: flex; justify-content: space-between; font-size: 11.5px; opacity: 0.7; }
.axp-card-title { margin: 0; font-size: 15.5px; font-weight: 700; line-height: 1.4; }
.axp-card-body { margin: 0; font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; opacity: 0.88; }
.axp-card img { width: 100%; border-radius: 10px; max-height: 210px; object-fit: contain; background: #fff; }
.axp-link-card {
  display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 10px;
  background: rgba(255,255,255,0.68); border: 1px solid rgba(0,0,0,0.08);
  text-decoration: none; color: inherit; transition: background 0.14s, transform 0.12s;
}
:root[data-theme="dark"] .axp-link-card { background: rgba(0,0,0,0.28); border-color: rgba(255,255,255,0.12); }
.axp-link-card:hover { background: rgba(255,255,255,0.92); transform: translateY(-1px); }
.axp-link-card img { width: 22px; height: 22px; border-radius: 5px; flex-shrink: 0; background: transparent; }
.axp-link-meta { min-width: 0; flex: 1; }
.axp-link-host { font-size: 12.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.axp-link-url { font-size: 11px; opacity: 0.65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Google Keep / Padlet Inline Post-it Composer (never closes on drag!) */
.axp-composer-wrap { max-width: 720px; width: 100%; margin: 0 auto 20px auto; }
.axp-composer-collapsed {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 12px 16px; border-radius: 14px; cursor: text;
  background: var(--island-bg); border: 1px solid var(--island-border); box-shadow: var(--shadow);
  backdrop-filter: var(--glass); color: var(--text-muted); font-size: 13.5px; font-weight: 500;
}
.axp-composer-collapsed:hover { border-color: var(--accent); color: var(--text); }
.axp-composer-card {
  display: none; flex-direction: column; gap: 10px; padding: 16px 18px; border-radius: 16px;
  border: 1px solid rgba(0,0,0,0.1); box-shadow: 0 8px 28px rgba(0,0,0,0.1); transition: background 0.18s;
}
.axp-composer-card.open { display: flex; }
.axp-composer-card.dragover { outline: 2.5px dashed var(--accent); outline-offset: 2px; }
.axp-composer-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.axp-composer-input {
  width: 100%; padding: 8px 11px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.12);
  background: rgba(255,255,255,0.72); color: #1d1d1f; font-family: inherit; font-size: 13.5px; outline: none;
}
.axp-composer-input:focus { border-color: var(--accent); background: #fff; }
:root[data-theme="dark"] .axp-composer-input { background: rgba(0,0,0,0.3); color: #f5f5f7; border-color: rgba(255,255,255,0.15); }
.axp-color-dot {
  width: 24px; height: 24px; border-radius: 50%; border: 2px solid rgba(0,0,0,0.15); cursor: pointer; transition: transform 0.12s;
}
.axp-color-dot.active { border-color: var(--accent); transform: scale(1.18); }
.axp-card-foot { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px solid rgba(0,0,0,0.06); }
.axp-act { border: none; background: transparent; color: inherit; opacity: 0.75; padding: 4px 8px; border-radius: 7px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.axp-act:hover { opacity: 1; background: rgba(0,0,0,0.06); }

.axp-bottom-cta {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 55;
  display: none; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 999px;
  background: var(--island-bg); border: 1px solid var(--island-border); box-shadow: var(--shadow);
  backdrop-filter: var(--glass);
}
.axp-bottom-cta.open { display: flex; }

/* X-Ray Floating Drawer */
.axp-xray {
  position: fixed; top: 64px; right: 14px; bottom: 14px; width: 370px; z-index: 65;
  display: none; flex-direction: column; overflow: hidden; border-radius: 16px;
  background: var(--island-bg); border: 1px solid var(--island-border); box-shadow: var(--shadow);
  backdrop-filter: var(--glass); font-family: var(--font-ui); color: var(--text);
}
.axp-xray.open { display: flex; }
.axp-xray-head { padding: 12px 14px; border-bottom: 1px solid var(--separator); display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: 13.5px; }
.axp-xray-body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.axp-trace { background: var(--island-bg); border: 1px solid var(--island-border); border-radius: 12px; padding: 11px; font-size: 12px; }
.axp-code { background: rgba(0,0,0,0.05); color: var(--accent-strong); font-family: ui-monospace, Consolas, monospace; font-size: 11px; padding: 6px 8px; border-radius: 7px; margin: 5px 0; white-space: pre-wrap; word-break: break-all; }
.axp-badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 6px; display: inline-flex; align-items: center; }
.axp-b-pages { background: rgba(243,128,32,0.14); color: #d96b10; }
.axp-b-d1 { background: rgba(0,113,227,0.12); color: #0066cc; }
.axp-b-kv { background: rgba(16,185,129,0.14); color: #047857; }
.axp-b-r2 { background: rgba(219,39,119,0.12); color: #be185d; }
.axp-b-ai { background: rgba(124,58,237,0.13); color: #6d28d9; }
.axp-b-zt { background: rgba(234,88,12,0.14); color: #c2410c; }

/* Modal */
.axp-modal-bg {
  position: fixed; inset: 0; background: rgba(0,0,0,0.38); backdrop-filter: blur(6px);
  display: none; align-items: center; justify-content: center; z-index: 120; padding: 16px;
}
.axp-modal-bg.open { display: flex; }
.axp-modal {
  background: var(--island-bg); color: var(--text); border: 1px solid var(--island-border);
  backdrop-filter: blur(24px); border-radius: 18px; width: 100%; max-width: 520px; max-height: 90vh;
  overflow-y: auto; padding: 20px; box-shadow: 0 24px 60px rgba(0,0,0,0.25); font-family: var(--font-ui);
}
.axp-modal h3 { margin: 0 0 14px 0; font-size: 16.5px; display: flex; justify-content: space-between; align-items: center; }
.axp-field { margin-bottom: 12px; }
.axp-field label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 4px; }
.axp-field input, .axp-field textarea, .axp-field select {
  width: 100%; padding: 9px 11px; border: 1px solid var(--island-border); border-radius: 10px;
  font-size: 13.5px; font-family: inherit; background: rgba(255,255,255,0.85); color: #1d1d1f;
}
:root[data-theme="dark"] .axp-field input,
:root[data-theme="dark"] .axp-field textarea,
:root[data-theme="dark"] .axp-field select { background: #1c1c1e; color: #f5f5f7; }
`;

export function mountAxPad(app: App): void {
  // Inject scoped CSS
  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE_CSS;
  document.head.appendChild(styleEl);

  // Rebrand .brand text from axdraw -> axpad if present
  setTimeout(() => {
    const brand = document.querySelector(".brand");
    if (brand && brand.textContent?.trim().toLowerCase() === "axdraw") {
      brand.textContent = "axpad";
    }
  }, 150);

  const urlParams = new URLSearchParams(location.search);
  const state = {
    mode: (urlParams.get("mode") === "board" ? "board" : "canvas") as "canvas" | "board",
    boardSlug: (urlParams.get("board") || "AX2026").toUpperCase(),
    view: "wall" as "wall" | "shelf",
    filter: "ALL",
    xrayOpen: false,
    board: { slug: "AX2026", title: "Cloudflare 학습 보드", notice: "", locked: false, sections: DEFAULT_SECTIONS } as BoardInfo,
    posts: [] as PostItem[],
    logs: [] as TraceItem[],
    visits: 0,
    edgeText: "Edge",
  };

  const addTraces = (t?: TraceItem | TraceItem[] | null) => {
    if (!t) return;
    (Array.isArray(t) ? t : [t]).forEach((item) =>
      state.logs.unshift({ ...item, time: new Date().toLocaleTimeString("ko-KR") }),
    );
    renderXray();
  };

  // 1. Top-Center Floating Mode Switcher (with 1:1 paired board indicator)
  const modeBar = document.createElement("div");
  modeBar.className = "axp-mode-bar";
  modeBar.innerHTML = `
    <button id="axpModeCanvas" class="axp-btn active" type="button">🎨 판서 캔버스</button>
    <button id="axpModeBoard" class="axp-btn" type="button">📋 강의 게시판</button>
    <span id="axpPairBadge" class="axp-badge axp-b-d1" title="현재 판서 캔버스와 강의 게시판이 1:1 연결됨" style="cursor:pointer;">🔗 AX2026</span>
    <span class="axp-sep"></span>
    <button id="axpToggleXray" class="axp-btn" type="button">🔬 X-Ray (<span id="axpLogCnt">0</span>)</button>
    <a href="/guide" class="axp-btn" title="Cloudflare 초보자 쉬운 안내서">📖 가이드</a>
  `;
  document.body.appendChild(modeBar);

  // 2. Padlet Board Layer
  const boardLayer = document.createElement("div");
  boardLayer.className = "axp-board-layer";
  boardLayer.innerHTML = `
    <div class="axp-header-row">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <button id="axpBtnBoards" class="axp-btn" style="background:var(--island-bg);border:1px solid var(--island-border);">📂 <span id="axpBoardTitle">불러오는 중...</span> ▾</button>
        <button id="axpViewWall" class="axp-btn active">🧱 Wall</button>
        <button id="axpViewShelf" class="axp-btn">📋 Shelf</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);">
        <span id="axpEdge" class="axp-badge axp-b-pages">🌐 Edge</span>
        <span id="axpVisits" class="axp-badge axp-b-kv">⚡ KV -</span>
        <button id="axpCopyLink" class="axp-btn" style="height:26px;font-size:11.5px;">🔗 링크 복사</button>
      </div>
    </div>
    <div class="axp-header-row" style="margin-bottom:16px;">
      <div id="axpPills" class="axp-pill-row"></div>
      <div style="display:flex;align-items:center;gap:6px;">
        <input id="axpVecInput" placeholder="🧠 AI 의미 검색 (Vectorize)..." style="height:32px;padding:0 11px;border-radius:999px;border:1px solid var(--island-border);background:var(--island-bg);color:var(--text);font-size:12.5px;width:210px;font-family:inherit;" />
        <button id="axpVecBtn" class="axp-btn primary" style="height:32px;border-radius:999px;font-size:12px;">검색</button>
        <button id="axpVecSync" class="axp-btn" style="height:32px;border-radius:999px;font-size:12px;border:1px solid var(--island-border);" title="모든 포스트잇을 Vectorize에 색인">🔄 색인</button>
      </div>
    </div>
    <div class="axp-composer-wrap">
      <div id="axpCompCollapsed" class="axp-composer-collapsed">
        <span>＋ 여기에 바로 포스트잇 작성하기... (텍스트 · 🔗 사이트 링크 · 📎 PDF/PPT/문서/이미지 드래그)</span>
        <span class="axp-badge axp-b-d1">D1 + R2</span>
      </div>
      <div id="axpCompCard" class="axp-composer-card axp-c-yellow">
        <div class="axp-composer-row">
          <input id="axpCAuthor" class="axp-composer-input" style="flex:1;min-width:120px;" value="수강생" placeholder="닉네임" />
          <select id="axpCSec" class="axp-composer-input" style="flex:1.2;min-width:150px;"></select>
        </div>
        <input id="axpCTitle" class="axp-composer-input" style="font-weight:700;" placeholder="제목 (예: 1주차 강의 자료 PDF / 내가 만든 사이트)" />
        <textarea id="axpCBody" class="axp-composer-input" rows="3" placeholder="내용을 적거나 PDF·PPT·문서·압축파일·이미지를 이 카드 위로 끌어다 놓으세요!"></textarea>
        <input id="axpCLink" class="axp-composer-input" type="url" placeholder="🔗 내가 만든 사이트 또는 참고 링크 (예: https://내사이트.pages.dev)" />
        <div class="axp-composer-row" style="justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <div class="axp-color-dot axp-c-yellow active" data-cc="yellow" title="노랑"></div>
            <div class="axp-color-dot axp-c-blue" data-cc="blue" title="파랑"></div>
            <div class="axp-color-dot axp-c-mint" data-cc="mint" title="민트"></div>
            <div class="axp-color-dot axp-c-pink" data-cc="pink" title="핑크"></div>
            <div class="axp-color-dot axp-c-purple" data-cc="purple" title="보라"></div>
            <div class="axp-color-dot axp-c-white" data-cc="white" title="화이트"></div>
            <label class="axp-btn" style="height:28px;font-size:12px;border:1px solid rgba(0,0,0,0.12);background:rgba(255,255,255,0.65);cursor:pointer;">
              📎 파일/이미지 <input type="file" id="axpCFile" style="display:none;" />
            </label>
            <span id="axpCFileName" style="font-size:11.5px;opacity:0.75;"></span>
          </div>
          <div style="display:flex;gap:6px;">
            <button id="axpCClose" class="axp-btn" type="button" style="height:32px;">접기</button>
            <button id="axpCSubmit" class="axp-btn primary" type="button" style="height:32px;padding:0 14px;">🚀 보드에 올리기</button>
          </div>
        </div>
      </div>
    </div>
    <div id="axpCardsHost" class="axp-wall"></div>
  `;
  document.body.appendChild(boardLayer);

  // 3. Bottom CTA (visible only in Board mode)
  const bottomCta = document.createElement("div");
  bottomCta.className = "axp-bottom-cta";
  bottomCta.innerHTML = `
    <button id="axpNewPost" class="axp-btn primary" style="border-radius:999px;padding:0 16px;">＋ 포스트잇 올리기</button>
    <button id="axpAiSummary" class="axp-btn" style="border-radius:999px;">✨ AI 요약</button>
    <button id="axpAiQuiz" class="axp-btn" style="border-radius:999px;">📝 AI 퀴즈</button>
  `;
  document.body.appendChild(bottomCta);

  // 4. Floating X-Ray Drawer
  const xrayDrawer = document.createElement("aside");
  xrayDrawer.className = "axp-xray";
  xrayDrawer.innerHTML = `
    <div class="axp-xray-head">
      <span>🔬 Cloudflare X-Ray 실시간 로그</span>
      <button id="axpCloseXray" class="axp-btn" style="height:26px;padding:0 8px;">✕</button>
    </div>
    <div id="axpXrayBody" class="axp-xray-body"></div>
  `;
  document.body.appendChild(xrayDrawer);

  // 5. Generic Modal Host (safe pointerdown guard so dragging text NEVER closes modal!)
  const modalBg = document.createElement("div");
  modalBg.className = "axp-modal-bg";
  modalBg.innerHTML = `<div id="axpModalBox" class="axp-modal"></div>`;
  let modalDownOnBackdrop = false;
  modalBg.addEventListener("pointerdown", (e) => {
    modalDownOnBackdrop = e.target === modalBg;
  });
  modalBg.addEventListener("click", (e) => {
    if (e.target === modalBg && modalDownOnBackdrop) modalBg.classList.remove("open");
    modalDownOnBackdrop = false;
  });
  document.body.appendChild(modalBg);

  const openModal = (innerHtml: string) => {
    const box = document.getElementById("axpModalBox")!;
    box.innerHTML = innerHtml;
    modalBg.classList.add("open");
  };
  const closeModal = () => modalBg.classList.remove("open");

  const renderXray = () => {
    const cnt = document.getElementById("axpLogCnt");
    if (cnt) cnt.textContent = String(state.logs.length);
    const body = document.getElementById("axpXrayBody");
    if (!body) return;
    body.innerHTML =
      state.logs
        .map(
          (l) => `
      <div class="axp-trace">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span class="axp-badge ${badgeClass(l.service)}">${escapeHtml(l.service)}</span>
          <span style="opacity:.65;font-size:11px;">${l.durationMs !== undefined ? l.durationMs + "ms · " : ""}${escapeHtml(l.time)}</span>
        </div>
        <div style="font-weight:700;margin-bottom:4px;">${escapeHtml(l.action)}</div>
        ${l.detail ? `<div class="axp-code">${escapeHtml(l.detail)}</div>` : ""}
        <div style="opacity:.8;line-height:1.45;">${escapeHtml(l.explain)}</div>
      </div>`,
        )
        .join("") || `<div style="opacity:.6;font-size:12.5px;">강의 게시판을 열거나 버튼을 누르면 실제 Cloudflare(D1·KV·R2·Workers AI) 동작이 여기 기록됩니다.</div>`;
  };

  const syncModeUI = () => {
    const isBoard = state.mode === "board";
    document.getElementById("axpModeCanvas")!.classList.toggle("active", !isBoard);
    document.getElementById("axpModeBoard")!.classList.toggle("active", isBoard);
    boardLayer.classList.toggle("open", isBoard);
    bottomCta.classList.toggle("open", isBoard);
    xrayDrawer.classList.toggle("open", state.xrayOpen);
    boardLayer.classList.toggle("with-xray", state.xrayOpen);
    document.getElementById("axpToggleXray")!.classList.toggle("active", state.xrayOpen);
  };

  const renderPills = () => {
    const secs = state.board.sections.length ? state.board.sections : DEFAULT_SECTIONS;
    const host = document.getElementById("axpPills")!;
    host.innerHTML = "";
    const makePill = (label: string, active: boolean, onClick: () => void, extraClass = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `axp-pill ${active ? "active" : ""} ${extraClass}`.trim();
      b.textContent = label;
      b.onclick = onClick;
      host.appendChild(b);
    };
    makePill("전체 보기", state.filter === "ALL", () => {
      state.filter = "ALL";
      renderPills();
      renderCards();
    });
    secs.forEach((s) =>
      makePill(s, state.filter === s, () => {
        state.filter = s;
        renderPills();
        renderCards();
      }),
    );
    makePill("＋ 카테고리", false, () => void quickAddCategory(), "add");
    const cSec = document.getElementById("axpCSec") as HTMLSelectElement | null;
    if (cSec) {
      const prev = cSec.value;
      cSec.innerHTML = secs.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
      if (prev && secs.includes(prev)) cSec.value = prev;
    }
  };

  const quickAddCategory = async () => {
    const name = prompt("새 카테고리 이름을 입력하세요 (D1 클라우드 즉시 저장):");
    if (!name || !name.trim()) return;
    const secs = [...state.board.sections];
    if (!secs.includes(name.trim())) secs.push(name.trim());
    const res = await fetch(`/api/boards/${encodeURIComponent(state.boardSlug)}/sections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections: secs }),
    });
    const data = await res.json();
    if (data.ok) {
      state.board.sections = secs;
      addTraces(data.trace);
      renderPills();
      renderCards();
    }
  };

  const renderCards = () => {
    const host = document.getElementById("axpCardsHost")!;
    const list = state.filter === "ALL" ? state.posts : state.posts.filter((p) => p.section === state.filter);
    const renderLinkCard = (rawUrl?: string | null) => {
      if (!rawUrl) return "";
      let href = rawUrl.trim();
      if (!/^https?:\/\//i.test(href)) href = "https://" + href;
      let host = href;
      try {
        host = new URL(href).hostname;
      } catch {}
      const fav = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`;
      return `<a class="axp-link-card" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
        <img src="${fav}" alt="" />
        <div class="axp-link-meta">
          <div class="axp-link-host">${escapeHtml(host)}</div>
          <div class="axp-link-url">${escapeHtml(href)}</div>
        </div>
        <span style="font-size:12px;font-weight:700;opacity:.75;">↗</span>
      </a>`;
    };
    const renderMedia = (p: PostItem) => {
      if (!p.media_key) return "";
      const url = `/api/media/${encodeURIComponent(p.media_key)}`;
      const isImg =
        (p.media_type && p.media_type.startsWith("image/")) ||
        /\.(png|jpe?g|gif|webp|svg)$/i.test(p.media_name || p.media_key);
      if (isImg) {
        return `<img src="${url}" loading="lazy" />`;
      }
      const fname = p.media_name || p.media_key.split("/").pop() || "첨부파일";
      const ext = fname.includes(".") ? fname.split(".").pop()!.toLowerCase() : "";
      const icon = ext === "pdf" ? "📕" : ["ppt", "pptx"].includes(ext) ? "📊" : ["xls", "xlsx", "csv"].includes(ext) ? "📗" : ["doc", "docx", "hwp", "hwpx"].includes(ext) ? "📘" : ["zip", "rar", "7z"].includes(ext) ? "🗜️" : "📄";
      const sizeStr = p.media_size ? (p.media_size > 1024 * 1024 ? (p.media_size / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(p.media_size / 1024)) + " KB") : "R2 파일";
      const isPdf = ext === "pdf" || p.media_type === "application/pdf";
      return `<div class="axp-link-card" style="justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:9px;min-width:0;flex:1;">
          <span style="font-size:20px;line-height:1;">${icon}</span>
          <div class="axp-link-meta">
            <div class="axp-link-host">${escapeHtml(fname)}</div>
            <div class="axp-link-url">${escapeHtml(sizeStr)} · Cloudflare R2</div>
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          ${isPdf ? `<a class="axp-btn" style="height:26px;font-size:11.5px;padding:0 8px;border:1px solid rgba(0,0,0,0.1);" href="${url}" target="_blank" rel="noopener">👁️ 보기</a>` : ""}
          <a class="axp-btn primary" style="height:26px;font-size:11.5px;padding:0 8px;" href="${url}?download=1">⬇️ 받기</a>
        </div>
      </div>`;
    };
    const makeCard = (p: PostItem) => `
      <div class="axp-card axp-c-${escapeHtml(p.color || "yellow")}">
        <div class="axp-card-meta"><span><b>${escapeHtml(p.author)}</b> · ${escapeHtml(p.section)}</span><span>#${p.id}</span></div>
        <h4 class="axp-card-title">${escapeHtml(p.title)}</h4>
        <p class="axp-card-body">${escapeHtml(p.content)}</p>
        ${renderLinkCard(p.link_url)}
        ${renderMedia(p)}
        <div class="axp-card-foot">
          <div>
            <button class="axp-act" data-like="${p.id}">❤️ ${p.likes}</button>
            <button class="axp-act" data-cmt="${p.id}">💬 ${(p.comments || []).length}</button>
          </div>
          <button class="axp-act" data-del="${p.id}">🗑️</button>
        </div>
      </div>`;

    if (state.view === "shelf") {
      host.className = "axp-shelf";
      const secs = [...state.board.sections];
      list.forEach((p) => {
        if (!secs.includes(p.section)) secs.push(p.section);
      });
      host.innerHTML =
        secs
          .map((s) => {
            const items = list.filter((p) => p.section === s);
            return `<div class="axp-col"><div class="axp-col-title"><span>${escapeHtml(s)}</span><span class="axp-badge axp-b-d1">${items.length}</span></div>${items.map(makeCard).join("") || `<div style="font-size:12px;opacity:.6;padding:12px;text-align:center;">카드가 없습니다</div>`}</div>`;
          })
          .join("") + `<div class="axp-col-add" id="axpShelfAdd">＋ 새 카테고리 컬럼</div>`;
      document.getElementById("axpShelfAdd")?.addEventListener("click", () => void quickAddCategory());
    } else {
      host.className = "axp-wall";
      host.innerHTML =
        list.map(makeCard).join("") ||
        `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;opacity:.65;">아직 포스트잇이 없습니다. 하단 <b>＋ 포스트잇 올리기</b>를 눌러보세요!</div>`;
    }

    host.querySelectorAll<HTMLButtonElement>("[data-like]").forEach((btn) => {
      btn.onclick = async () => {
        const id = Number(btn.dataset.like);
        const d = await (await fetch(`/api/posts/${id}/like`, { method: "POST" })).json();
        if (d.ok) {
          const item = state.posts.find((x) => x.id === id);
          if (item) item.likes = d.likes;
          addTraces(d.trace);
          renderCards();
        }
      };
    });
    host.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("이 카드를 삭제할까요?")) return;
        const id = Number(btn.dataset.del);
        const d = await (await fetch(`/api/posts/${id}`, { method: "DELETE" })).json();
        addTraces(d.traces);
        await loadBoard(state.boardSlug);
      };
    });
    host.querySelectorAll<HTMLButtonElement>("[data-cmt]").forEach((btn) => {
      btn.onclick = async () => {
        const id = Number(btn.dataset.cmt);
        const content = prompt("댓글 내용을 입력하세요 (D1 저장):");
        if (!content || !content.trim()) return;
        const author = prompt("닉네임:", "수강생") || "수강생";
        const d = await (
          await fetch(`/api/posts/${id}/comments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ author, content: content.trim() }),
          })
        ).json();
        if (d.ok) {
          addTraces(d.trace);
          await loadBoard(state.boardSlug);
        }
      };
    });
  };

  // 1:1 Sync between Classroom Board (D1 slug) and axdraw Whiteboard Canvas
  const syncCanvasToBoard = (slug: string, title: string) => {
    const cleanSlug = slug.toUpperCase();
    const tag = `[${cleanSlug}]`;
    const targetName = `${tag} ${title}`.trim();
    const badge = document.getElementById("axpPairBadge");
    if (badge) badge.textContent = `🔗 ${cleanSlug}`;

    const boards = app.listBoards();
    const matched = boards.find((b) => b.name.startsWith(tag));
    if (matched) {
      if (app.currentBoardId() !== matched.id) {
        app.openBoard(matched.id);
      }
      if (matched.name !== targetName) {
        app.renameBoard(matched.id, targetName);
      }
      return;
    }
    // If current canvas has no tag yet and is empty/default, bind it cleanly; otherwise create a paired canvas
    const curId = app.currentBoardId();
    const curName = app.currentBoardName();
    if (!/^\[[A-Z0-9_-]+\]/.test(curName) && app.boardDrawingCount(curId) === 0) {
      app.renameBoard(curId, targetName);
    } else {
      app.newBoard();
      app.renameBoard(app.currentBoardId(), targetName);
    }
  };

  const resolveSlugFromCurrentCanvas = (): string => {
    const curName = app.currentBoardName();
    const m = /^\[([A-Z0-9_-]+)\]/.exec(curName);
    if (m) return m[1];
    // If user created/switched to an untagged axdraw canvas, pair it 1:1 with a deterministic slug!
    const rawId = app.currentBoardId().replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase();
    if (!rawId) return state.boardSlug;
    const derivedSlug = `CV${rawId}`;
    const label = curName || "새 강의 보드";
    app.renameBoard(app.currentBoardId(), `[${derivedSlug}] ${label}`);
    return derivedSlug;
  };

  const loadBoard = async (slug?: string, syncCanvas = true) => {
    if (slug) {
      state.boardSlug = slug.toUpperCase();
      const u = new URL(location.href);
      u.searchParams.set("board", state.boardSlug);
      history.replaceState({}, "", u.toString());
    }
    try {
      const d = await (await fetch(`/api/board?slug=${encodeURIComponent(state.boardSlug)}`)).json();
      if (!d.ok) return;
      state.board = d.board;
      state.posts = d.posts || [];
      state.visits = d.visits || 0;
      state.edgeText = `${d.edge?.colo || "EDGE"} · ${d.edge?.country || "KR"}`;
      document.getElementById("axpBoardTitle")!.textContent = state.board.title;
      document.getElementById("axpEdge")!.textContent = `🌐 ${state.edgeText}`;
      document.getElementById("axpVisits")!.textContent = `⚡ KV ${state.visits}`;
      const badge = document.getElementById("axpPairBadge");
      if (badge) badge.textContent = `🔗 ${state.board.slug}`;
      if (syncCanvas) syncCanvasToBoard(state.board.slug, state.board.title);
      addTraces(d.traces);
      renderPills();
      renderCards();
    } catch {
      // Local vite dev without API
    }
  };

  // Wire Mode Bar & Buttons (1:1 paired switching!)
  document.getElementById("axpModeCanvas")!.onclick = () => {
    state.mode = "canvas";
    syncCanvasToBoard(state.boardSlug, state.board.title);
    syncModeUI();
  };
  document.getElementById("axpModeBoard")!.onclick = () => {
    state.mode = "board";
    const canvasSlug = resolveSlugFromCurrentCanvas();
    syncModeUI();
    void loadBoard(canvasSlug, false);
  };
  document.getElementById("axpPairBadge")!.onclick = () => {
    app.onMessage?.(`현재 판서 캔버스와 강의 게시판 [${state.boardSlug}]이(가) 1:1 연결되어 있습니다`);
  };
  document.getElementById("axpToggleXray")!.onclick = () => {
    state.xrayOpen = !state.xrayOpen;
    syncModeUI();
  };
  document.getElementById("axpCloseXray")!.onclick = () => {
    state.xrayOpen = false;
    syncModeUI();
  };
  document.getElementById("axpViewWall")!.onclick = () => {
    state.view = "wall";
    document.getElementById("axpViewWall")!.classList.add("active");
    document.getElementById("axpViewShelf")!.classList.remove("active");
    renderCards();
  };
  document.getElementById("axpViewShelf")!.onclick = () => {
    state.view = "shelf";
    document.getElementById("axpViewShelf")!.classList.add("active");
    document.getElementById("axpViewWall")!.classList.remove("active");
    renderCards();
  };
  document.getElementById("axpCopyLink")!.onclick = () => {
    const link = `${location.origin}/?mode=board&board=${encodeURIComponent(state.boardSlug)}`;
    void navigator.clipboard?.writeText(link);
    app.onMessage?.("강의 게시판 초대 링크가 복사되었습니다");
  };

  // Inline Post-it Composer (Google Keep / Padlet style — never closes on drag/outside click!)
  let compColor = "yellow";
  let droppedFile: File | null = null;
  const compCollapsed = document.getElementById("axpCompCollapsed")!;
  const compCard = document.getElementById("axpCompCard")!;
  const compFileInput = document.getElementById("axpCFile") as HTMLInputElement;
  const compFileName = document.getElementById("axpCFileName")!;

  const openInlineComposer = () => {
    compCollapsed.style.display = "none";
    compCard.classList.add("open");
    boardLayer.scrollTo({ top: 0, behavior: "smooth" });
    (document.getElementById("axpCTitle") as HTMLInputElement).focus();
  };
  const closeInlineComposer = () => {
    compCard.classList.remove("open");
    compCollapsed.style.display = "flex";
  };
  compCollapsed.onclick = openInlineComposer;
  document.getElementById("axpCClose")!.onclick = closeInlineComposer;
  document.getElementById("axpNewPost")!.onclick = openInlineComposer;

  compCard.querySelectorAll<HTMLElement>("[data-cc]").forEach((dot) => {
    dot.onclick = () => {
      compColor = dot.dataset.cc || "yellow";
      compCard.className = `axp-composer-card open axp-c-${compColor}`;
      compCard.querySelectorAll("[data-cc]").forEach((d) => d.classList.remove("active"));
      dot.classList.add("active");
    };
  });
  compFileInput.onchange = () => {
    droppedFile = compFileInput.files?.[0] || null;
    compFileName.textContent = droppedFile ? `📎 ${droppedFile.name}` : "";
  };
  compCard.addEventListener("dragover", (e) => {
    e.preventDefault();
    compCard.classList.add("dragover");
  });
  compCard.addEventListener("dragleave", () => compCard.classList.remove("dragover"));
  compCard.addEventListener("drop", (e) => {
    e.preventDefault();
    compCard.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      droppedFile = f;
      compFileName.textContent = `📎 ${f.name}`;
    }
  });

  document.getElementById("axpCSubmit")!.onclick = async () => {
    const titleEl = document.getElementById("axpCTitle") as HTMLInputElement;
    const bodyEl = document.getElementById("axpCBody") as HTMLTextAreaElement;
    const linkEl = document.getElementById("axpCLink") as HTMLInputElement;
    const authorEl = document.getElementById("axpCAuthor") as HTMLInputElement;
    const secEl = document.getElementById("axpCSec") as HTMLSelectElement;
    const btn = document.getElementById("axpCSubmit") as HTMLButtonElement;

    const title = titleEl.value.trim();
    const content = bodyEl.value.trim();
    const link_url = linkEl.value.trim();
    const author = authorEl.value.trim() || "수강생";
    const section = secEl.value || DEFAULT_SECTIONS[0];
    if (!title && !link_url && !droppedFile) return alert("제목, 링크 또는 파일을 하나 이상 입력해 주세요!");
    btn.disabled = true;
    btn.textContent = "⏳ 올리는 중...";
    try {
      let media_key: string | null = null;
      let media_type: string | null = null;
      let media_name: string | null = null;
      let media_size: number | null = null;
      if (droppedFile) {
        const fd = new FormData();
        fd.append("file", droppedFile);
        const up = await (await fetch("/api/upload", { method: "POST", body: fd })).json();
        if (up.ok) {
          media_key = up.key;
          media_type = up.type || droppedFile.type || "application/octet-stream";
          media_name = up.name || droppedFile.name;
          media_size = up.size || droppedFile.size;
          addTraces(up.trace);
        }
      }
      const d = await (
        await fetch("/api/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            board_slug: state.boardSlug,
            author,
            section,
            title: title || media_name || link_url,
            content: content || (media_name ? `📎 첨부 파일: ${media_name}` : link_url ? "내가 만든 사이트를 공유합니다!" : ""),
            color: compColor,
            media_key,
            media_type,
            media_name,
            media_size,
            link_url: link_url || null,
          }),
        })
      ).json();
      if (d.ok) {
        addTraces(d.trace);
        titleEl.value = "";
        bodyEl.value = "";
        linkEl.value = "";
        compFileInput.value = "";
        droppedFile = null;
        compFileName.textContent = "";
        closeInlineComposer();
        await loadBoard(state.boardSlug);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "🚀 보드에 올리기";
    }
  };

  // Multi-board Modal
  document.getElementById("axpBtnBoards")!.onclick = async () => {
    const bRes = await (await fetch("/api/boards")).json();
    addTraces(bRes.trace);
    const listHtml = (bRes.boards || [])
      .map(
        (b: { slug: string; title: string; post_count: number }) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 11px;border:1px solid var(--island-border);border-radius:10px;margin-bottom:6px;">
        <div><b>${escapeHtml(b.title)}</b> <span class="axp-badge axp-b-d1">${escapeHtml(b.slug)}</span> <span style="font-size:11.5px;opacity:.65;">(${b.post_count || 0})</span></div>
        <button class="axp-btn primary" style="height:26px;font-size:12px;" data-open-board="${escapeHtml(b.slug)}">열기</button>
      </div>`,
      )
      .join("");
    openModal(`
      <h3><span>📂 클라우드 게시판 목록 <span class="axp-badge axp-b-d1">D1</span></span><button class="axp-btn" id="axpBC">✕</button></h3>
      <div>${listHtml}</div>
      <div class="axp-field" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator);">
        <label>➕ 새 강의 게시판 만들기</label>
        <div style="display:flex;gap:6px;"><input id="axpNewBT" placeholder="예: 2주차 AI 실습" /><button class="axp-btn primary" id="axpNewBBtn">생성</button></div>
      </div>
    `);
    document.getElementById("axpBC")!.onclick = closeModal;
    document.querySelectorAll<HTMLButtonElement>("[data-open-board]").forEach((btn) => {
      btn.onclick = async () => {
        closeModal();
        state.filter = "ALL";
        await loadBoard(btn.dataset.openBoard!);
      };
    });
    document.getElementById("axpNewBBtn")!.onclick = async () => {
      const title = (document.getElementById("axpNewBT") as HTMLInputElement).value.trim();
      if (!title) return;
      const d = await (
        await fetch("/api/boards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        })
      ).json();
      if (d.ok) {
        addTraces(d.trace);
        closeModal();
        await loadBoard(d.slug);
      }
    };
  };

  // AI Summary / Quiz
  const runAI = async (mode: "summary" | "quiz") => {
    openModal(`<h3><span>${mode === "quiz" ? "📝 Workers AI 퀴즈" : "✨ Workers AI 보드 요약"}</span><button class="axp-btn" id="axpAIC">✕</button></h3><div id="axpAIOut" style="white-space:pre-wrap;line-height:1.7;font-size:13.5px;">⏳ Cloudflare GPU (Llama 3.3 70B) 분석 중...</div>`);
    document.getElementById("axpAIC")!.onclick = closeModal;
    const d = await (
      await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, slug: state.boardSlug }),
      })
    ).json();
    addTraces(d.trace);
    const out = document.getElementById("axpAIOut");
    if (out) out.textContent = d.ok ? d.answer : `오류: ${d.error || "실행 실패"}`;
  };
  document.getElementById("axpAiSummary")!.onclick = () => void runAI("summary");
  document.getElementById("axpAiQuiz")!.onclick = () => void runAI("quiz");

  // Vectorize Semantic Search & Sync
  const runVecSearch = async () => {
    const q = (document.getElementById("axpVecInput") as HTMLInputElement).value.trim();
    if (!q) return;
    openModal(`<h3><span>🧠 Vectorize AI 의미 검색</span><button class="axp-btn" id="axpVC">✕</button></h3><div id="axpVOut" style="font-size:13.5px;line-height:1.6;">⏳ BGE-M3 한국어 임베딩 + Vectorize 코사인 유사도 검색 중...</div>`);
    document.getElementById("axpVC")!.onclick = closeModal;
    const d = await (
      await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, slug: state.boardSlug }),
      })
    ).json();
    addTraces(d.trace);
    const out = document.getElementById("axpVOut")!;
    if (!d.ok) {
      out.textContent = `오류: ${d.error || "검색 실패"}`;
      return;
    }
    const matches = d.matches || [];
    if (!matches.length) {
      out.innerHTML = `매칭된 카드가 없습니다. 먼저 <b>🔄 색인</b> 버튼을 눌러 기존 카드를 Vectorize에 등록해 보세요!`;
      return;
    }
    out.innerHTML = matches
      .map((m: { post_id: number; title: string; score: number }) => {
        const pct = Math.round((m.score || 0) * 100);
        const post = state.posts.find((p) => p.id === m.post_id);
        return `<div style="padding:10px 12px;border:1px solid var(--island-border);border-radius:10px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <b>${escapeHtml(m.title || post?.title || "카드 #" + m.post_id)}</b>
            <span class="axp-badge axp-b-ai">유사도 ${pct}%</span>
          </div>
          <div style="font-size:12.5px;opacity:.8;">${escapeHtml((post?.content || "").slice(0, 120))}</div>
        </div>`;
      })
      .join("");
  };
  document.getElementById("axpVecBtn")!.onclick = () => void runVecSearch();
  document.getElementById("axpVecInput")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runVecSearch();
  });
  document.getElementById("axpVecSync")!.onclick = async () => {
    const btn = document.getElementById("axpVecSync") as HTMLButtonElement;
    btn.textContent = "⏳ 색인 중...";
    try {
      const d = await (await fetch("/api/vector/sync", { method: "POST" })).json();
      addTraces(d.trace);
      app.onMessage?.(d.ok ? `🧠 Vectorize에 포스트 ${d.count}건 색인 완료!` : `색인 실패: ${d.error}`);
    } finally {
      btn.textContent = "🔄 색인";
    }
  };

  renderXray();
  syncModeUI();
  if (state.mode === "board") void loadBoard(state.boardSlug);
}
