/**
 * Getting lost work back: shapes erased on this canvas, and the earlier
 * copies the server keeps of it. Both open without touching what is on
 * screen — erased shapes come back undoably, an earlier copy opens as a new
 * canvas — so trying a version can never make things worse.
 */

import type { App } from "../app";
import { listCanvasVersions, pullCanvasVersion } from "../scene/cloud";
import { button, h } from "./dom";
import { iconEl } from "./icons";

function stampLabel(stamp: string): string {
  const date = new Date(Number(stamp));
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : stamp;
}

function sizeLabel(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function openRecoverDialog(app: App): void {
  const close = () => backdrop.remove();
  const status = h("p", { class: "recover-status", text: "" });
  const erasedCount = app.elements.filter((element) => element.isDeleted).length;
  const restoreButton = h("button", {
    class: "primary-btn",
    type: "button",
    text: erasedCount ? `지운 도형 ${erasedCount}개 되살리기` : "지운 도형 없음",
    disabled: !erasedCount,
    onclick: () => {
      const restored = app.restoreDeleted();
      close();
      app.onMessage?.(`지운 도형 ${restored}개를 되살렸습니다 — 되돌리려면 Ctrl+Z`);
    },
  });
  const versionList = h("div", { class: "recover-versions" }, [h("p", { class: "recover-status", text: "서버에 남은 이전 버전을 찾는 중…" })]);

  const body = h("div", { class: "recover-body" }, [
    h("h3", { text: "1. 이 캔버스에서 지운 도형" }),
    h("p", {
      class: "recover-help",
      text: "지운 도형은 30일 동안 내용 그대로 보관됩니다. 다른 기기와 합쳐지며 지워진 것도 여기 있습니다. 되살린 뒤 Ctrl+Z로 되돌릴 수 있습니다.",
    }),
    restoreButton,
    h("h3", { text: "2. 서버에 남은 이전 버전" }),
    h("p", {
      class: "recover-help",
      text: "저장할 때마다 덮어쓰기 전 내용을 10분마다 보관합니다. 고른 버전은 새 캔버스로 열리고, 지금 캔버스는 그대로 둡니다.",
    }),
    versionList,
    status,
  ]);

  const backdrop = h(
    "div",
    { class: "modal-backdrop", onclick: (event: MouseEvent) => event.target === backdrop && close() },
    [
      h("div", { class: "modal island recover-modal" }, [
        h("div", { class: "modal-header" }, [
          h("h2", { text: `'${app.currentBoardName()}' 되살리기` }),
          button({ icon: iconEl("close"), title: "Close", onClick: close }),
        ]),
        body,
      ]),
    ],
  );
  document.body.appendChild(backdrop);

  const account = app.cloud.account;
  const boardId = app.currentBoardId();
  if (!account) {
    versionList.replaceChildren(h("p", { class: "recover-status", text: "로그인해야 서버의 이전 버전을 볼 수 있습니다." }));
    return;
  }
  void listCanvasVersions(account, boardId)
    .then((versions) => {
      if (!versions.length) {
        versionList.replaceChildren(h("p", { class: "recover-status", text: "이 캔버스는 아직 서버에 보관된 이전 버전이 없습니다." }));
        return;
      }
      versionList.replaceChildren(
        ...versions.map((version) =>
          h("div", { class: "recover-version" }, [
            h("span", { text: `${stampLabel(version.stamp)} · ${sizeLabel(version.size)}` }),
            h("button", {
              class: "secondary-btn",
              type: "button",
              text: "새 캔버스로 열기",
              onclick: async () => {
                status.textContent = "불러오는 중…";
                try {
                  const scene = await pullCanvasVersion(account, boardId, version.stamp);
                  const live = scene.elements.filter((element) => !(element as { isDeleted?: boolean }).isDeleted);
                  app.openRecoveredCopy(
                    `${app.currentBoardName()} (복원 ${stampLabel(version.stamp)})`,
                    scene.elements,
                    scene.files ?? {},
                  );
                  close();
                  app.onMessage?.(`이전 버전을 새 캔버스로 열었습니다 — 도형 ${live.length}개`);
                } catch (error) {
                  status.textContent = error instanceof Error ? error.message : String(error);
                }
              },
            }),
          ]),
        ),
      );
    })
    .catch((error: unknown) => {
      versionList.replaceChildren(
        h("p", { class: "recover-status", text: error instanceof Error ? error.message : String(error) }),
      );
    });
}
