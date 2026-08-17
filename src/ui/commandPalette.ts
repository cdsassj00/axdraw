/**
 * Command palette (Ctrl/Cmd+K).
 *
 * axdraw has far more in it than the toolbar shows — align, distribute, flip,
 * z-order, export variants, view toggles — and all of it currently lives behind
 * a menu you have to already know about. A toolbar scales by getting longer; a
 * search box does not.
 *
 * Every entry carries its shortcut, so the palette teaches the keyboard rather
 * than replacing it: you look something up a few times, notice the shortcut,
 * and stop needing the palette for it.
 *
 * Matching is subsequence-based over both the English and Korean labels, so
 * "ab" finds "Align bottom" and "정렬" finds the same row. Ranking prefers
 * matches that start at a word boundary, which keeps short queries predictable.
 */

import type { App } from "../app";
import { h } from "./dom";

export interface Command {
  id: string;
  label: string;
  /** Korean label, also searchable. */
  ko: string;
  group: string;
  shortcut?: string;
  run: (app: App) => void;
  /** Hidden when this returns false — actions that need a selection, mostly. */
  enabled?: (app: App) => boolean;
}

const hasSelection = (app: App): boolean => app.state.selectedIds.size > 0;
const hasMultiple = (app: App): boolean => app.state.selectedIds.size > 1;

export const COMMANDS: Command[] = [
  // Tools
  { id: "tool.selection", label: "Selection tool", ko: "선택 도구", group: "도구", shortcut: "V", run: (a) => a.setTool("selection") },
  { id: "tool.rectangle", label: "Rectangle", ko: "사각형", group: "도구", shortcut: "R", run: (a) => a.setTool("rectangle") },
  { id: "tool.diamond", label: "Diamond", ko: "마름모", group: "도구", shortcut: "D", run: (a) => a.setTool("diamond") },
  { id: "tool.ellipse", label: "Ellipse", ko: "타원", group: "도구", shortcut: "O", run: (a) => a.setTool("ellipse") },
  { id: "tool.arrow", label: "Arrow", ko: "화살표", group: "도구", shortcut: "A", run: (a) => a.setTool("arrow") },
  { id: "tool.line", label: "Line", ko: "선", group: "도구", shortcut: "L", run: (a) => a.setTool("line") },
  { id: "tool.freedraw", label: "Draw", ko: "그리기", group: "도구", shortcut: "P", run: (a) => a.setTool("freedraw") },
  { id: "tool.text", label: "Text", ko: "텍스트", group: "도구", shortcut: "T", run: (a) => a.setTool("text") },
  { id: "tool.eraser", label: "Eraser", ko: "지우개", group: "도구", shortcut: "E", run: (a) => a.setTool("eraser") },
  { id: "tool.frame", label: "Frame", ko: "프레임", group: "도구", shortcut: "F", run: (a) => a.setTool("frame") },
  { id: "tool.laser", label: "Laser pointer", ko: "레이저 포인터", group: "도구", shortcut: "K", run: (a) => a.setTool("laser") },

  // Edit
  { id: "edit.undo", label: "Undo", ko: "실행취소", group: "편집", shortcut: "Ctrl+Z", run: (a) => a.undo() },
  { id: "edit.redo", label: "Redo", ko: "다시 실행", group: "편집", shortcut: "Ctrl+Shift+Z", run: (a) => a.redo() },
  { id: "edit.selectAll", label: "Select all", ko: "전체 선택", group: "편집", shortcut: "Ctrl+A", run: (a) => a.selectAll() },
  { id: "edit.duplicate", label: "Duplicate", ko: "복제", group: "편집", shortcut: "Ctrl+D", run: (a) => a.duplicate(), enabled: hasSelection },
  { id: "edit.delete", label: "Delete", ko: "삭제", group: "편집", shortcut: "Delete", run: (a) => a.deleteSelection(), enabled: hasSelection },
  { id: "edit.group", label: "Group", ko: "그룹", group: "편집", shortcut: "Ctrl+G", run: (a) => a.group(), enabled: hasMultiple },
  { id: "edit.ungroup", label: "Ungroup", ko: "그룹 해제", group: "편집", shortcut: "Ctrl+Shift+G", run: (a) => a.ungroup(), enabled: hasSelection },
  { id: "edit.lock", label: "Toggle lock", ko: "잠금 전환", group: "편집", run: (a) => a.toggleLock(), enabled: hasSelection },
  { id: "edit.unlockAll", label: "Unlock all", ko: "전체 잠금 해제", group: "편집", run: (a) => a.unlockAll() },
  { id: "edit.convertShape", label: "Convert stroke to shape", ko: "도형으로 변환", group: "편집", run: (a) => a.convertSelectedFreedraw(), enabled: (a) => a.getSelectedElements().some((e) => e.type === "freedraw") },

  // Arrange
  { id: "z.front", label: "Bring to front", ko: "맨 앞으로", group: "정렬", shortcut: "Ctrl+Shift+]", run: (a) => a.changeZ("front"), enabled: hasSelection },
  { id: "z.forward", label: "Bring forward", ko: "앞으로", group: "정렬", shortcut: "Ctrl+]", run: (a) => a.changeZ("forward"), enabled: hasSelection },
  { id: "z.backward", label: "Send backward", ko: "뒤로", group: "정렬", shortcut: "Ctrl+[", run: (a) => a.changeZ("backward"), enabled: hasSelection },
  { id: "z.back", label: "Send to back", ko: "맨 뒤로", group: "정렬", shortcut: "Ctrl+Shift+[", run: (a) => a.changeZ("back"), enabled: hasSelection },
  { id: "align.left", label: "Align left", ko: "왼쪽 정렬", group: "정렬", run: (a) => a.align("left"), enabled: hasMultiple },
  { id: "align.center", label: "Align centre horizontally", ko: "가로 가운데 정렬", group: "정렬", run: (a) => a.align("center"), enabled: hasMultiple },
  { id: "align.right", label: "Align right", ko: "오른쪽 정렬", group: "정렬", run: (a) => a.align("right"), enabled: hasMultiple },
  { id: "align.top", label: "Align top", ko: "위쪽 정렬", group: "정렬", run: (a) => a.align("top"), enabled: hasMultiple },
  { id: "align.middle", label: "Align centre vertically", ko: "세로 가운데 정렬", group: "정렬", run: (a) => a.align("middle"), enabled: hasMultiple },
  { id: "align.bottom", label: "Align bottom", ko: "아래쪽 정렬", group: "정렬", run: (a) => a.align("bottom"), enabled: hasMultiple },
  { id: "dist.h", label: "Distribute horizontally", ko: "가로 균등 분배", group: "정렬", run: (a) => a.distribute("horizontal"), enabled: hasMultiple },
  { id: "dist.v", label: "Distribute vertically", ko: "세로 균등 분배", group: "정렬", run: (a) => a.distribute("vertical"), enabled: hasMultiple },
  { id: "flip.h", label: "Flip horizontally", ko: "좌우 뒤집기", group: "정렬", run: (a) => a.flip("horizontal"), enabled: hasSelection },
  { id: "flip.v", label: "Flip vertically", ko: "상하 뒤집기", group: "정렬", run: (a) => a.flip("vertical"), enabled: hasSelection },

  // View
  { id: "view.zoomFit", label: "Zoom to fit", ko: "전체 맞춤", group: "보기", shortcut: "Shift+1", run: (a) => a.zoomToFit() },
  { id: "view.zoomSelection", label: "Zoom to selection", ko: "선택 영역 맞춤", group: "보기", shortcut: "Shift+2", run: (a) => a.zoomToSelection(), enabled: hasSelection },
  { id: "view.zoom100", label: "Reset zoom to 100%", ko: "확대 100%", group: "보기", shortcut: "Ctrl+0", run: (a) => a.setZoom(1) },
  { id: "view.grid", label: "Toggle grid", ko: "격자 전환", group: "보기", shortcut: "Ctrl+'", run: (a) => a.toggleGrid() },
  { id: "view.theme", label: "Toggle dark mode", ko: "다크 모드 전환", group: "보기", run: (a) => a.setTheme(a.state.theme === "dark" ? "light" : "dark") },

  // File
  { id: "file.save", label: "Save to file", ko: "파일로 저장", group: "파일", shortcut: "Ctrl+S", run: (a) => a.saveToFile() },
  { id: "file.open", label: "Open file", ko: "파일 열기", group: "파일", shortcut: "Ctrl+O", run: (a) => void a.openFile() },
  { id: "file.png", label: "Export as PNG", ko: "PNG로 내보내기", group: "파일", run: (a) => void a.exportPng() },
  { id: "file.svg", label: "Export as SVG", ko: "SVG로 내보내기", group: "파일", run: (a) => a.exportSvg() },
  { id: "file.copyPng", label: "Copy image to clipboard", ko: "이미지 클립보드 복사", group: "파일", run: (a) => void a.copyPngToClipboard() },
  { id: "file.share", label: "Share link", ko: "공유 링크", group: "파일", run: (a) => void a.shareLink() },
  { id: "collab.start", label: "Start live collaboration", ko: "실시간 협업 시작", group: "파일", run: (a) => void a.startCollab(), enabled: (a) => !a.collab },
  { id: "collab.stop", label: "Stop live collaboration", ko: "실시간 협업 종료", group: "파일", run: (a) => a.stopCollab(), enabled: (a) => !!a.collab },
  { id: "insert.template", label: "Insert template", ko: "템플릿 삽입", group: "파일", run: (a) => void import("./templates").then((m) => m.openTemplateDialog(a)) },
];

/**
 * Subsequence match. Returns a score (lower is better) or -1 for no match.
 * A match starting at a word boundary outranks one starting mid-word, so
 * "al" puts "Align left" above "Toggle lock".
 */
function score(text: string, query: string): number {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  let index = 0;
  let first = -1;
  let gaps = 0;
  let previous = -1;
  for (const char of query.toLowerCase()) {
    const found = haystack.indexOf(char, index);
    if (found === -1) return -1;
    if (first === -1) first = found;
    if (previous !== -1 && found > previous + 1) gaps += 1;
    previous = found;
    index = found + 1;
  }
  const atBoundary = first === 0 || /[\s(]/.test(haystack[first - 1] ?? "");
  return gaps * 10 + first + (atBoundary ? 0 : 25);
}

function rank(app: App, query: string): Command[] {
  const available = COMMANDS.filter((command) => !command.enabled || command.enabled(app));
  if (!query.trim()) return available;
  const scored: { command: Command; score: number }[] = [];
  for (const command of available) {
    const best = Math.min(
      ...[score(command.label, query), score(command.ko, query), score(command.group, query)]
        .filter((value) => value >= 0)
        .concat(Infinity),
    );
    if (best !== Infinity) scored.push({ command, score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((entry) => entry.command);
}

export function createCommandPalette(app: App, parent: HTMLElement): () => void {
  let open = false;
  let active = 0;
  let results: Command[] = [];

  const input = h("input", {
    class: "cp-input",
    type: "text",
    placeholder: "명령 검색…  (도형, 정렬, 내보내기)",
    "aria-label": "명령 검색",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const list = h("div", { class: "cp-list", role: "listbox" });
  const panel = h("div", { class: "cp-panel", role: "dialog", "aria-modal": "true", "aria-label": "명령 팔레트" }, [
    h("div", { class: "cp-search" }, [input]),
    list,
    h("div", { class: "cp-footer" }, [
      h("span", {}, ["↑↓ 이동"]),
      h("span", {}, ["↵ 실행"]),
      h("span", {}, ["Esc 닫기"]),
    ]),
  ]);
  const backdrop = h("div", { class: "cp-backdrop" }, [panel]);
  backdrop.hidden = true;
  parent.appendChild(backdrop);

  const renderList = (): void => {
    results = rank(app, input.value);
    if (active >= results.length) active = Math.max(0, results.length - 1);

    if (!results.length) {
      list.replaceChildren(h("div", { class: "cp-empty" }, ["일치하는 명령이 없습니다"]));
      return;
    }

    const nodes: Node[] = [];
    let group = "";
    results.forEach((command, index) => {
      if (command.group !== group) {
        group = command.group;
        nodes.push(h("div", { class: "cp-group" }, [group]));
      }
      nodes.push(
        h(
          "div",
          {
            class: `cp-row${index === active ? " active" : ""}`,
            role: "option",
            "aria-selected": index === active ? "true" : "false",
            onmousemove: () => {
              if (active !== index) {
                active = index;
                renderList();
              }
            },
            onclick: () => runCommand(command),
          },
          [
            h("span", { class: "cp-label" }, [command.ko]),
            h("span", { class: "cp-sub" }, [command.label]),
            command.shortcut ? h("kbd", { class: "cp-kbd" }, [command.shortcut]) : null,
          ],
        ),
      );
    });
    list.replaceChildren(...nodes);
    list.querySelector(".cp-row.active")?.scrollIntoView({ block: "nearest" });
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    // Blur before hiding, and hand focus to the container explicitly. Hiding an
    // ancestor does not reliably move focus off a focused input, and while the
    // input still holds it the app's keydown handler skips every event as
    // "typing" — so shortcuts, Ctrl+K included, silently stop working.
    input.blur();
    backdrop.hidden = true;
    input.value = "";
    app.container.focus();
  };

  const runCommand = (command: Command): void => {
    close();
    command.run(app);
  };

  const show = (): void => {
    open = true;
    active = 0;
    backdrop.hidden = false;
    renderList();
    input.focus();
  };

  input.addEventListener("input", () => {
    active = 0;
    renderList();
  });

  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });

  // Captured on the palette itself so arrows and Enter never reach the canvas.
  panel.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      active = results.length ? (active + 1) % results.length : 0;
      renderList();
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      active = results.length ? (active - 1 + results.length) % results.length : 0;
      renderList();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = results[active];
      if (command) runCommand(command);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  return () => (open ? close() : show());
}
