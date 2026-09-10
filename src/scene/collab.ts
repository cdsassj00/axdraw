/**
 * Live collaboration.
 *
 * A room is a Cloudflare Durable Object that relays WebSocket messages
 * between everyone connected to the same room id — nothing more. Every
 * message is AES-GCM-encrypted in the browser with a key that only exists in
 * the room URL's `#` fragment, so the relay carries ciphertext it cannot
 * read: end-to-end encrypted collaboration on free-tier infrastructure.
 *
 * Room link:  https://…/#room=<id>,<key>
 *
 * Sync is deliberately simple — full-scene broadcasts merged element-wise by
 * (version, updated) last-writer-wins, the same convergence rule Excalidraw
 * uses. No operational transforms; a whiteboard's elements are independent
 * enough that per-element LWW converges fine in practice.
 *
 * The relay is still only a relay, but the room is no longer ephemeral: the
 * scene is also written to KV as ciphertext, throttled, and read back on
 * join. That is what makes the room link sufficient on its own — before it,
 * keeping a room's work meant also minting a share link, which froze at the
 * moment it was made and had to be re-minted (as a new link) to catch up.
 */

import type { App } from "../app";
import type { AxElement, BinaryFiles } from "../types";
import { randomId } from "../utils/random";
import { t } from "../i18n";
import { decryptJson, encryptJson, fromBase64Url, generateKeyBytes, importAesKey, toBase64Url } from "./crypto";
import { rememberRoom } from "./recentRooms";
import { API_BASE } from "./share";

export const ROOM_HASH_PATTERN = /^#room=([A-Za-z0-9]+),([A-Za-z0-9_-]+)$/;

const CURSOR_COLORS = ["#0071e3", "#e03131", "#2f9e44", "#f08c00", "#be4bdb", "#0c8599"];
const CURSOR_TIMEOUT_MS = 6000;
const SCENE_THROTTLE_MS = 150;
const CURSOR_THROTTLE_MS = 50;
// Only the person drawing saves, and only this often. A full-scene save
// carries everyone's merged work, so one artist's saves cover the room; a
// save per participant per edit would multiply writes for no extra safety.
const SAVE_THROTTLE_MS = 15000;

type Message =
  | { t: "scene"; from: string; elements: AxElement[]; files: BinaryFiles }
  | { t: "cursor"; from: string; x: number; y: number }
  | { t: "hello"; from: string }
  | { t: "bye"; from: string };

interface RemoteCursor {
  node: HTMLElement;
  x: number;
  y: number;
  lastSeen: number;
}

function websocketUrl(roomId: string): string {
  const base = API_BASE ? new URL(API_BASE) : new URL(location.href);
  const protocol = base.protocol === "http:" ? "ws:" : "wss:";
  return `${protocol}//${base.host}/api/rooms/${roomId}/ws`;
}

export class CollabSession {
  readonly url: string;
  private readonly app: App;
  private readonly selfId = randomId();
  private key: CryptoKey | null = null;
  private ws: WebSocket | null = null;
  private closed = false;
  private everConnected = false;
  private cursors = new Map<string, RemoteCursor>();
  private cursorLayer: HTMLElement;
  private sceneTimer: number | null = null;
  private saveTimer: number | null = null;
  private lastCursorSent = 0;
  private sentFileIds = new Set<string>();
  private raf = 0;
  private detachPointer: (() => void) | null = null;

  private constructor(app: App, private roomId: string, private keyBytes: Uint8Array<ArrayBuffer>) {
    this.app = app;
    this.url = `${location.origin}${location.pathname}#room=${roomId},${toBase64Url(keyBytes)}`;
    this.cursorLayer = document.createElement("div");
    this.cursorLayer.className = "collab-cursors";
    app.container.appendChild(this.cursorLayer);
  }

  /** Room id, for labelling this room in the recent list. */
  get id(): string {
    return this.roomId;
  }

  /** Creates a fresh room and connects to it. */
  static create(app: App): Promise<CollabSession> {
    return new CollabSession(app, randomId(), generateKeyBytes()).connect();
  }

  /** Joins the room named in an existing link's fragment pieces. */
  static join(app: App, roomId: string, keyText: string): Promise<CollabSession> {
    return new CollabSession(app, roomId, fromBase64Url(keyText)).connect();
  }

  /**
   * Loads the room's saved scene.
   *
   * The relay itself keeps nothing, so a room used to die with its last tab.
   * Restoring here means the room link alone is enough — no second share link
   * frozen at the moment it was made. Peers' live broadcasts merge on top by
   * the usual last-writer-wins, so a stale save cannot undo newer work.
   */
  private async restoreSaved(): Promise<void> {
    if (!this.key) return;
    try {
      const response = await fetch(`${API_BASE}/api/rooms/${this.roomId}/scene`);
      if (!response.ok) return; // 404 for a room nobody has saved yet.
      const scene = await decryptJson<{ elements: AxElement[]; files: BinaryFiles }>(
        this.key,
        await response.arrayBuffer(),
      );
      if (Array.isArray(scene.elements) && scene.elements.length) {
        this.app.applyRemoteScene(scene.elements, scene.files ?? {});
      }
    } catch {
      // A wrong key or an unreachable API: the room still works live.
    }
  }

  /**
   * Saves the room. Throttled well clear of KV's one-write-per-second per
   * key, since a busy room commits many times a second.
   */
  private queueSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveScene();
    }, SAVE_THROTTLE_MS);
  }

  private async saveScene(unloading = false): Promise<void> {
    if (!this.key || this.closed) return;
    try {
      const payload = await encryptJson(this.key, {
        elements: this.app.elements.filter((element) => !element.isDeleted),
        files: this.app.files,
      });
      await fetch(`${API_BASE}/api/rooms/${this.roomId}/scene`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: payload,
        // A request started during unload is cancelled with the page unless
        // it is marked keepalive. Bodies over ~64 KiB are rejected outright,
        // which is why the hidden-tab flush below matters more.
        ...(unloading ? { keepalive: true } : {}),
      });
    } catch {
      // Offline, or a keepalive body over the cap. The visibility flush and
      // the next commit both get another chance.
    }
  }

  /**
   * Writes now instead of at the end of the throttle window.
   *
   * Closing a tab never runs destroy(), so without this the last few seconds
   * of a room's work died with whoever drew it. Hiding the tab is the useful
   * moment: it fires before unload, and unlike unload the request is allowed
   * to finish normally, so even a large scene gets written.
   */
  private flushSave = (unloading = false): void => {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.saveScene(unloading);
  };

  private onPageHide = (): void => this.flushSave(true);
  private onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.flushSave();
  };

  private async connect(): Promise<this> {
    this.key = await importAesKey(this.keyBytes);
    try {
      await this.openSocket();
    } catch (error) {
      // The app never sees this object, so nothing else will tidy it up.
      this.closed = true;
      this.cursorLayer.remove();
      throw error;
    }
    const move = (event: PointerEvent) => this.sendCursor(event);
    this.app.container.addEventListener("pointermove", move);
    this.detachPointer = () => this.app.container.removeEventListener("pointermove", move);
    this.raf = requestAnimationFrame(this.renderCursors);
    history.replaceState(null, "", `${location.pathname}${location.search}#room=${this.roomId},${toBase64Url(this.keyBytes)}`);
    // The relay stores nothing, so this list is the only way back into a room
    // once its link leaves the address bar.
    rememberRoom(this.roomId, toBase64Url(this.keyBytes), this.app.currentBoardName());
    void this.restoreSaved();
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onVisibility);
    return this;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(websocketUrl(this.roomId));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.ws = ws;
        this.everConnected = true;
        void this.send({ t: "hello", from: this.selfId });
        // A fresh peer should also offer what it has — with two blank
        // canvases this is a no-op; with content it seeds the room.
        this.queueBroadcast();
        resolve();
      };
      ws.onmessage = (event) => void this.receive(event.data as ArrayBuffer);
      ws.onerror = () => reject(new Error("Could not reach the collaboration server"));
      ws.onclose = () => {
        this.ws = null;
        // Reconnect only a session that was live: when the very first connect
        // fails, connect() rejects and the app never takes ownership of this
        // object, so retrying here would leave an unreachable session dialling
        // the relay every two seconds for the life of the page.
        if (!this.closed && this.everConnected) {
          setTimeout(() => void this.openSocket().catch(() => undefined), 2000);
        }
      };
    });
  }

  /** Called by the app after every local commit; trailing-throttled. */
  queueBroadcast(): void {
    if (this.sceneTimer !== null) return;
    this.sceneTimer = window.setTimeout(() => {
      this.sceneTimer = null;
      void this.broadcastScene();
    }, SCENE_THROTTLE_MS);
  }

  private async broadcastScene(): Promise<void> {
    // Send files only once per session — they are immutable blobs, and
    // re-sending pasted images on every stroke would swamp the socket.
    const files: BinaryFiles = {};
    for (const [id, file] of Object.entries(this.app.files)) {
      if (!this.sentFileIds.has(id)) {
        files[id] = file;
        this.sentFileIds.add(id);
      }
    }
    await this.send({ t: "scene", from: this.selfId, elements: this.app.elements as AxElement[], files });
    this.queueSave();
  }

  private sendCursor(event: PointerEvent): void {
    const now = performance.now();
    if (now - this.lastCursorSent < CURSOR_THROTTLE_MS) return;
    this.lastCursorSent = now;
    const rect = this.app.container.getBoundingClientRect();
    const { zoom, scrollX, scrollY } = this.app.state;
    const x = (event.clientX - rect.left) / zoom - scrollX;
    const y = (event.clientY - rect.top) / zoom - scrollY;
    void this.send({ t: "cursor", from: this.selfId, x, y });
  }

  private async send(message: Message): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.key) return;
    this.ws.send(await encryptJson(this.key, message));
  }

  private async receive(data: ArrayBuffer): Promise<void> {
    if (!this.key) return;
    let message: Message;
    try {
      message = await decryptJson<Message>(this.key, data);
    } catch {
      return; // Wrong key or corrupt frame — drop it.
    }
    if (message.from === this.selfId) return;

    switch (message.t) {
      case "scene":
        // No save here: a received scene is already merged into this
        // client's elements, so whoever is drawing writes it out with their
        // own next save. Saving on every peer frame would multiply writes by
        // the number of people in the room.
        this.app.applyRemoteScene(message.elements, message.files);
        break;
      case "cursor":
        this.updateCursor(message.from, message.x, message.y);
        break;
      case "hello":
        this.app.onMessage?.(t("A collaborator joined"));
        this.sentFileIds.clear(); // Newcomers need the images too.
        void this.broadcastScene();
        break;
      case "bye":
        this.removeCursor(message.from);
        this.app.onMessage?.(t("A collaborator left"));
        break;
    }
  }

  /* ---------------- remote cursors ---------------- */

  private updateCursor(id: string, x: number, y: number): void {
    let cursor = this.cursors.get(id);
    if (!cursor) {
      const node = document.createElement("div");
      node.className = "collab-cursor";
      node.style.background = CURSOR_COLORS[
        Math.abs([...id].reduce((h, c) => h * 31 + c.charCodeAt(0), 0)) % CURSOR_COLORS.length
      ];
      this.cursorLayer.appendChild(node);
      cursor = { node, x, y, lastSeen: 0 };
      this.cursors.set(id, cursor);
    }
    cursor.x = x;
    cursor.y = y;
    cursor.lastSeen = performance.now();
  }

  private removeCursor(id: string): void {
    this.cursors.get(id)?.node.remove();
    this.cursors.delete(id);
  }

  /** Repositions cursors every frame so they track pan/zoom for free. */
  private renderCursors = (): void => {
    const now = performance.now();
    const { zoom, scrollX, scrollY } = this.app.state;
    for (const [id, cursor] of this.cursors) {
      if (now - cursor.lastSeen > CURSOR_TIMEOUT_MS) {
        this.removeCursor(id);
        continue;
      }
      cursor.node.style.transform = `translate(${(cursor.x + scrollX) * zoom}px, ${(cursor.y + scrollY) * zoom}px)`;
    }
    this.raf = requestAnimationFrame(this.renderCursors);
  };

  destroy(): void {
    // Flush before closing: the throttle window is several seconds, and
    // leaving is exactly when the last edits must not be lost.
    this.flushSave();
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.closed = true;
    void this.send({ t: "bye", from: this.selfId });
    this.ws?.close();
    this.detachPointer?.();
    cancelAnimationFrame(this.raf);
    this.cursorLayer.remove();
    if (ROOM_HASH_PATTERN.test(location.hash)) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }
}
