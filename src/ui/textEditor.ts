/**
 * In-canvas text editing.
 *
 * A transparent textarea is overlaid exactly where the text is drawn, so the
 * caret, selection and IME (important for Korean/Japanese input) all behave
 * natively while the canvas keeps rendering everything else.
 */

import { TEXT_CONTAINER_PADDING } from "../constants";
import {
  getContainerTextWidth,
  getFontString,
  measureText,
  wrapText,
} from "../element/text";
import { mutateElement } from "../element/factory";
import type { Viewport } from "../scene/renderer";
import type { AxElement, TextElement } from "../types";

export interface TextEditorOptions {
  parent: HTMLElement;
  element: TextElement;
  container: AxElement | null;
  viewport: Viewport;
  onUpdate: () => void;
  onDone: (element: TextElement, isEmpty: boolean) => void;
}

export class TextEditor {
  private textarea: HTMLTextAreaElement | null = null;
  private element: TextElement | null = null;
  private container: AxElement | null = null;
  private onUpdate: (() => void) | null = null;
  private onDone: ((element: TextElement, isEmpty: boolean) => void) | null = null;
  private submitted = false;

  get isEditing(): boolean {
    return this.textarea !== null;
  }

  get editingId(): string | null {
    return this.element?.id ?? null;
  }

  start(options: TextEditorOptions): void {
    this.commit();
    const { element, container } = options;
    this.element = element;
    this.container = container;
    this.onUpdate = options.onUpdate;
    this.onDone = options.onDone;
    this.submitted = false;

    const textarea = document.createElement("textarea");
    textarea.className = "ax-text-editor";
    textarea.dir = "auto";
    textarea.tabIndex = 0;
    textarea.wrap = "off";
    textarea.spellcheck = false;
    textarea.autocapitalize = "off";
    textarea.autocomplete = "off";
    textarea.value = element.originalText;

    textarea.addEventListener("input", () => this.handleInput());
    textarea.addEventListener("keydown", (event) => this.handleKeyDown(event));
    textarea.addEventListener("blur", () => this.commit());
    // Keep canvas shortcuts from firing while typing.
    textarea.addEventListener("pointerdown", (event) => event.stopPropagation());
    textarea.addEventListener("wheel", (event) => event.stopPropagation());

    options.parent.appendChild(textarea);
    this.textarea = textarea;
    this.updatePosition(options.viewport);

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
  }

  private handleKeyDown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      this.commit();
      return;
    }
    // Enter adds a line; Ctrl/Cmd+Enter finishes, matching Excalidraw.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.commit();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const textarea = this.textarea!;
      const start = textarea.selectionStart;
      textarea.setRangeText("    ", start, textarea.selectionEnd, "end");
      this.handleInput();
    }
  }

  private handleInput(): void {
    const element = this.element;
    const textarea = this.textarea;
    if (!element || !textarea) return;

    const raw = textarea.value;
    const wrapWidth = this.container ? getContainerTextWidth(this.container) : Infinity;
    const text = this.container ? wrapText(raw, element.fontSize, element.fontFamily, wrapWidth, element.letterSpacing) : raw;
    const metrics = measureText(text, element.fontSize, element.fontFamily, element.lineHeight, element.letterSpacing);

    mutateElement(element, {
      text,
      originalText: raw,
      width: this.container ? Math.max(metrics.width, 0) : metrics.width,
      height: metrics.height,
    });

    if (this.container) this.layoutInContainer();
    this.onUpdate?.();
    this.syncTextareaSize();
  }

  /** Centre the label inside its container and grow the container if needed. */
  private layoutInContainer(): void {
    const element = this.element;
    const container = this.container;
    if (!element || !container) return;

    const minHeight = element.height + TEXT_CONTAINER_PADDING * 2;
    if (container.height < minHeight) {
      mutateElement(container, { height: minHeight });
    }
    const width = getContainerTextWidth(container);
    mutateElement(element, {
      width,
      x: container.x + (container.width - width) / 2,
      y: container.y + (container.height - element.height) / 2,
      textAlign: "center",
      verticalAlign: "middle",
    });
  }

  /** Reposition the overlay after scroll/zoom or an edit. */
  updatePosition(viewport: Viewport): void {
    const element = this.element;
    const textarea = this.textarea;
    if (!element || !textarea) return;

    const left = (element.x + viewport.scrollX) * viewport.zoom;
    const top = (element.y + viewport.scrollY) * viewport.zoom;

    textarea.style.left = `${left}px`;
    textarea.style.top = `${top}px`;
    textarea.style.font = getFontString(element.fontSize * viewport.zoom, element.fontFamily);
    textarea.style.lineHeight = String(element.lineHeight);
    textarea.style.letterSpacing = `${(element.letterSpacing ?? 0) * viewport.zoom}px`;
    textarea.style.color = element.strokeColor;
    textarea.style.opacity = String(element.opacity / 100);
    textarea.style.textAlign = element.textAlign;
    textarea.style.transformOrigin = "center center";
    textarea.style.transform = element.angle ? `rotate(${element.angle}rad)` : "";
    this.syncTextareaSize(viewport);
  }

  private lastZoom = 1;

  private syncTextareaSize(viewport?: Viewport): void {
    const element = this.element;
    const textarea = this.textarea;
    if (!element || !textarea) return;
    const zoom = viewport?.zoom ?? this.lastZoom;
    this.lastZoom = zoom;
    const width = Math.max(element.width, element.fontSize * 0.6);
    textarea.style.width = `${width * zoom + 4}px`;
    textarea.style.height = `${element.height * zoom + 2}px`;
  }

  /** Finish editing and hand the element back to the app. */
  commit(): void {
    const textarea = this.textarea;
    const element = this.element;
    if (!textarea || !element || this.submitted) return;
    this.submitted = true;

    const isEmpty = element.text.trim() === "";
    textarea.remove();
    this.textarea = null;
    this.element = null;
    this.container = null;

    this.onDone?.(element, isEmpty);
    this.onUpdate?.();
    this.onDone = null;
    this.onUpdate = null;
  }
}
