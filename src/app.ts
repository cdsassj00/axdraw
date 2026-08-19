/**
 * The editor.
 *
 * Owns the scene (elements + files), the viewport, and every pointer/keyboard
 * interaction. The UI layer talks to this class and re-reads state through
 * `subscribe`; nothing else mutates the scene directly.
 */

import {
  alignSelected,
  changeZOrder,
  deleteSelected,
  distributeSelected,
  duplicateSelected,
  expandSelectionToGroups,
  flipSelected,
  getSelected,
  groupSelected,
  setLocked,
  ungroupSelected,
  unlockAll,
  type AlignDirection,
  type SceneSlice,
} from "./actions";
import {
  buildPayload,
  copyElements,
  getInternalClipboard,
  parsePayload,
  readFileAsDataURL,
  readFileAsText,
} from "./clipboard";
import {
  ANGLE_SNAP,
  BUNDLED_FONTS,
  CANVAS_BACKGROUND_BY_THEME,
  DEFAULT_GRID_SIZE,
  DEFAULT_STYLE,
  DRAG_THRESHOLD,
  ELEMENT_TRANSLATE_AMOUNT,
  FILE_EXTENSION,
  HANDLE_HIT_RADIUS,
  HANDLE_HIT_RADIUS_COARSE,
  HIT_THRESHOLD,
  LASER_TRAIL_MS,
  LINE_CONFIRM_THRESHOLD,
  MAX_ZOOM,
  MIN_ZOOM,
  SNAP_DISTANCE,
  TEXT_CONTAINER_PADDING,
} from "./constants";
import {
  getCommonBounds,
  getElementBounds,
  getElementCenter,
  hasPoints,
  isLinear,
  normalizePoints,
  rotate,
} from "./element/bounds";
import {
  bindArrow,
  getHoveredElementForBinding,
  isBindableElement,
  isInsideElement,
  refreshArrowBindings,
  updateBoundArrows,
} from "./element/binding";
import {
  duplicateElement,
  mutateElement,
  newFrameElement,
  newFreedrawElement,
  newImageElement,
  newLinearElement,
  newShapeElement,
  newTextElement,
} from "./element/factory";
import {
  getElementAtPosition,
  getElementsInBounds,
  getLinearMidpointIndexAt,
  getLinearPointIndexAt,
  hitTest,
} from "./element/hit";
import { recognizeFrame, recognizeShape, type Pt, type Recognized } from "./element/recognize";
import {
  getHandleAtPosition,
  getResizeCursor,
  getTransformHandles,
  resizeMultipleElements,
  resizeSingleElement,
  rotateElements,
  type TransformHandle,
  type TransformHandleType,
} from "./element/resize";
import { computeSnap, snapPointToObjects } from "./element/snapping";
import {
  canContainText,
  getBoundTextElement,
  getContainerTextWidth,
  measureText,
  wrapText,
} from "./element/text";
import { History } from "./history";
import { FILE_CARD_HEIGHT, FILE_CARD_WIDTH } from "./element/filecard";
import { clearShapeCache } from "./element/shapes";
import {
  downloadBlob,
  exportToBlob,
  exportToCanvas,
  exportToSvgString,
  normalizeImportedElement,
  parseScene,
  serializeScene,
} from "./scene/export";
import { clearImageCache, loadImageDimensions } from "./scene/images";
import {
  getSelectionBounds,
  renderInteractiveScene,
  type LaserPoint,
  type SnapLine,
} from "./scene/interactive";
import { renderStaticScene, screenToScene, type Viewport } from "./scene/renderer";
import {
  clearStoredScene,
  createBoard,
  currentBoardId,
  deleteBoard,
  listBoards,
  loadScene,
  renameBoard,
  saveScene,
  setCurrentBoard,
  type BoardMeta,
} from "./scene/storage";
import { createShareLink, loadSharedScene } from "./scene/share";
import { CollabSession, ROOM_HASH_PATTERN } from "./scene/collab";
import { t } from "./i18n";
import type {
  AppState,
  AxElement,
  BinaryFile,
  BinaryFiles,
  FreedrawElement,
  ItemStyle,
  LinearElement,
  RecognitionChoice,
  RecognitionChoiceOption,
  RecognitionChoiceType,
  Point,
  TextElement,
  ToolType,
} from "./types";
import { TextEditor } from "./ui/textEditor";
import { randomId } from "./utils/random";

/** Attachments live in localStorage alongside the scene, so keep them modest. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

type PointerMode =
  | { type: "none" }
  | { type: "pan"; lastX: number; lastY: number }
  | { type: "draw"; element: AxElement; origin: Point }
  | { type: "freedraw"; element: FreedrawElement }
  | { type: "move"; originals: Map<string, AxElement>; origin: Point; moved: boolean }
  | {
      type: "resize";
      handle: TransformHandleType;
      originals: Map<string, AxElement>;
      originalBounds: { x1: number; y1: number; x2: number; y2: number };
    }
  | { type: "rotate"; originals: Map<string, AxElement>; center: Point; startAngle: number }
  | { type: "marquee"; origin: Point; additive: boolean }
  | { type: "linearPoint"; element: LinearElement; index: number }
  | { type: "erase" }
  | { type: "laser" };

const TOOL_CURSORS: Partial<Record<ToolType, string>> = {
  selection: "default",
  hand: "grab",
  text: "text",
  eraser: "cell",
  laser: "crosshair",
  image: "crosshair",
};

export class App {
  readonly container: HTMLElement;
  readonly staticCanvas: HTMLCanvasElement;
  readonly interactiveCanvas: HTMLCanvasElement;
  readonly overlay: HTMLDivElement;

  elements: AxElement[] = [];
  files: BinaryFiles = {};
  state: AppState;

  private history = new History();
  private textEditor = new TextEditor();
  private listeners = new Set<() => void>();

  private pointerMode: PointerMode = { type: "none" };
  private multiPointElement: LinearElement | null = null;
  private editingLinearId: string | null = null;
  private erasingIds = new Set<string>();
  private laserPoints: LaserPoint[] = [];
  private snapLines: SnapLine[] = [];
  private hoveredElementId: string | null = null;
  private bindingHighlightId: string | null = null;
  private spacePressed = false;
  private activePointers = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; centerX: number; centerY: number } | null = null;
  private lastPointerScene: Point = { x: 0, y: 0 };
  private shiftKey = false;
  private altKey = false;
  private renderScheduled = false;
  private saveTimer: number | null = null;
  private cursorOverride: string | null = null;
  private appliedCursor = "";
  /**
   * Grab area for transform handles, in screen px. Widened for touch and pen,
   * which land far less precisely than a mouse. Updated on every pointer event
   * so switching between a trackpad and a stylus mid-session works.
   */
  private handleHitRadius = HANDLE_HIT_RADIUS;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = {
      tool: "selection",
      toolLocked: false,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      theme: "light",
      viewBackgroundColor: CANVAS_BACKGROUND_BY_THEME.light,
      gridEnabled: false,
      gridSize: DEFAULT_GRID_SIZE,
      snapEnabled: true,
      // Off by default: the pen should draw what the hand drew. Conversion
      // is on demand (right-click → convert) or opt-in via the wand toggle.
      shapeRecognition: false,
      zenMode: false,
      viewMode: false,
      statsEnabled: false,
      selectedIds: new Set(),
      editingTextId: null,
      currentStyle: { ...DEFAULT_STYLE },
    };

    this.staticCanvas = document.createElement("canvas");
    this.staticCanvas.className = "ax-canvas ax-canvas--static";
    this.interactiveCanvas = document.createElement("canvas");
    this.interactiveCanvas.className = "ax-canvas ax-canvas--interactive";
    // Focusable so UI layers can hand focus back to the canvas. Without this,
    // focus stays on whatever input was just dismissed and the keyboard
    // handler treats every following keystroke as typing.
    if (!container.hasAttribute("tabindex")) container.tabIndex = -1;

    this.overlay = document.createElement("div");
    this.overlay.className = "ax-overlay";

    container.appendChild(this.staticCanvas);
    container.appendChild(this.interactiveCanvas);
    container.appendChild(this.overlay);

    this.restore();
    this.bindEvents();
    this.watchFonts();
    this.resize();
    this.history.reset(this.elements, this.state.selectedIds);
  }

  /* ---------------------------------------------------------------- *
   * State plumbing
   * ---------------------------------------------------------------- */

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get viewport(): Viewport {
    return {
      scrollX: this.state.scrollX,
      scrollY: this.state.scrollY,
      zoom: this.state.zoom,
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    };
  }

  getSelectedElements(): AxElement[] {
    return getSelected(this.elements, this.state.selectedIds);
  }

  private slice(): SceneSlice {
    return { elements: this.elements, selectedIds: this.state.selectedIds };
  }

  private applySlice(slice: SceneSlice, commit = true): void {
    this.elements = slice.elements;
    this.state.selectedIds = slice.selectedIds;
    if (commit) this.commit();
    else this.scheduleRender();
  }

  /** Record a history step, persist, re-render and refresh the UI. */
  commit(): void {
    this.collab?.queueBroadcast();
    this.history.record(this.elements, this.state.selectedIds);
    this.scheduleRender();
    this.schedulePersist();
    this.notify();
  }

  private schedulePersist(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      saveScene(this.elements, this.files, this.state);
      this.saveTimer = null;
    }, 400);
  }

  private restore(): void {
    const loaded = loadScene();
    if (!loaded) return;
    this.elements = loaded.elements.map((element) =>
      normalizeImportedElement(element as unknown as Record<string, unknown>),
    );
    this.files = loaded.files;
    Object.assign(this.state, loaded.state);
    if (loaded.state.currentStyle) {
      this.state.currentStyle = { ...DEFAULT_STYLE, ...loaded.state.currentStyle };
    }
    this.state.selectedIds = new Set();
    this.state.editingTextId = null;
    this.applyTheme();
  }

  /**
   * Text metrics are stored on the element, so a font that finishes loading
   * after a measurement would leave the box out of sync with the glyphs.
   * Preload the bundled families and re-measure whenever loading settles.
   */
  private watchFonts(): void {
    const fonts = document.fonts;
    if (!fonts) return;
    for (const font of BUNDLED_FONTS) {
      void fonts.load(`20px "${font.family}"`, font.sample).catch(() => undefined);
    }
    const refresh = () => this.refreshTextMetrics();
    fonts.addEventListener("loadingdone", refresh);
    void fonts.ready.then(refresh).catch(() => undefined);
  }

  /** Re-measure every text element without touching the undo history. */
  refreshTextMetrics(): void {
    let changed = false;
    for (const element of this.elements) {
      if (element.type !== "text" || element.isDeleted) continue;
      const text = element as TextElement;
      const container = text.containerId
        ? this.elements.find((item) => item.id === text.containerId) ?? null
        : null;
      const width = container ? getContainerTextWidth(container) : Infinity;
      const wrapped = container
        ? wrapText(text.originalText, text.fontSize, text.fontFamily, width, text.letterSpacing)
        : text.text;
      const metrics = measureText(wrapped, text.fontSize, text.fontFamily, text.lineHeight, text.letterSpacing);
      const nextWidth = container ? width : metrics.width;
      if (Math.abs(text.width - nextWidth) < 0.5 && Math.abs(text.height - metrics.height) < 0.5) {
        continue;
      }
      mutateElement(text, { text: wrapped, width: nextWidth, height: metrics.height });
      if (container) this.relayoutBoundText(container);
      changed = true;
    }
    clearShapeCache();
    this.scheduleRender();
    if (changed) this.notify();
  }

  applyTheme(): void {
    document.documentElement.dataset.theme = this.state.theme;
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    for (const canvas of [this.staticCanvas, this.interactiveCanvas]) {
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    this.render();
  }

  private renderElementsForDisplay(): AxElement[] {
    const editingId = this.textEditor.editingId;
    if (!this.erasingIds.size && !editingId) return this.elements;
    return this.elements.map((element) => {
      if (element.id === editingId) return { ...element, isDeleted: true };
      if (this.erasingIds.has(element.id)) return { ...element, opacity: element.opacity * 0.25 };
      return element;
    });
  }

  render(): void {
    const dpr = window.devicePixelRatio || 1;
    const viewport = this.viewport;

    renderStaticScene(this.staticCanvas, this.renderElementsForDisplay(), this.files, {
      ...viewport,
      theme: this.state.theme,
      viewBackgroundColor: this.state.viewBackgroundColor,
      gridEnabled: this.state.gridEnabled,
      gridSize: this.state.gridSize,
      devicePixelRatio: dpr,
      onImageLoad: () => this.scheduleRender(),
    });

    const selected = this.getSelectedElements();
    const showHandles =
      !this.state.viewMode &&
      selected.length > 0 &&
      this.pointerMode.type !== "draw" &&
      this.pointerMode.type !== "freedraw" &&
      !this.editingLinearId &&
      !selected.some((element) => element.locked);

    let handles: TransformHandle[] = [];
    let selectionBounds = null;
    let selectionAngle = 0;

    if (selected.length > 0 && !this.state.viewMode) {
      if (selected.length === 1) {
        const element = selected[0];
        selectionAngle = element.angle;
        selectionBounds = {
          x1: element.x,
          y1: element.y,
          x2: element.x + element.width,
          y2: element.y + element.height,
        };
      } else {
        selectionBounds = getSelectionBounds(selected);
      }
      if (showHandles && selectionBounds) {
        const isSingleLinear = selected.length === 1 && isLinear(selected[0]) && selected[0].points.length > 2;
        handles = getTransformHandles(selectionBounds, selectionAngle, this.state.zoom, {
          omitRotation: isSingleLinear,
        });
      }
    }

    const editingLinear = this.editingLinearId
      ? (this.elements.find((element) => element.id === this.editingLinearId) as LinearElement | undefined)
      : undefined;

    renderInteractiveScene(this.interactiveCanvas, {
      elements: this.elements,
      selectedIds: this.state.selectedIds,
      viewport,
      devicePixelRatio: dpr,
      theme: this.state.theme,
      marquee: this.marqueeBounds,
      handles,
      selectionBounds,
      selectionAngle,
      editingLinear: editingLinear ?? null,
      editingLinearPointIndex:
        this.pointerMode.type === "linearPoint" ? this.pointerMode.index : null,
      bindingHighlightId: this.bindingHighlightId,
      snapLines: this.snapLines,
      laserPoints: this.laserPoints,
      hoveredElementId: this.hoveredElementId,
    });

    if (this.textEditor.isEditing) this.textEditor.updatePosition(viewport);
    if (this.laserPoints.length) {
      this.laserPoints = this.laserPoints.filter(
        (point) => performance.now() - point.time < LASER_TRAIL_MS,
      );
      if (this.laserPoints.length) this.scheduleRender();
    }
    this.updateCursor();
  }

  private marqueeBounds: { x1: number; y1: number; x2: number; y2: number } | null = null;

  /**
   * Push the current cursor to the DOM.
   *
   * Called from both the render loop and directly on hover: hovering a
   * transform handle changes nothing that needs repainting, so waiting for the
   * next render would leave the resize cursor stuck until something else
   * happened to schedule one — which is why approaching a handle from empty
   * canvas used to show no resize cursor at all.
   */
  private updateCursor(): void {
    const next = this.computeCursor();
    if (next === this.appliedCursor) return;
    this.appliedCursor = next;
    this.container.style.cursor = next;
  }

  private computeCursor(): string {
    if (this.cursorOverride) return this.cursorOverride;
    if (this.spacePressed || this.pointerMode.type === "pan") {
      return this.pointerMode.type === "pan" ? "grabbing" : "grab";
    }
    return TOOL_CURSORS[this.state.tool] ?? "crosshair";
  }

  /* ---------------------------------------------------------------- *
   * Coordinates
   * ---------------------------------------------------------------- */

  private clientToScene(clientX: number, clientY: number): Point {
    const rect = this.container.getBoundingClientRect();
    return screenToScene(clientX - rect.left, clientY - rect.top, this.viewport);
  }

  private maybeSnapToGrid(point: Point): Point {
    if (!this.state.gridEnabled) return point;
    const size = this.state.gridSize;
    return { x: Math.round(point.x / size) * size, y: Math.round(point.y / size) * size };
  }

  /* ---------------------------------------------------------------- *
   * Event wiring
   * ---------------------------------------------------------------- */

  private bindEvents(): void {
    const canvas = this.interactiveCanvas;
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerUp);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    canvas.addEventListener("dblclick", this.handleDoubleClick);
    canvas.addEventListener("contextmenu", this.handleContextMenu);

    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    // Modifiers are tracked from key events, and a key released while the page
    // is not focused never sends one. Alt-Tab away with Shift down and the
    // editor believes Shift is held for the rest of the session: every shape
    // comes out square and every line snaps to 45°, which reads as "everything
    // I draw comes out diagonal". Same for a stuck Space, which leaves the
    // canvas in pan mode. Losing focus means we no longer know, so forget.
    window.addEventListener("blur", this.releaseModifiers);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.releaseModifiers();
    });
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("paste", this.handlePaste);
    window.addEventListener("copy", this.handleCopyEvent);
    window.addEventListener("cut", this.handleCutEvent);

    this.container.addEventListener("dragover", (event) => event.preventDefault());
    this.container.addEventListener("drop", this.handleDrop);
  }

  /** Set by the UI so right-click can open the menu. */
  onContextMenu: ((point: Point, clientX: number, clientY: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onMessage: ((message: string) => void) | null = null;
  /** Set by the UI layer; toggles the command palette. */
  onToggleCommandPalette: (() => void) | null = null;

  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const scene = this.clientToScene(event.clientX, event.clientY);
    // Right-clicking an unselected element selects it first.
    const hit = getElementAtPosition(this.elements, scene, HIT_THRESHOLD / this.state.zoom);
    if (hit && !this.state.selectedIds.has(hit.id)) {
      this.state.selectedIds = expandSelectionToGroups(this.elements, new Set([hit.id]));
      this.scheduleRender();
      this.notify();
    }
    this.onContextMenu?.(scene, event.clientX, event.clientY);
  };

  /* ---------------------------------------------------------------- *
   * Pointer: down
   * ---------------------------------------------------------------- */

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button === 2) return;
    this.trackPointerPrecision(event);
    // Any fresh interaction on the canvas retires the previous suggestion.
    if (this.recognitionChoice) {
      this.recognitionChoice = null;
      this.notify();
    }
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // A second finger turns the gesture into pinch-zoom/pan.
    if (this.activePointers.size === 2) {
      this.cancelInProgressGesture();
      this.startPinch();
      return;
    }

    this.interactiveCanvas.setPointerCapture(event.pointerId);
    this.shiftKey = event.shiftKey;
    this.altKey = event.altKey;

    const scene = this.clientToScene(event.clientX, event.clientY);
    this.lastPointerScene = scene;

    if (this.textEditor.isEditing) {
      this.textEditor.commit();
    }

    // Panning: middle mouse, space, or the hand tool.
    if (event.button === 1 || this.spacePressed || this.state.tool === "hand") {
      this.pointerMode = { type: "pan", lastX: event.clientX, lastY: event.clientY };
      this.updateCursor();
      return;
    }

    if (this.state.viewMode) return;

    // Finishing a multi-point line/arrow.
    if (this.multiPointElement) {
      this.handleMultiPointClick(scene);
      return;
    }

    switch (this.state.tool) {
      case "selection":
        this.handleSelectionPointerDown(event, scene);
        break;
      case "eraser":
        this.pointerMode = { type: "erase" };
        this.eraseAt(scene);
        break;
      case "laser":
        this.pointerMode = { type: "laser" };
        this.laserPoints = [{ x: scene.x, y: scene.y, time: performance.now() }];
        this.scheduleRender();
        break;
      case "text":
        this.startTextAt(scene);
        break;
      case "image":
        void this.pickImage(scene);
        break;
      case "freedraw":
        this.startFreedraw(scene, event);
        break;
      case "frame":
        this.startShapeDraw(scene, "frame");
        break;
      case "line":
      case "arrow":
        this.startLinearDraw(scene);
        break;
      default:
        this.startShapeDraw(scene, this.state.tool);
        break;
    }
  };

  private handleSelectionPointerDown(event: PointerEvent, scene: Point): void {
    const threshold = HIT_THRESHOLD / this.state.zoom;
    const selected = this.getSelectedElements();

    // 1. Line editor points.
    if (this.editingLinearId) {
      const element = this.elements.find((item) => item.id === this.editingLinearId);
      if (element && isLinear(element)) {
        const pointIndex = getLinearPointIndexAt(element, scene, threshold);
        if (pointIndex !== -1) {
          this.pointerMode = { type: "linearPoint", element, index: pointIndex };
          return;
        }
        const midIndex = getLinearMidpointIndexAt(element, scene, threshold);
        if (midIndex !== -1) {
          const local = this.toElementLocal(element, scene);
          const points = element.points.map((point) => [...point] as [number, number]);
          points.splice(midIndex + 1, 0, [local.x, local.y]);
          mutateElement(element, { points });
          normalizePoints(element);
          this.pointerMode = { type: "linearPoint", element, index: midIndex + 1 };
          this.scheduleRender();
          return;
        }
        if (!hitTest(element, scene, threshold)) {
          this.editingLinearId = null;
        }
      }
    }

    // 2. Transform handles.
    if (selected.length && !selected.some((element) => element.locked)) {
      const bounds =
        selected.length === 1
          ? {
              x1: selected[0].x,
              y1: selected[0].y,
              x2: selected[0].x + selected[0].width,
              y2: selected[0].y + selected[0].height,
            }
          : getSelectionBounds(selected)!;
      const angle = selected.length === 1 ? selected[0].angle : 0;
      const handles = getTransformHandles(bounds, angle, this.state.zoom);
      const handle = getHandleAtPosition(handles, scene, this.state.zoom, this.handleHitRadius);
      if (handle) {
        const originals = this.snapshot(selected);
        if (handle.type === "rotation") {
          const center = {
            x: (bounds.x1 + bounds.x2) / 2,
            y: (bounds.y1 + bounds.y2) / 2,
          };
          this.pointerMode = {
            type: "rotate",
            originals,
            center,
            startAngle: Math.atan2(scene.y - center.y, scene.x - center.x),
          };
        } else {
          this.pointerMode = { type: "resize", handle: handle.type, originals, originalBounds: bounds };
        }
        return;
      }
    }

    // 3. Element under the pointer.
    const hit = getElementAtPosition(this.elements, scene, threshold);
    if (hit) {
      let nextSelection: Set<string>;
      if (event.shiftKey) {
        nextSelection = new Set(this.state.selectedIds);
        if (nextSelection.has(hit.id)) nextSelection.delete(hit.id);
        else nextSelection.add(hit.id);
      } else if (this.state.selectedIds.has(hit.id)) {
        nextSelection = new Set(this.state.selectedIds);
      } else {
        nextSelection = new Set([hit.id]);
      }
      // Ctrl/Cmd+click reaches inside a group.
      this.state.selectedIds = event.ctrlKey || event.metaKey
        ? nextSelection
        : expandSelectionToGroups(this.elements, nextSelection);

      const moving = this.getSelectedElements();
      if (moving.length && !moving.every((element) => element.locked)) {
        // Alt-drag duplicates instead of moving.
        if (event.altKey) {
          const duplicated = duplicateSelected(this.slice(), { x: 0, y: 0 });
          this.elements = duplicated.elements;
          this.state.selectedIds = duplicated.selectedIds;
        }
        this.pointerMode = {
          type: "move",
          originals: this.snapshot(this.getMovingElements()),
          origin: scene,
          moved: false,
        };
      }
      this.scheduleRender();
      this.notify();
      return;
    }

    // 4. Marquee.
    if (!event.shiftKey) this.state.selectedIds = new Set();
    this.pointerMode = { type: "marquee", origin: scene, additive: event.shiftKey };
    this.marqueeBounds = { x1: scene.x, y1: scene.y, x2: scene.x, y2: scene.y };
    this.scheduleRender();
    this.notify();
  }

  /** Selected elements plus their bound labels and framed children. */
  private getMovingElements(): AxElement[] {
    const ids = new Set(this.state.selectedIds);
    for (const element of this.elements) {
      if (!ids.has(element.id)) continue;
      for (const bound of element.boundElements ?? []) {
        if (bound.type === "text") ids.add(bound.id);
      }
      if (element.type === "frame") {
        const frameBounds = getElementBounds(element);
        for (const candidate of this.elements) {
          if (candidate.id === element.id || candidate.isDeleted) continue;
          const b = getElementBounds(candidate);
          if (b.x1 >= frameBounds.x1 && b.x2 <= frameBounds.x2 && b.y1 >= frameBounds.y1 && b.y2 <= frameBounds.y2) {
            ids.add(candidate.id);
          }
        }
      }
    }
    return this.elements.filter((element) => ids.has(element.id) && !element.locked);
  }

  private snapshot(elements: readonly AxElement[]): Map<string, AxElement> {
    const map = new Map<string, AxElement>();
    for (const element of elements) map.set(element.id, structuredClone(element));
    return map;
  }

  private toElementLocal(element: AxElement, scene: Point): Point {
    const center = getElementCenter(element);
    const [x, y] = rotate(scene.x, scene.y, center.x, center.y, -element.angle);
    return { x: x - element.x, y: y - element.y };
  }

  /* ---------------------------------------------------------------- *
   * Element creation
   * ---------------------------------------------------------------- */

  private startShapeDraw(scene: Point, type: "rectangle" | "diamond" | "ellipse" | "frame"): void {
    const origin = this.maybeSnapToGrid(scene);
    const element =
      type === "frame"
        ? newFrameElement({ x: origin.x, y: origin.y, style: this.state.currentStyle })
        : newShapeElement(type, { x: origin.x, y: origin.y, style: this.state.currentStyle });
    this.elements = [...this.elements, element];
    this.state.selectedIds = new Set([element.id]);
    this.pointerMode = { type: "draw", element, origin };
    this.scheduleRender();
  }

  private startLinearDraw(scene: Point): void {
    const origin = this.maybeSnapToGrid(scene);
    const element = newLinearElement(this.state.tool === "arrow" ? "arrow" : "line", {
      x: origin.x,
      y: origin.y,
      style: this.state.currentStyle,
      points: [
        [0, 0],
        [0, 0],
      ],
    });
    this.elements = [...this.elements, element];
    this.state.selectedIds = new Set([element.id]);
    this.pointerMode = { type: "draw", element, origin };
    this.scheduleRender();
  }

  private startFreedraw(scene: Point, event: PointerEvent): void {
    const simulatePressure = event.pressure === 0 || event.pressure === 0.5;
    const element = newFreedrawElement({
      x: scene.x,
      y: scene.y,
      style: this.state.currentStyle,
      simulatePressure,
    });
    element.pressures = simulatePressure ? [] : [event.pressure];
    this.elements = [...this.elements, element];
    this.state.selectedIds = new Set();
    this.pointerMode = { type: "freedraw", element };
    this.scheduleRender();
  }

  private startTextAt(scene: Point, container: AxElement | null = null): void {
    const style = this.state.currentStyle;
    let element: TextElement;

    if (container) {
      const existing = getBoundTextElement(container, this.elements);
      if (existing) {
        element = existing;
      } else {
        const width = getContainerTextWidth(container);
        element = newTextElement({
          x: container.x + (container.width - width) / 2,
          y: container.y + container.height / 2 - style.fontSize * 0.625,
          width,
          style: { ...style, textAlign: "center" },
          text: "",
          containerId: container.id,
          verticalAlign: "middle",
        });
        this.elements = [...this.elements, element];
        mutateElement(container, {
          boundElements: [...(container.boundElements ?? []), { id: element.id, type: "text" }],
        });
      }
    } else {
      element = newTextElement({
        x: scene.x,
        y: scene.y - style.fontSize * 0.625,
        style,
        text: "",
      });
      this.elements = [...this.elements, element];
    }

    this.state.selectedIds = new Set([element.id]);
    this.state.editingTextId = element.id;
    this.textEditor.start({
      parent: this.overlay,
      element,
      container,
      viewport: this.viewport,
      onUpdate: () => this.scheduleRender(),
      onDone: (finished, isEmpty) => this.finishTextEditing(finished, isEmpty),
    });
    this.scheduleRender();
    this.notify();
  }

  private finishTextEditing(element: TextElement, isEmpty: boolean): void {
    this.state.editingTextId = null;
    if (isEmpty) {
      const container = element.containerId
        ? this.elements.find((item) => item.id === element.containerId)
        : null;
      if (container?.boundElements) {
        mutateElement(container, {
          boundElements: container.boundElements.filter((bound) => bound.id !== element.id),
        });
      }
      this.elements = this.elements.filter((item) => item.id !== element.id);
      this.state.selectedIds = new Set();
    } else if (this.state.tool === "text" && !this.state.toolLocked) {
      this.setTool("selection");
    }
    this.commit();
  }

  /* ---------------------------------------------------------------- *
   * Pointer: move
   * ---------------------------------------------------------------- */

  private trackPointerPrecision(event: PointerEvent): void {
    this.handleHitRadius =
      event.pointerType === "touch" || event.pointerType === "pen"
        ? HANDLE_HIT_RADIUS_COARSE
        : HANDLE_HIT_RADIUS;
  }

  private handlePointerMove = (event: PointerEvent): void => {
    this.trackPointerPrecision(event);
    if (this.activePointers.has(event.pointerId)) {
      this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (this.pinch && this.activePointers.size >= 2) {
      this.updatePinch();
      return;
    }
    this.shiftKey = event.shiftKey;
    this.altKey = event.altKey;
    const scene = this.clientToScene(event.clientX, event.clientY);
    this.lastPointerScene = scene;

    switch (this.pointerMode.type) {
      case "pan": {
        const dx = event.clientX - this.pointerMode.lastX;
        const dy = event.clientY - this.pointerMode.lastY;
        this.pointerMode.lastX = event.clientX;
        this.pointerMode.lastY = event.clientY;
        this.state.scrollX += dx / this.state.zoom;
        this.state.scrollY += dy / this.state.zoom;
        this.scheduleRender();
        return;
      }
      case "draw":
        this.updateDraw(scene);
        return;
      case "freedraw":
        this.updateFreedraw(scene, event);
        return;
      case "move":
        this.updateMove(scene);
        return;
      case "resize":
        this.updateResize(scene);
        return;
      case "rotate":
        rotateElements(
          [...this.pointerMode.originals.keys()]
            .map((id) => this.elements.find((element) => element.id === id))
            .filter((element): element is AxElement => Boolean(element)),
          this.pointerMode.originals,
          this.pointerMode.center,
          scene,
          this.pointerMode.startAngle,
          this.shiftKey,
        );
        this.scheduleRender();
        this.notify();
        return;
      case "marquee": {
        const origin = this.pointerMode.origin;
        this.marqueeBounds = {
          x1: Math.min(origin.x, scene.x),
          y1: Math.min(origin.y, scene.y),
          x2: Math.max(origin.x, scene.x),
          y2: Math.max(origin.y, scene.y),
        };
        const inside = getElementsInBounds(this.elements, this.marqueeBounds);
        const ids = new Set(inside.map((element) => element.id));
        this.state.selectedIds = expandSelectionToGroups(
          this.elements,
          this.pointerMode.additive ? new Set([...this.state.selectedIds, ...ids]) : ids,
        );
        this.scheduleRender();
        this.notify();
        return;
      }
      case "linearPoint": {
        const element = this.pointerMode.element;
        const local = this.toElementLocal(element, this.maybeSnapToGrid(scene));
        const points = element.points.map((point) => [...point] as [number, number]);
        points[this.pointerMode.index] = [local.x, local.y];
        mutateElement(element, { points });
        this.scheduleRender();
        return;
      }
      case "erase":
        this.eraseAt(scene);
        return;
      case "laser":
        this.laserPoints.push({ x: scene.x, y: scene.y, time: performance.now() });
        this.scheduleRender();
        return;
      case "none":
        break;
    }

    // Idle hover feedback.
    if (this.multiPointElement) {
      const element = this.multiPointElement;
      const local = this.toElementLocal(element, this.applyAngleSnap(element, scene));
      const points = element.points.map((point) => [...point] as [number, number]);
      points[points.length - 1] = [local.x, local.y];
      mutateElement(element, { points });
      this.updateBindingHighlight(scene, element);
      this.scheduleRender();
      return;
    }

    if (this.state.tool === "selection" && !this.state.viewMode) {
      const hit = getElementAtPosition(this.elements, scene, HIT_THRESHOLD / this.state.zoom);
      const nextId = hit?.id ?? null;
      if (nextId !== this.hoveredElementId) {
        this.hoveredElementId = nextId;
        this.scheduleRender();
      }
      this.updateResizeCursor(scene);
    } else {
      if (this.hoveredElementId) {
        this.hoveredElementId = null;
        this.scheduleRender();
      }
      this.cursorOverride = null;
    }
    this.updateCursor();
  };

  private updateResizeCursor(scene: Point): void {
    const selected = this.getSelectedElements();
    this.cursorOverride = null;
    if (!selected.length) return;
    const bounds =
      selected.length === 1
        ? {
            x1: selected[0].x,
            y1: selected[0].y,
            x2: selected[0].x + selected[0].width,
            y2: selected[0].y + selected[0].height,
          }
        : getSelectionBounds(selected)!;
    const angle = selected.length === 1 ? selected[0].angle : 0;
    const handle = getHandleAtPosition(
      getTransformHandles(bounds, angle, this.state.zoom),
      scene,
      this.state.zoom,
      this.handleHitRadius,
    );
    if (handle) {
      this.cursorOverride = getResizeCursor(handle.type, angle);
    } else if (this.hoveredElementId && this.state.selectedIds.has(this.hoveredElementId)) {
      this.cursorOverride = "move";
    }
  }

  private applyAngleSnap(element: LinearElement, scene: Point): Point {
    if (!this.shiftKey) {
      // Nearly-straight strokes settle onto the axis without needing Shift:
      // within ~4° of horizontal or vertical the wobble is unintentional.
      const target = this.maybeSnapToGrid(scene);
      const anchorIndex = Math.max(0, element.points.length - 2);
      const anchor = {
        x: element.x + element.points[anchorIndex][0],
        y: element.y + element.points[anchorIndex][1],
      };
      const dx = target.x - anchor.x;
      const dy = target.y - anchor.y;
      const ratio = Math.tan((4 * Math.PI) / 180);
      if (Math.abs(dy) <= Math.abs(dx) * ratio) return { x: target.x, y: anchor.y };
      if (Math.abs(dx) <= Math.abs(dy) * ratio) return { x: anchor.x, y: target.y };
      return target;
    }
    const anchorIndex = Math.max(0, element.points.length - 2);
    const anchor = {
      x: element.x + element.points[anchorIndex][0],
      y: element.y + element.points[anchorIndex][1],
    };
    const dx = scene.x - anchor.x;
    const dy = scene.y - anchor.y;
    const length = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / ANGLE_SNAP) * ANGLE_SNAP;
    return { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length };
  }

  private updateDraw(scene: Point): void {
    if (this.pointerMode.type !== "draw") return;
    const { element, origin } = this.pointerMode;

    if (isLinear(element)) {
      const target = this.applyAngleSnap(element, scene);
      const points = element.points.map((point) => [...point] as [number, number]);
      points[points.length - 1] = [target.x - element.x, target.y - element.y];
      mutateElement(element, { points });
      const width = Math.abs(points[points.length - 1][0]);
      const height = Math.abs(points[points.length - 1][1]);
      mutateElement(element, { width, height });
      this.updateBindingHighlight(target, element);
      this.scheduleRender();
      return;
    }

    let target = this.maybeSnapToGrid(scene);
    let x = Math.min(origin.x, target.x);
    let y = Math.min(origin.y, target.y);
    let width = Math.abs(target.x - origin.x);
    let height = Math.abs(target.y - origin.y);

    if (this.shiftKey) {
      const side = Math.max(width, height);
      width = side;
      height = side;
      x = target.x < origin.x ? origin.x - side : origin.x;
      y = target.y < origin.y ? origin.y - side : origin.y;
    }
    if (this.altKey) {
      x = origin.x - width;
      y = origin.y - height;
      width *= 2;
      height *= 2;
    }

    mutateElement(element, { x, y, width, height });
    this.scheduleRender();
  }

  private updateFreedraw(scene: Point, event: PointerEvent): void {
    if (this.pointerMode.type !== "freedraw") return;
    const element = this.pointerMode.element;
    const points = [...element.points, [scene.x - element.x, scene.y - element.y] as [number, number]];
    const pressures = element.simulatePressure
      ? element.pressures
      : [...element.pressures, event.pressure];
    mutateElement(element, { points, pressures });
    normalizePoints(element);
    this.scheduleRender();
  }

  private updateMove(scene: Point): void {
    if (this.pointerMode.type !== "move") return;
    const mode = this.pointerMode;
    let dx = scene.x - mode.origin.x;
    let dy = scene.y - mode.origin.y;
    if (Math.abs(dx) > DRAG_THRESHOLD / this.state.zoom || Math.abs(dy) > DRAG_THRESHOLD / this.state.zoom) {
      mode.moved = true;
    }
    if (this.shiftKey) {
      // Constrain to the dominant axis.
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }

    const moving = [...mode.originals.keys()]
      .map((id) => this.elements.find((element) => element.id === id))
      .filter((element): element is AxElement => Boolean(element));

    if (this.state.gridEnabled) {
      const first = mode.originals.get(moving[0]?.id ?? "");
      if (first) {
        const size = this.state.gridSize;
        dx = Math.round((first.x + dx) / size) * size - first.x;
        dy = Math.round((first.y + dy) / size) * size - first.y;
      }
    }

    // Object snapping (disabled while the grid is doing the aligning).
    this.snapLines = [];
    if (this.state.snapEnabled && !this.state.gridEnabled && !this.shiftKey) {
      const originals = moving
        .map((element) => mode.originals.get(element.id))
        .filter((element): element is AxElement => Boolean(element));
      const bounds = getCommonBounds(originals);
      const shifted = {
        x1: bounds.x1 + dx,
        y1: bounds.y1 + dy,
        x2: bounds.x2 + dx,
        y2: bounds.y2 + dy,
      };
      const snap = computeSnap(
        shifted,
        this.elements,
        new Set(moving.map((element) => element.id)),
        SNAP_DISTANCE / this.state.zoom,
      );
      dx += snap.dx;
      dy += snap.dy;
      this.snapLines = snap.lines;
    }

    for (const element of moving) {
      const original = mode.originals.get(element.id)!;
      mutateElement(element, { x: original.x + dx, y: original.y + dy });
    }
    updateBoundArrows(moving, this.elements);
    this.scheduleRender();
    this.notify();
  }

  private updateResize(scene: Point): void {
    if (this.pointerMode.type !== "resize") return;
    const { handle, originals, originalBounds } = this.pointerMode;
    const targets = [...originals.keys()]
      .map((id) => this.elements.find((element) => element.id === id))
      .filter((element): element is AxElement => Boolean(element));
    if (!targets.length) return;

    const options = { keepAspectRatio: this.shiftKey, fromCenter: this.altKey };

    // The dragged handle snaps to nearby edges and centres, just like a move.
    let pointer = this.maybeSnapToGrid(scene);
    this.snapLines = [];
    if (this.state.snapEnabled && !this.state.gridEnabled && !this.shiftKey) {
      const snap = snapPointToObjects(
        pointer,
        this.elements,
        new Set(targets.map((element) => element.id)),
        SNAP_DISTANCE / this.state.zoom,
      );
      pointer = snap.point;
      this.snapLines = snap.lines;
    }

    if (targets.length === 1) {
      const element = targets[0];
      const original = originals.get(element.id)!;
      // Resize always starts from the original geometry, not the live one.
      Object.assign(element, structuredClone(original));
      resizeSingleElement(element, handle, pointer, options);
      this.relayoutBoundText(element);
    } else {
      resizeMultipleElements(targets, originalBounds, handle, pointer, originals, options);
      for (const element of targets) this.relayoutBoundText(element);
    }
    updateBoundArrows(targets, this.elements);
    this.scheduleRender();
    this.notify();
  }

  /** Re-wrap and re-centre a container's label after the container changed. */
  private relayoutBoundText(container: AxElement): void {
    const text = getBoundTextElement(container, this.elements);
    if (!text) return;
    const width = getContainerTextWidth(container);
    const wrapped = wrapText(text.originalText, text.fontSize, text.fontFamily, width, text.letterSpacing);
    const metrics = measureText(wrapped, text.fontSize, text.fontFamily, text.lineHeight, text.letterSpacing);
    if (container.height < metrics.height + TEXT_CONTAINER_PADDING * 2) {
      mutateElement(container, { height: metrics.height + TEXT_CONTAINER_PADDING * 2 });
    }
    mutateElement(text, {
      text: wrapped,
      width,
      height: metrics.height,
      x: container.x + (container.width - width) / 2,
      y: container.y + (container.height - metrics.height) / 2,
    });
  }

  private updateBindingHighlight(scene: Point, arrow: LinearElement): void {
    if (arrow.type !== "arrow") {
      this.bindingHighlightId = null;
      return;
    }
    const target = getHoveredElementForBinding(
      scene,
      this.elements,
      HIT_THRESHOLD / this.state.zoom,
      arrow.id,
    );
    this.bindingHighlightId = target?.id ?? null;
  }

  private eraseAt(scene: Point): void {
    const threshold = HIT_THRESHOLD / this.state.zoom;
    for (const element of this.elements) {
      if (element.isDeleted || element.locked) continue;
      if (hitTest(element, scene, threshold)) this.erasingIds.add(element.id);
    }
    this.scheduleRender();
  }

  /* ---------------------------------------------------------------- *
   * Pointer: up
   * ---------------------------------------------------------------- */

  private handlePointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.activePointers.size >= 2) this.startPinch();
      else this.pinch = null;
      return;
    }

    const scene = this.clientToScene(event.clientX, event.clientY);
    const mode = this.pointerMode;
    this.pointerMode = { type: "none" };
    this.snapLines = [];
    this.marqueeBounds = null;

    switch (mode.type) {
      case "pan":
        this.updateCursor();
        this.schedulePersist();
        break;
      case "draw":
        this.finishDraw(mode.element, mode.origin, scene);
        break;
      case "freedraw":
        this.finishFreedraw(mode.element);
        break;
      case "move":
        if (mode.moved) this.commit();
        else this.notify();
        break;
      case "resize":
      case "rotate":
        this.commit();
        break;
      case "linearPoint": {
        normalizePoints(mode.element);
        refreshArrowBindings([mode.element], this.elements);
        this.commit();
        break;
      }
      case "erase": {
        if (this.erasingIds.size) {
          const doomed = new Set(this.erasingIds);
          this.erasingIds.clear();
          const result = deleteSelected({ elements: this.elements, selectedIds: doomed });
          this.elements = result.elements;
          this.commit();
        }
        break;
      }
      case "marquee":
        this.commit();
        break;
      case "laser":
        break;
      case "none":
        break;
    }
    this.bindingHighlightId = null;
    this.scheduleRender();
  };

  private finishDraw(element: AxElement, origin: Point, scene: Point): void {
    if (isLinear(element)) {
      const dragDistance = Math.hypot(scene.x - origin.x, scene.y - origin.y);
      if (dragDistance < LINE_CONFIRM_THRESHOLD / this.state.zoom) {
        // A click (not a drag) starts multi-point mode.
        this.multiPointElement = element;
        this.scheduleRender();
        return;
      }
      normalizePoints(element);
      this.finalizeLinear(element);
      this.afterCreate(element);
      return;
    }

    if (element.width < 2 && element.height < 2) {
      // A click with a shape tool drops a default-sized shape, like Excalidraw.
      const size = 100;
      mutateElement(element, {
        x: origin.x - size / 2,
        y: origin.y - size / 2,
        width: size,
        height: size / 1.6,
      });
    }
    this.afterCreate(element);
  }

  private finalizeLinear(element: LinearElement): void {
    if (element.type !== "arrow") return;
    const points = element.points;
    const startPoint = { x: element.x + points[0][0], y: element.y + points[0][1] };
    const endPoint = {
      x: element.x + points[points.length - 1][0],
      y: element.y + points[points.length - 1][1],
    };
    const start = getHoveredElementForBinding(
      startPoint,
      this.elements,
      HIT_THRESHOLD / this.state.zoom,
      element.id,
    );
    const end = getHoveredElementForBinding(
      endPoint,
      this.elements,
      HIT_THRESHOLD / this.state.zoom,
      element.id,
    );
    if (start && isBindableElement(start)) bindArrow(element, start, "start");
    if (end && isBindableElement(end) && end.id !== start?.id) bindArrow(element, end, "end");
    refreshArrowBindings([element], this.elements);
  }

  private finishFreedraw(element: FreedrawElement): void {
    if (element.points.length < 2) {
      this.elements = this.elements.filter((item) => item.id !== element.id);
      this.commit();
      return;
    }

    if (this.state.shapeRecognition) {
      const absolute: Pt[] = element.points.map(([x, y]) => [element.x + x, element.y + y]);
      const recognized = recognizeShape(absolute);
      if (recognized) {
        const replacement = this.buildRecognizedElement(recognized);
        if (replacement) {
          this.elements = this.elements.map((item) => (item.id === element.id ? replacement : item));
          this.afterCreate(replacement, false);
          this.openRecognitionChoice(element, absolute, replacement);
          return;
        }
      }
      this.afterCreate(element, false);
      // Nothing scored well enough, so the stroke stayed freehand. Offer the
      // shapes it *could* have been rather than leaving the user to redraw.
      this.openRecognitionChoice(element, absolute, element);
      return;
    }

    this.afterCreate(element, false);
  }

  /** On-demand recognition for selected pen strokes (context menu / palette). */
  convertSelectedFreedraw(): void {
    const strokes = this.getSelectedElements().filter(
      (element): element is FreedrawElement => element.type === "freedraw",
    );
    if (!strokes.length) return;
    let single: { stroke: FreedrawElement; absolute: Pt[]; replacement: AxElement } | null = null;
    let converted = 0;
    for (const stroke of strokes) {
      const absolute: Pt[] = stroke.points.map(([x, y]) => [stroke.x + x, stroke.y + y]);
      const recognized = recognizeShape(absolute);
      if (!recognized) continue;
      const replacement = this.buildRecognizedElement(recognized);
      if (!replacement) continue;
      this.elements = this.elements.map((item) => (item.id === stroke.id ? replacement : item));
      this.state.selectedIds.delete(stroke.id);
      this.state.selectedIds.add(replacement.id);
      converted += 1;
      if (strokes.length === 1) single = { stroke, absolute, replacement };
    }
    if (!converted) {
      this.onError?.("No clean shape recognised — the stroke stays freehand");
      return;
    }
    this.commit();
    // For a single stroke, offer the alternates chip just like live assist.
    if (single) this.openRecognitionChoice(single.stroke, single.absolute, single.replacement);
  }

  /* ---------------------------------------------------------------- *
   * Recognition choice
   *
   * Shape assist has to guess, and a guess the user cannot correct is worse
   * than no guess. After every recognised stroke we keep the original freehand
   * points and the fitted frame around, so the alternates are one click away
   * until the next action. Nothing here mutates history on its own — picking an
   * option is a normal commit, so undo still walks back through it.
   * ---------------------------------------------------------------- */

  recognitionChoice: RecognitionChoice | null = null;

  private openRecognitionChoice(
    original: FreedrawElement,
    absolute: Pt[],
    applied: AxElement,
  ): void {
    const frame = recognizeFrame(absolute);
    if (!frame) {
      // An open stroke (line, arrow) or something too small to reframe. The
      // alternates below are all closed shapes, so there is nothing to offer.
      this.recognitionChoice = null;
      this.notify();
      return;
    }

    const options: RecognitionChoiceOption[] = [
      { type: "rectangle", label: "사각형" },
      { type: "ellipse", label: "타원" },
      { type: "diamond", label: "마름모" },
      { type: "freedraw", label: "손그림" },
    ];

    this.recognitionChoice = {
      elementId: applied.id,
      original,
      frame,
      options,
      active: applied.type === "freedraw" ? "freedraw" : (applied.type as RecognitionChoiceType),
    };
    this.notify();
  }

  /** Swap the recognised element for a different reading of the same stroke. */
  applyRecognitionChoice(type: RecognitionChoiceType): void {
    const choice = this.recognitionChoice;
    if (!choice || choice.active === type) return;

    const current = this.elements.find((item) => item.id === choice.elementId);
    if (!current) {
      this.recognitionChoice = null;
      this.notify();
      return;
    }

    const replacement =
      type === "freedraw"
        ? { ...choice.original, id: choice.elementId }
        : this.buildRecognizedElement({
            type,
            cx: choice.frame.cx,
            cy: choice.frame.cy,
            width: choice.frame.width,
            height: choice.frame.height,
            angle: choice.frame.angle,
          });
    if (!replacement) return;

    replacement.id = choice.elementId;
    // History dedupes on id:version, and a rebuilt element starts back at 1.
    // Without this, swapping between two alternates looks like no change at all
    // and undo skips straight past it.
    replacement.version = current.version + 1;
    this.elements = this.elements.map((item) =>
      item.id === choice.elementId ? replacement : item,
    );
    this.state.selectedIds = new Set([choice.elementId]);
    this.recognitionChoice = { ...choice, active: type };
    clearShapeCache();
    this.commit();
  }

  dismissRecognitionChoice(): void {
    if (!this.recognitionChoice) return;
    this.recognitionChoice = null;
    this.notify();
  }

  /** Convert a recognizer result into a real element with the current style. */
  private buildRecognizedElement(
    recognized: Recognized | null,
  ): AxElement | null {
    if (!recognized) return null;
    const style = this.state.currentStyle;

    switch (recognized.type) {
      case "rectangle":
      case "ellipse":
      case "diamond":
        return newShapeElement(recognized.type, {
          x: recognized.cx - recognized.width / 2,
          y: recognized.cy - recognized.height / 2,
          width: recognized.width,
          height: recognized.height,
          angle: recognized.angle,
          style,
        });

      case "triangle": {
        const points = recognized.points;
        const minX = Math.min(...points.map((point) => point[0]));
        const minY = Math.min(...points.map((point) => point[1]));
        const element = newLinearElement("line", {
          x: minX,
          y: minY,
          style,
          points: [...points, points[0]].map(([x, y]) => [x - minX, y - minY] as [number, number]),
        });
        normalizePoints(element);
        return element;
      }

      case "line":
      case "arrow": {
        const points = recognized.points;
        if (points.length < 2) return null;
        const minX = Math.min(...points.map((point) => point[0]));
        const minY = Math.min(...points.map((point) => point[1]));
        const element = newLinearElement(recognized.type, {
          x: minX,
          y: minY,
          style,
          points: points.map(([x, y]) => [x - minX, y - minY] as [number, number]),
        });
        normalizePoints(element);
        if (element.type === "arrow") this.finalizeLinear(element);
        return element;
      }
    }
  }

  private afterCreate(element: AxElement, select = true): void {
    if (select) this.state.selectedIds = new Set([element.id]);
    // The pen is a continuous tool — you draw stroke after stroke, so it
    // keeps the tool without needing Q-lock. Shapes still hand back to
    // selection so the freshly drawn shape can be adjusted immediately.
    if (this.state.tool === "freedraw") {
      this.commit();
      return;
    }
    if (!this.state.toolLocked && this.state.tool !== "selection") {
      this.setTool("selection", false);
      if (select) this.state.selectedIds = new Set([element.id]);
    }
    this.commit();
  }

  /* ---------------------------------------------------------------- *
   * Multi-point lines
   * ---------------------------------------------------------------- */

  private handleMultiPointClick(scene: Point): void {
    const element = this.multiPointElement;
    if (!element) return;
    const points = element.points;
    const last = points[points.length - 1];
    const first = points[0];

    // Clicking the point just placed finishes the line. This is what makes a
    // double-click end it: the second click lands on the point the first one
    // dropped. Without it the only way out was Enter or Escape, and clicking
    // again just extended the line -- so a user trying to finish kept adding
    // segments instead.
    const threshold = LINE_CONFIRM_THRESHOLD / this.state.zoom;
    if (points.length > 2) {
      const previous = points[points.length - 2];
      if (Math.hypot(last[0] - previous[0], last[1] - previous[1]) < threshold) {
        this.finishMultiPoint();
        return;
      }
    }

    // Clicking near the first point closes the shape and finishes.
    const closes =
      points.length > 2 && Math.hypot(last[0] - first[0], last[1] - first[1]) < threshold;
    if (closes) {
      const closed = points.map((point) => [...point] as [number, number]);
      closed[closed.length - 1] = [first[0], first[1]];
      mutateElement(element, { points: closed });
      this.finishMultiPoint();
      return;
    }

    const local = this.toElementLocal(element, this.applyAngleSnap(element, scene));
    mutateElement(element, { points: [...points, [local.x, local.y]] });
    this.scheduleRender();
  }

  finishMultiPoint(): void {
    const element = this.multiPointElement;
    this.multiPointElement = null;
    if (!element) return;
    // Drop the trailing point that was following the cursor.
    if (element.points.length > 2) {
      mutateElement(element, { points: element.points.slice(0, -1) });
    }
    if (element.points.length < 2) {
      this.elements = this.elements.filter((item) => item.id !== element.id);
      this.commit();
      return;
    }
    normalizePoints(element);
    this.finalizeLinear(element);
    this.afterCreate(element);
  }

  /* ---------------------------------------------------------------- *
   * Wheel, double click
   * ---------------------------------------------------------------- */

  /** Abandon whatever the first finger started when a second one lands. */
  private cancelInProgressGesture(): void {
    const mode = this.pointerMode;
    if (mode.type === "draw" || mode.type === "freedraw") {
      this.elements = this.elements.filter((element) => element.id !== mode.element.id);
      this.state.selectedIds = new Set();
    }
    this.erasingIds.clear();
    this.marqueeBounds = null;
    this.snapLines = [];
    this.pointerMode = { type: "none" };
    this.scheduleRender();
  }

  private startPinch(): void {
    const [a, b] = [...this.activePointers.values()];
    if (!a || !b) return;
    this.pinch = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
    };
  }

  private updatePinch(): void {
    const pinch = this.pinch;
    if (!pinch) return;
    const [a, b] = [...this.activePointers.values()];
    if (!a || !b) return;

    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const centerX = (a.x + b.x) / 2;
    const centerY = (a.y + b.y) / 2;
    const rect = this.container.getBoundingClientRect();

    // Pan with the midpoint, then zoom around it.
    this.state.scrollX += (centerX - pinch.centerX) / this.state.zoom;
    this.state.scrollY += (centerY - pinch.centerY) / this.state.zoom;
    this.zoomAt(
      this.state.zoom * (distance / pinch.distance),
      centerX - rect.left,
      centerY - rect.top,
    );

    pinch.distance = distance;
    pinch.centerX = centerX;
    pinch.centerY = centerY;
  }

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = this.container.getBoundingClientRect();
      this.zoomAt(
        this.state.zoom * Math.exp(-event.deltaY / 200),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      return;
    }
    const factor = event.deltaMode === 1 ? 16 : 1;
    const dx = (event.shiftKey ? event.deltaY : event.deltaX) * factor;
    const dy = (event.shiftKey ? 0 : event.deltaY) * factor;
    this.state.scrollX -= dx / this.state.zoom;
    this.state.scrollY -= dy / this.state.zoom;
    this.scheduleRender();
    this.schedulePersist();
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    if (this.state.viewMode) return;
    // A double-click while placing a multi-point line means "done". The click
    // handler usually catches this first (the second click lands on the point
    // the first dropped), but a double-click that drifts a few pixels would
    // otherwise fall through to hit-testing and start editing text instead.
    if (this.multiPointElement) {
      this.finishMultiPoint();
      return;
    }
    const scene = this.clientToScene(event.clientX, event.clientY);
    const threshold = HIT_THRESHOLD / this.state.zoom;
    const hit = getElementAtPosition(this.elements, scene, threshold);

    if (hit) {
      if (this.attachmentFor(hit)) {
        this.downloadAttachment(hit);
        return;
      }
      if (hit.type === "text") {
        const container = hit.containerId
          ? this.elements.find((item) => item.id === hit.containerId) ?? null
          : null;
        this.editText(hit as TextElement, container);
        return;
      }
      if (isLinear(hit) && hit.points.length > 2) {
        this.editingLinearId = hit.id;
        this.state.selectedIds = new Set([hit.id]);
        this.scheduleRender();
        return;
      }
      if (canContainText(hit)) {
        const existing = getBoundTextElement(hit, this.elements);
        if (existing) this.editText(existing, hit);
        else this.startTextAt(scene, hit);
        return;
      }
    }

    // Transparent shapes are not "hit" by a click in their hollow middle, but
    // double-clicking inside one should still label it.
    const container = this.getTextContainerAt(scene);
    if (container) {
      const existing = getBoundTextElement(container, this.elements);
      if (existing) this.editText(existing, container);
      else this.startTextAt(scene, container);
      return;
    }

    this.startTextAt(scene);
  };

  /** Topmost label-able shape containing `scene`. */
  private getTextContainerAt(scene: Point): AxElement | null {
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const element = this.elements[i];
      if (element.isDeleted || element.locked) continue;
      if (element.type === "arrow" || element.type === "line") continue;
      if (!canContainText(element)) continue;
      if (isInsideElement(element, scene)) return element;
    }
    return null;
  }

  private editText(element: TextElement, container: AxElement | null): void {
    this.state.editingTextId = element.id;
    this.state.selectedIds = new Set([element.id]);
    this.textEditor.start({
      parent: this.overlay,
      element,
      container,
      viewport: this.viewport,
      onUpdate: () => this.scheduleRender(),
      onDone: (finished, isEmpty) => this.finishTextEditing(finished, isEmpty),
    });
    this.scheduleRender();
  }

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key === " ") {
      this.spacePressed = false;
      this.updateCursor();
    }
    this.shiftKey = event.shiftKey;
    this.altKey = event.altKey;
  };

  /** Forget every held modifier. See the blur listener for why. */
  private releaseModifiers = (): void => {
    if (!this.shiftKey && !this.altKey && !this.spacePressed) return;
    this.shiftKey = false;
    this.altKey = false;
    this.spacePressed = false;
    this.updateCursor();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    this.shiftKey = event.shiftKey;
    this.altKey = event.altKey;
    const mod = event.ctrlKey || event.metaKey;

    // The palette is chrome, so the UI layer owns it; the app just routes the
    // chord, which has to be caught before any single-key tool shortcut.
    if (mod && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.onToggleCommandPalette?.();
      return;
    }
    const key = event.key;

    if (key === " ") {
      this.spacePressed = true;
      this.updateCursor();
      event.preventDefault();
      return;
    }

    if (key === "Escape") {
      if (this.recognitionChoice) {
        // Dismiss the suggestion first — it is the most recent thing on screen,
        // so it is what Escape should retract.
        this.dismissRecognitionChoice();
      } else if (this.multiPointElement) {
        this.finishMultiPoint();
      } else if (this.editingLinearId) {
        this.editingLinearId = null;
      } else if (this.state.selectedIds.size) {
        this.state.selectedIds = new Set();
      } else if (this.state.tool !== "selection") {
        this.setTool("selection");
      }
      this.scheduleRender();
      this.notify();
      return;
    }

    if (key === "Enter") {
      if (this.multiPointElement) {
        this.finishMultiPoint();
        return;
      }
      const selected = this.getSelectedElements();
      if (selected.length === 1) {
        const element = selected[0];
        if (element.type === "text") {
          const container = element.containerId
            ? this.elements.find((item) => item.id === element.containerId) ?? null
            : null;
          this.editText(element as TextElement, container);
          event.preventDefault();
          return;
        }
        if (isLinear(element) && element.points.length > 2) {
          this.editingLinearId = element.id;
          this.scheduleRender();
          event.preventDefault();
          return;
        }
        if (canContainText(element)) {
          const existing = getBoundTextElement(element, this.elements);
          if (existing) this.editText(existing, element);
          else this.startTextAt(getElementCenter(element), element);
          event.preventDefault();
          return;
        }
      }
      return;
    }

    if (mod) {
      switch (key.toLowerCase()) {
        case "z":
          event.preventDefault();
          if (event.shiftKey) this.redo();
          else this.undo();
          return;
        case "y":
          event.preventDefault();
          this.redo();
          return;
        case "a":
          event.preventDefault();
          this.selectAll();
          return;
        case "d":
          event.preventDefault();
          this.duplicate();
          return;
        case "g":
          event.preventDefault();
          if (event.shiftKey) this.ungroup();
          else this.group();
          return;
        case "s":
          event.preventDefault();
          this.saveToFile();
          return;
        case "o":
          event.preventDefault();
          void this.openFile();
          return;
        case "e":
          event.preventDefault();
          void this.exportPng();
          return;
        case "0":
          event.preventDefault();
          this.setZoom(1);
          return;
        case "=":
        case "+":
          event.preventDefault();
          this.setZoom(this.state.zoom * 1.1);
          return;
        case "-":
          event.preventDefault();
          this.setZoom(this.state.zoom / 1.1);
          return;
        case "'":
          event.preventDefault();
          this.toggleGrid();
          return;
        case "]":
          event.preventDefault();
          this.changeZ(event.shiftKey ? "front" : "forward");
          return;
        case "[":
          event.preventDefault();
          this.changeZ(event.shiftKey ? "back" : "backward");
          return;
        case "h":
          if (event.shiftKey) {
            event.preventDefault();
            this.flip("horizontal");
            return;
          }
          break;
        case "v":
          if (event.shiftKey) {
            event.preventDefault();
            this.flip("vertical");
            return;
          }
          break;
      }
      return;
    }

    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      this.deleteSelection();
      return;
    }

    if (key.startsWith("Arrow")) {
      event.preventDefault();
      const step = this.state.gridEnabled
        ? this.state.gridSize
        : event.shiftKey
          ? ELEMENT_TRANSLATE_AMOUNT * 10
          : ELEMENT_TRANSLATE_AMOUNT;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      const selected = this.getSelectedElements();
      if (!selected.length) {
        this.state.scrollX -= dx;
        this.state.scrollY -= dy;
        this.scheduleRender();
        return;
      }
      for (const element of selected) {
        mutateElement(element, { x: element.x + dx, y: element.y + dy });
      }
      updateBoundArrows(selected, this.elements);
      this.commit();
      return;
    }

    if (event.shiftKey) {
      if (key === "1") {
        event.preventDefault();
        this.zoomToFit();
        return;
      }
      if (key === "2") {
        event.preventDefault();
        this.zoomToSelection();
        return;
      }
      if (key === "H") {
        return;
      }
    }

    const toolShortcuts: Record<string, ToolType> = {
      v: "selection",
      "1": "selection",
      r: "rectangle",
      "2": "rectangle",
      d: "diamond",
      "3": "diamond",
      o: "ellipse",
      "4": "ellipse",
      a: "arrow",
      "5": "arrow",
      l: "line",
      "6": "line",
      p: "freedraw",
      x: "freedraw",
      "7": "freedraw",
      t: "text",
      "8": "text",
      "9": "image",
      e: "eraser",
      "0": "eraser",
      f: "frame",
      k: "laser",
      h: "hand",
    };

    const tool = toolShortcuts[key.toLowerCase()];
    if (tool) {
      event.preventDefault();
      this.setTool(tool);
      return;
    }

    if (key.toLowerCase() === "q") {
      event.preventDefault();
      this.state.toolLocked = !this.state.toolLocked;
      this.notify();
    }
  };

  /* ---------------------------------------------------------------- *
   * Clipboard & files
   * ---------------------------------------------------------------- */

  private handleCopyEvent = (event: ClipboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const selected = this.getSelectedElements();
    if (!selected.length) return;
    event.preventDefault();
    const payload = buildPayload(selected, this.files);
    event.clipboardData?.setData("text/plain", JSON.stringify(payload));
    void copyElements(selected, this.files);
  };

  private handleCutEvent = (event: ClipboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const selected = this.getSelectedElements();
    if (!selected.length) return;
    event.preventDefault();
    const payload = buildPayload(selected, this.files);
    event.clipboardData?.setData("text/plain", JSON.stringify(payload));
    void copyElements(selected, this.files);
    this.deleteSelection();
  };

  private handlePaste = (event: ClipboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (this.textEditor.isEditing) return;

    const items = event.clipboardData?.items ?? [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void this.addImage(file, this.lastPointerScene);
          return;
        }
      }
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void this.addFileCard(file, this.lastPointerScene);
          return;
        }
      }
    }

    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text) {
      event.preventDefault();
      this.pasteText(text);
      return;
    }

    const internal = getInternalClipboard();
    if (internal) {
      event.preventDefault();
      this.pasteElements(internal.elements, internal.files);
    }
  };

  private pasteText(text: string): void {
    const payload = parsePayload(text);
    if (payload) {
      this.pasteElements(payload.elements, payload.files);
      return;
    }
    try {
      const scene = parseScene(text);
      this.pasteElements(scene.elements, scene.files);
      return;
    } catch {
      // Plain text: drop it on the canvas as a text element.
    }
    const style = this.state.currentStyle;
    const metrics = measureText(text, style.fontSize, style.fontFamily, style.lineHeight, style.letterSpacing);
    const element = newTextElement({
      x: this.lastPointerScene.x,
      y: this.lastPointerScene.y,
      style,
      text,
      width: metrics.width,
      height: metrics.height,
    });
    this.elements = [...this.elements, element];
    this.state.selectedIds = new Set([element.id]);
    this.commit();
  }

  /** Drops a template's elements at the viewport centre, selected. */
  insertTemplate(elements: readonly AxElement[]): void {
    const rect = this.container.getBoundingClientRect();
    const previous = this.lastPointerScene;
    this.lastPointerScene = {
      x: rect.width / 2 / this.state.zoom - this.state.scrollX,
      y: rect.height / 2 / this.state.zoom - this.state.scrollY,
    };
    this.pasteElements(elements);
    this.lastPointerScene = previous;
  }

  pasteElements(elements: readonly AxElement[], files: BinaryFiles = {}): void {
    if (!elements.length) return;
    const normalized = elements.map((element) =>
      normalizeImportedElement(element as unknown as Record<string, unknown>),
    );
    const bounds = getCommonBounds(normalized);
    const center = this.lastPointerScene;
    const dx = center.x - (bounds.x1 + bounds.x2) / 2;
    const dy = center.y - (bounds.y1 + bounds.y2) / 2;

    const idMap = new Map<string, string>();
    const groupMap = new Map<string, string>();
    const copies = normalized.map((element) => {
      const copy = duplicateElement(element, { x: dx, y: dy });
      idMap.set(element.id, copy.id);
      copy.groupIds = element.groupIds.map((groupId) => {
        if (!groupMap.has(groupId)) groupMap.set(groupId, randomId());
        return groupMap.get(groupId)!;
      });
      return copy;
    });

    for (let i = 0; i < normalized.length; i++) {
      const source = normalized[i];
      const copy = copies[i];
      if (source.boundElements?.length) {
        const bound = source.boundElements
          .filter((entry) => idMap.has(entry.id))
          .map((entry) => ({ ...entry, id: idMap.get(entry.id)! }));
        copy.boundElements = bound.length ? bound : null;
      }
      const containerId = (source as { containerId?: string | null }).containerId;
      if (containerId && idMap.has(containerId)) {
        (copy as { containerId?: string | null }).containerId = idMap.get(containerId)!;
      }
      if (isLinear(copy)) {
        copy.startBinding = null;
        copy.endBinding = null;
      }
    }

    Object.assign(this.files, files);
    this.elements = [...this.elements, ...copies];
    this.state.selectedIds = new Set(copies.map((element) => element.id));
    this.setTool("selection", false);
    this.commit();
  }

  private handleDrop = (event: DragEvent): void => {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    const scene = this.clientToScene(event.clientX, event.clientY);
    let offset = 0;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        void this.addImage(file, { x: scene.x + offset, y: scene.y + offset });
      } else if (file.name.endsWith(FILE_EXTENSION) || file.name.endsWith(".excalidraw") || file.type === "application/json") {
        void this.loadFromFile(file);
        break;
      } else {
        void this.addFileCard(file, { x: scene.x + offset, y: scene.y + offset });
      }
      offset += 28;
    }
  };

  async addImage(file: Blob, position: Point): Promise<void> {
    try {
      const dataURL = await readFileAsDataURL(file);
      const dimensions = await loadImageDimensions(dataURL);
      const fileId = randomId();
      this.files[fileId] = {
        id: fileId,
        mimeType: (file as File).type || "image/png",
        dataURL,
        created: Date.now(),
      };

      const maxDimension = 600;
      const scale = Math.min(1, maxDimension / Math.max(dimensions.width, dimensions.height));
      const width = dimensions.width * scale;
      const height = dimensions.height * scale;

      const element = newImageElement({
        x: position.x - width / 2,
        y: position.y - height / 2,
        width,
        height,
        style: this.state.currentStyle,
        fileId,
      });
      this.elements = [...this.elements, element];
      this.state.selectedIds = new Set([element.id]);
      this.setTool("selection", false);
      this.commit();
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not add the image");
    }
  }

  private async pickImage(position: Point): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void this.addImage(file, position);
    };
    input.click();
  }

  /** Attach any file (PDF, ZIP, …) as a downloadable card on the canvas. */
  async addFileCard(file: File, position: Point): Promise<void> {
    try {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error("File is too large to attach (max 8MB)");
      }
      const dataURL = await readFileAsDataURL(file);
      const fileId = randomId();
      this.files[fileId] = {
        id: fileId,
        mimeType: file.type || "application/octet-stream",
        dataURL,
        created: Date.now(),
        name: file.name || "file",
        size: file.size,
      };
      const element = newImageElement({
        x: position.x - FILE_CARD_WIDTH / 2,
        y: position.y - FILE_CARD_HEIGHT / 2,
        width: FILE_CARD_WIDTH,
        height: FILE_CARD_HEIGHT,
        style: this.state.currentStyle,
        fileId,
      });
      this.elements = [...this.elements, element];
      this.state.selectedIds = new Set([element.id]);
      this.setTool("selection", false);
      this.commit();
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not attach the file");
    }
  }

  /** Opens a picker for any file type and drops it as a file card. */
  pickAttachment(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        const rect = this.container.getBoundingClientRect();
        void this.addFileCard(file, {
          x: rect.width / 2 / this.state.zoom - this.state.scrollX,
          y: rect.height / 2 / this.state.zoom - this.state.scrollY,
        });
      }
    };
    input.click();
  }

  /** The attachment behind an element, when it is a file card. */
  attachmentFor(element: AxElement | null | undefined): BinaryFile | null {
    if (!element || element.type !== "image" || !element.fileId) return null;
    const file = this.files[element.fileId];
    return file && !file.mimeType.startsWith("image/") ? file : null;
  }

  /** Download the file behind a card element (double-click / context menu). */
  downloadAttachment(element: AxElement): void {
    const file = this.attachmentFor(element);
    if (!file) return;
    void fetch(file.dataURL)
      .then((response) => response.blob())
      .then((blob) => downloadBlob(blob, file.name ?? "file"))
      .catch(() => this.onError?.("Could not download the file"));
  }

  downloadSelectedAttachment(): void {
    const selected = this.getSelectedElements();
    for (const element of selected) {
      if (this.attachmentFor(element)) this.downloadAttachment(element);
    }
  }

  /* ---------------------------------------------------------------- *
   * Public API used by the UI
   * ---------------------------------------------------------------- */

  setTool(tool: ToolType, notify = true): void {
    if (this.multiPointElement) this.finishMultiPoint();
    this.state.tool = tool;
    this.editingLinearId = null;
    if (tool !== "selection") this.state.selectedIds = new Set();
    this.cursorOverride = null;
    this.updateCursor();
    this.scheduleRender();
    if (notify) this.notify();
  }

  /** Update the active style, applying it to the selection when there is one. */
  setStyle(partial: Partial<ItemStyle>): void {
    this.state.currentStyle = { ...this.state.currentStyle, ...partial };
    const selected = this.getSelectedElements();
    const targets = new Set<AxElement>(selected);
    for (const element of selected) {
      const bound = getBoundTextElement(element, this.elements);
      if (bound) targets.add(bound);
    }

    for (const element of targets) {
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(partial)) {
        if (key === "fontSize" || key === "fontFamily" || key === "textAlign" || key === "lineHeight" || key === "letterSpacing") {
          if (element.type !== "text") continue;
        }
        if ((key === "startArrowhead" || key === "endArrowhead" || key === "elbowed") && element.type !== "arrow") {
          continue;
        }
        updates[key] = value;
      }
      if (Object.keys(updates).length === 0) continue;
      mutateElement(element, updates as never);

      if (element.type === "text") {
        const text = element as TextElement;
        const container = text.containerId
          ? this.elements.find((item) => item.id === text.containerId) ?? null
          : null;
        const width = container ? getContainerTextWidth(container) : Infinity;
        const wrapped = container
          ? wrapText(text.originalText, text.fontSize, text.fontFamily, width, text.letterSpacing)
          : text.originalText;
        const metrics = measureText(wrapped, text.fontSize, text.fontFamily, text.lineHeight, text.letterSpacing);
        mutateElement(text, {
          text: wrapped,
          width: container ? width : metrics.width,
          height: metrics.height,
        });
        if (container) this.relayoutBoundText(container);
      }
    }
    if (targets.size) this.commit();
    else {
      this.schedulePersist();
      this.notify();
    }
  }

  undo(): void {
    const entry = this.history.undo();
    if (entry) this.applyHistoryEntry(entry);
  }

  redo(): void {
    const entry = this.history.redo();
    if (entry) this.applyHistoryEntry(entry);
  }

  private applyHistoryEntry(entry: { elements: AxElement[]; selectedIds: string[] }): void {
    if (this.collab) {
      // A restored snapshot is an *older* state; for peers to accept it via
      // last-writer-wins its elements must look newer than what they hold.
      const latest = new Map(this.elements.map((element) => [element.id, element.version]));
      for (const element of entry.elements) {
        const current = latest.get(element.id);
        if (current !== undefined && element.version <= current) {
          element.version = current + 1;
          element.updated = Date.now();
        }
      }
      // Elements absent from the snapshot are either my own later creations
      // (undoing a create — peers need a tombstone, not silence) or a peer's
      // work that arrived between my commits (keep it: my undo is not their
      // delete).
      const inSnapshot = new Set(entry.elements.map((element) => element.id));
      for (const element of this.elements) {
        if (inSnapshot.has(element.id)) continue;
        if (this.remoteElementIds.has(element.id)) {
          entry.elements.push(element);
        } else if (!element.isDeleted) {
          entry.elements.push(mutateElement(element, { isDeleted: true }));
        }
      }
    }
    this.elements = entry.elements;
    this.state.selectedIds = new Set(entry.selectedIds);
    clearShapeCache();
    this.scheduleRender();
    this.schedulePersist();
    this.notify();
    this.collab?.queueBroadcast();
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  selectAll(): void {
    this.state.selectedIds = new Set(
      this.elements.filter((element) => !element.isDeleted && !element.locked).map((element) => element.id),
    );
    this.setTool("selection", false);
    this.scheduleRender();
    this.notify();
  }

  deleteSelection(): void {
    if (!this.state.selectedIds.size) return;
    this.applySlice(deleteSelected(this.slice()));
  }

  duplicate(): void {
    this.applySlice(duplicateSelected(this.slice()));
  }

  group(): void {
    this.applySlice(groupSelected(this.slice()));
  }

  ungroup(): void {
    this.applySlice(ungroupSelected(this.slice()));
  }

  changeZ(action: "front" | "back" | "forward" | "backward"): void {
    this.applySlice(changeZOrder(this.slice(), action));
  }

  align(direction: AlignDirection): void {
    this.applySlice(alignSelected(this.slice(), direction));
  }

  distribute(axis: "horizontal" | "vertical"): void {
    this.applySlice(distributeSelected(this.slice(), axis));
  }

  flip(axis: "horizontal" | "vertical"): void {
    this.applySlice(flipSelected(this.slice(), axis));
  }

  toggleLock(): void {
    const selected = this.getSelectedElements();
    const shouldLock = selected.some((element) => !element.locked);
    this.applySlice(setLocked(this.slice(), shouldLock));
  }

  unlockAll(): void {
    this.applySlice(unlockAll(this.slice()));
  }

  copySelection(): void {
    const selected = this.getSelectedElements();
    if (selected.length) void copyElements(selected, this.files);
  }

  cutSelection(): void {
    this.copySelection();
    this.deleteSelection();
  }

  pasteFromClipboard(): void {
    const internal = getInternalClipboard();
    if (internal) this.pasteElements(internal.elements, internal.files);
  }

  /* ---------------------------------------------------------------- *
   * Viewport
   * ---------------------------------------------------------------- */

  setZoom(zoom: number, anchor?: { x: number; y: number }): void {
    const target = anchor ?? { x: this.container.clientWidth / 2, y: this.container.clientHeight / 2 };
    this.zoomAt(zoom, target.x, target.y);
  }

  private zoomAt(zoom: number, screenX: number, screenY: number): void {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const before = screenToScene(screenX, screenY, this.viewport);
    this.state.zoom = next;
    const after = screenToScene(screenX, screenY, this.viewport);
    this.state.scrollX += after.x - before.x;
    this.state.scrollY += after.y - before.y;
    this.scheduleRender();
    this.schedulePersist();
    this.notify();
  }

  private zoomToBounds(bounds: { x1: number; y1: number; x2: number; y2: number }): void {
    const width = bounds.x2 - bounds.x1;
    const height = bounds.y2 - bounds.y1;
    if (width <= 0 || height <= 0) return;
    const padding = 80;
    const zoom = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        Math.min(
          (this.container.clientWidth - padding) / width,
          (this.container.clientHeight - padding) / height,
          MAX_ZOOM,
        ),
      ),
    );
    this.state.zoom = Math.min(zoom, 1.5);
    this.state.scrollX = this.container.clientWidth / (2 * this.state.zoom) - (bounds.x1 + bounds.x2) / 2;
    this.state.scrollY = this.container.clientHeight / (2 * this.state.zoom) - (bounds.y1 + bounds.y2) / 2;
    this.scheduleRender();
    this.schedulePersist();
    this.notify();
  }

  zoomToFit(): void {
    const visible = this.elements.filter((element) => !element.isDeleted);
    if (!visible.length) {
      this.setZoom(1);
      return;
    }
    this.zoomToBounds(getCommonBounds(visible));
  }

  zoomToSelection(): void {
    const selected = this.getSelectedElements();
    if (!selected.length) {
      this.zoomToFit();
      return;
    }
    this.zoomToBounds(getCommonBounds(selected));
  }

  toggleGrid(): void {
    this.state.gridEnabled = !this.state.gridEnabled;
    this.scheduleRender();
    this.schedulePersist();
    this.notify();
  }

  setTheme(theme: AppState["theme"]): void {
    this.state.theme = theme;
    if (
      this.state.viewBackgroundColor === CANVAS_BACKGROUND_BY_THEME.light ||
      this.state.viewBackgroundColor === CANVAS_BACKGROUND_BY_THEME.dark
    ) {
      this.state.viewBackgroundColor = CANVAS_BACKGROUND_BY_THEME.light;
    }
    this.applyTheme();
    this.scheduleRender();
    this.schedulePersist();
    this.notify();
  }

  setViewBackgroundColor(color: string): void {
    this.state.viewBackgroundColor = color;
    this.scheduleRender();
    this.schedulePersist();
    this.notify();
  }

  /* ---------------------------------------------------------------- *
   * Scene lifecycle
   * ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- *
   * Boards (multiple canvases)
   * ---------------------------------------------------------------- */

  listBoards(): BoardMeta[] {
    return listBoards();
  }

  currentBoardId(): string {
    return currentBoardId();
  }

  /** Name of the canvas currently open, for the title chip. */
  currentBoardName(): string {
    const id = currentBoardId();
    return listBoards().find((board) => board.id === id)?.name ?? "";
  }

  /**
   * Rename a canvas. Blank names are rejected rather than stored: the name is
   * the only handle the user has on a board in the picker, and an empty row
   * cannot be told apart from its neighbours.
   */
  renameBoard(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed === listBoards().find((board) => board.id === id)?.name) return;
    renameBoard(id, trimmed);
    this.notify();
  }

  /** Saves the current board and opens a fresh empty one. */
  newBoard(): void {
    saveScene(this.elements, this.files, this.state);
    const board = createBoard();
    this.openBoard(board.id);
    this.onMessage?.(board.name);
  }

  /** Saves the current board and switches to another. */
  openBoard(id: string): void {
    if (this.collab) this.stopCollab(); // A board switch is a different document.
    saveScene(this.elements, this.files, this.state);
    setCurrentBoard(id);
    const loaded = loadScene();
    this.elements = (loaded?.elements ?? []).map((element) =>
      normalizeImportedElement(element as unknown as Record<string, unknown>),
    );
    this.files = loaded?.files ?? {};
    this.state.selectedIds = new Set();
    this.remoteElementIds = new Set();
    clearShapeCache();
    clearImageCache();
    this.history.reset(this.elements, this.state.selectedIds);
    if (this.elements.length) this.zoomToFit();
    this.commit();
  }

  deleteBoard(id: string): void {
    const boards = listBoards();
    if (boards.length <= 1) {
      this.onError?.(t("The last canvas cannot be deleted"));
      return;
    }
    deleteBoard(id);
    if (id === currentBoardId()) {
      const next = listBoards()[0];
      this.openBoard(next.id);
    }
    this.notify();
  }

  clearCanvas(): void {
    // Tombstones, not an empty array — collaborators must see the clear too.
    this.elements = this.elements.map((element) =>
      element.isDeleted ? element : mutateElement(element, { isDeleted: true }),
    );
    this.files = {};
    this.state.selectedIds = new Set();
    clearShapeCache();
    clearImageCache();
    clearStoredScene();
    this.commit();
  }

  saveToFile(): void {
    const json = serializeScene(this.elements, this.files, this.state);
    downloadBlob(new Blob([json], { type: "application/json" }), `drawing${FILE_EXTENSION}`);
  }

  /** Uploads the encrypted scene and puts a share URL on the clipboard. */
  async shareLink(): Promise<void> {
    if (!this.elements.some((element) => !element.isDeleted)) {
      this.onError?.(t("Nothing to share"));
      return;
    }
    try {
      const url = await createShareLink(this.elements, this.files, this.state);
      await navigator.clipboard.writeText(url);
      this.onMessage?.(t("Share link copied to clipboard"));
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Sharing failed");
    }
  }

  /* ---------------------------------------------------------------- *
   * Live collaboration
   * ---------------------------------------------------------------- */

  collab: CollabSession | null = null;
  /** Ids first seen in a peer broadcast — my undo must never delete these. */
  private remoteElementIds = new Set<string>();

  /** Starts a room (or re-copies the link of the current one). */
  async startCollab(): Promise<void> {
    try {
      if (!this.collab) {
        this.collab = await CollabSession.create(this);
      }
      await navigator.clipboard.writeText(this.collab.url);
      this.onMessage?.(t("Collaboration link copied — anyone with it can draw with you"));
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not start collaboration");
    }
  }

  stopCollab(): void {
    this.collab?.destroy();
    this.collab = null;
    this.onMessage?.(t("Left the collaboration room"));
  }

  /** Joins a room when the page was opened through a #room=… link. */
  async joinCollabFromHash(): Promise<void> {
    const match = ROOM_HASH_PATTERN.exec(location.hash);
    if (!match || this.collab) return;
    try {
      this.collab = await CollabSession.join(this, match[1], match[2]);
      this.onMessage?.(t("Joined the collaboration room"));
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not join the room");
    }
  }

  /**
   * Merges a collaborator's scene: element-wise last-writer-wins on
   * (version, updated). Deliberately does not touch local undo history and
   * does not re-commit — the sender already owns that change.
   */
  applyRemoteScene(remote: readonly AxElement[], files: BinaryFiles): void {
    const merged = new Map<string, AxElement>();
    for (const element of this.elements) merged.set(element.id, element);
    for (const element of remote) {
      if (!merged.has(element.id)) this.remoteElementIds.add(element.id);
      const local = merged.get(element.id);
      if (
        !local ||
        element.version > local.version ||
        (element.version === local.version && element.updated > local.updated)
      ) {
        merged.set(element.id, element);
      }
    }
    this.elements = [...merged.values()];
    Object.assign(this.files, files);
    this.state.selectedIds = new Set(
      [...this.state.selectedIds].filter((id) => {
        const element = merged.get(id);
        return element && !element.isDeleted;
      }),
    );
    this.scheduleRender();
    this.schedulePersist();
    this.notify();
  }

  /** Replaces the canvas with a scene fetched from a share link, if present. */
  async loadFromShareLink(): Promise<void> {
    try {
      const scene = await loadSharedScene();
      if (!scene) return;
      this.elements = scene.elements;
      this.files = scene.files;
      this.state.selectedIds = new Set();
      if (scene.appState.viewBackgroundColor) {
        this.state.viewBackgroundColor = scene.appState.viewBackgroundColor;
      }
      clearShapeCache();
      clearImageCache();
      this.history.reset(this.elements, this.state.selectedIds);
      this.zoomToFit();
      this.commit();
      this.onMessage?.(t("Opened a shared drawing"));
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not load the shared scene");
    }
  }

  async openFile(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${FILE_EXTENSION},.excalidraw,application/json`;
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void this.loadFromFile(file);
    };
    input.click();
  }

  async loadFromFile(file: Blob): Promise<void> {
    try {
      const text = await readFileAsText(file);
      const scene = parseScene(text);
      this.elements = scene.elements;
      this.files = scene.files;
      this.state.selectedIds = new Set();
      if (scene.appState.viewBackgroundColor) {
        this.state.viewBackgroundColor = scene.appState.viewBackgroundColor;
      }
      clearShapeCache();
      clearImageCache();
      this.history.reset(this.elements, this.state.selectedIds);
      this.zoomToFit();
      this.commit();
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not open the file");
    }
  }

  async exportPng(options: { scale?: number; background?: boolean; selectionOnly?: boolean } = {}): Promise<void> {
    const elements = options.selectionOnly ? this.getSelectedElements() : this.elements;
    if (!elements.length) {
      this.onError?.("Nothing to export");
      return;
    }
    const blob = await exportToBlob(elements, this.files, {
      exportBackground: options.background ?? true,
      viewBackgroundColor: this.state.viewBackgroundColor,
      scale: options.scale ?? 2,
      theme: this.state.theme,
    });
    downloadBlob(blob, "drawing.png");
  }

  exportSvg(options: { scale?: number; background?: boolean; selectionOnly?: boolean } = {}): void {
    const elements = options.selectionOnly ? this.getSelectedElements() : this.elements;
    if (!elements.length) {
      this.onError?.("Nothing to export");
      return;
    }
    const svg = exportToSvgString(elements, this.files, {
      exportBackground: options.background ?? true,
      viewBackgroundColor: this.state.viewBackgroundColor,
      scale: options.scale ?? 1,
      theme: this.state.theme,
    });
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), "drawing.svg");
  }

  /**
   * What a copy-to-clipboard should contain: the selection if there is one,
   * the whole scene otherwise.
   *
   * The download paths take an explicit selectionOnly flag because their
   * dialog offers the choice. Copy has no dialog, so it has to read the
   * intent off the canvas — and "I selected these three shapes, then hit
   * copy as image" can only mean those three.
   */
  private elementsForClipboard(): AxElement[] {
    const selected = this.getSelectedElements();
    return selected.length ? selected : this.elements.filter((element) => !element.isDeleted);
  }

  async copyPngToClipboard(): Promise<void> {
    try {
      const elements = this.elementsForClipboard();
      if (!elements.length) throw new Error(t("Nothing to export"));
      const canvas = exportToCanvas(elements, this.files, {
        exportBackground: true,
        viewBackgroundColor: this.state.viewBackgroundColor,
        scale: 2,
        theme: this.state.theme,
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Could not encode the image");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not copy to the clipboard");
    }
  }

  /**
   * Copy the drawing as SVG. Written as text/plain as well as image/svg+xml:
   * most editors refuse the SVG flavour outright, and the ones that take it
   * still paste the markup from the text flavour, so offering both means the
   * paste lands somewhere useful either way.
   */
  async copySvgToClipboard(): Promise<void> {
    try {
      const elements = this.elementsForClipboard();
      if (!elements.length) throw new Error(t("Nothing to export"));
      const svg = exportToSvgString(elements, this.files, {
        exportBackground: true,
        viewBackgroundColor: this.state.viewBackgroundColor,
        scale: 1,
        theme: this.state.theme,
      });
      const type = "image/svg+xml";
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            [type]: new Blob([svg], { type }),
            "text/plain": new Blob([svg], { type: "text/plain" }),
          }),
        ]);
      } catch {
        // Safari and Firefox reject unsupported clipboard flavours rather
        // than dropping them, so fall back to the markup as plain text.
        await navigator.clipboard.writeText(svg);
      }
      this.onMessage?.(t("SVG copied"));
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not copy to the clipboard");
    }
  }

  /** Stats for the footer panel. */
  getStats() {
    const selected = this.getSelectedElements();
    return {
      elements: this.elements.filter((element) => !element.isDeleted).length,
      selected: selected.length,
      zoom: this.state.zoom,
      scrollX: this.state.scrollX,
      scrollY: this.state.scrollY,
      pointer: this.lastPointerScene,
      selectionBounds: selected.length ? getCommonBounds(selected) : null,
    };
  }

  /** Apply a numeric edit from the stats panel to the single selected element. */
  setElementProperty(property: "x" | "y" | "width" | "height" | "angle", value: number): void {
    const selected = this.getSelectedElements();
    if (selected.length !== 1) return;
    const element = selected[0];
    const updates: Record<string, number> = {};
    if (property === "angle") updates.angle = (value * Math.PI) / 180;
    else if (property === "width" || property === "height") updates[property] = Math.max(1, value);
    else updates[property] = value;

    if ((property === "width" || property === "height") && hasPoints(element)) {
      const scaleX = property === "width" ? Math.max(1, value) / (element.width || 1) : 1;
      const scaleY = property === "height" ? Math.max(1, value) / (element.height || 1) : 1;
      const points = element.points.map(
        ([x, y]) => [x * scaleX, y * scaleY] as [number, number],
      );
      mutateElement(element, { points } as never);
    }
    mutateElement(element, updates as never);
    this.relayoutBoundText(element);
    updateBoundArrows([element], this.elements);
    this.commit();
  }
}
