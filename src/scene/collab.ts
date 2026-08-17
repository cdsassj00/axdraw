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
 */

import type { App } from "../app";
import type { AxElement, BinaryFiles } from "../types";
import { randomId } from "../utils/random";
import { t } from "../i18n";
import { decryptJson, encryptJson, fromBase64Url, generateKeyBytes, importAesKey, toBase64Url } from "./crypto";
import { API_BASE } from "./share";

export const ROOM_HASH_PATTERN = /^#room=([A-Za-z0-9]+),([A-Za-z0-9_-]+)$/;

const CURSOR_COLORS = ["#0071e3", "#e03131", "#2f9e44", "#f08c00", "#be4bdb", "#0c8599"];
const CURSOR_TIMEOUT_MS = 6000;
const SCENE_THROTTLE_MS = 150;
const CURSOR_THROTTLE_MS = 50;

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
  private cursors = new Map<string, RemoteCursor>();
  private cursorLayer: HTMLElement;
  private sceneTimer: number | null = null;
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

  /** Creates a fresh room and connects to it. */
  static create(app: App): Promise<CollabSession> {
    return new CollabSession(app, randomId(), generateKeyBytes()).connect();
  }

  /** Joins the room named in an existing link's fragment pieces. */
  static join(app: App, roomId: string, keyText: string): Promise<CollabSession> {
    return new CollabSession(app, roomId, fromBase64Url(keyText)).connect();
  }

  private async connect(): Promise<this> {
    this.key = await importAesKey(this.keyBytes);
    await this.openSocket();
    const move = (event: PointerEvent) => this.sendCursor(event);
    this.app.container.addEventListener("pointermove", move);
    this.detachPointer = () => this.app.container.removeEventListener("pointermove", move);
    this.raf = requestAnimationFrame(this.renderCursors);
    history.replaceState(null, "", `${location.pathname}${location.search}#room=${this.roomId},${toBase64Url(this.keyBytes)}`);
    return this;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(websocketUrl(this.roomId));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.ws = ws;
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
        if (!this.closed) setTimeout(() => void this.openSocket().catch(() => undefined), 2000);
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
