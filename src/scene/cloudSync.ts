/**
 * Keeps this browser's canvases and the cloud copy in step.
 *
 * - Every edit to the open canvas is saved a couple of seconds later.
 * - Opening a canvas fetches the cloud copy first if another device saved a
 *   newer one, or if the canvas has never been downloaded here at all.
 * - Saves are conditional on the version they were built on. When another
 *   device got there first, the newer copy is merged in element by element
 *   (deletions included) and saved again, so neither device loses work.
 */

import type { AxElement, BinaryFiles } from "../types";
import {
  CloudConflict,
  cloudAccount,
  deleteCloudCanvas,
  listCloudCanvases,
  pullCloudCanvas,
  pushCloudCanvas,
  type CloudAccount,
  type CloudScene,
} from "./cloud";
import { mergeElements, sceneSignature } from "./merge";
import { ROOMS_CHANGED, allRoomRecords, mergeRoomRecords, type RoomMeta } from "./recentRooms";
import {
  addBoard,
  getBoard,
  listBoards,
  readBoardScene,
  renameBoard,
  setBoardLink,
  writeBoardScene,
  type BoardMeta,
} from "./storage";

const PUSH_DELAY_MS = 2500;
/** First automatic retry after a failed save; doubles up to RETRY_MAX_MS. */
const RETRY_FIRST_MS = 15000;
const RETRY_MAX_MS = 5 * 60 * 1000;

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text && text !== "[object Object]" ? text : "Cloud saving failed";
}

/**
 * The account's list of live rooms, stored beside its canvases under a name no
 * canvas can have. Before this the list lived in each browser alone: logging in
 * elsewhere brought the canvases but not the rooms.
 */
const ROOMS_RECORD = "_rooms";
const ROOMS_SYNCED_KEY = "axdraw:rooms-synced";
/** Key in `failed` for the canvas list itself. */
const LIST = "list";

export type CloudStatus = "off" | "saving" | "saved" | "error";

/** What the sync engine needs from the editor. */
export interface CloudHost {
  currentBoardId(): string;
  currentScene(): { elements: readonly AxElement[]; files: BinaryFiles };
  /** Merge a cloud copy into the open canvas without touching undo history. */
  mergeIntoCurrent(elements: readonly unknown[], files: BinaryFiles): void;
  /** Apply a room link carried by a cloud copy to a board. */
  onCloudChanged(): void;
}

interface CloudPayload extends CloudScene {
  /** The board's live room, so it reconnects on other devices too. */
  room?: BoardMeta["room"];
}

export class CloudSync {
  status: CloudStatus = cloudAccount() ? "saved" : "off";
  lastError = "";
  private timer: number | null = null;
  private pushing = new Set<string>();
  private again = new Set<string>();
  private signatures = new Map<string, string>();
  /**
   * What is failing right now, by what it was: a canvas id for a save,
   * "pull:<id>", "delete:<id>" or LIST for the canvas list. The chip shows
   * "saving" while anything is in flight, "not saved" while anything here is
   * left, and "saved" only when both are empty — so it can no longer stick on
   * whatever the last request happened to set.
   */
  private failed = new Map<string, string>();
  private retryTimer: number | null = null;
  private retryDelay = 0;

  private roomsTimer: number | null = null;
  private roomsSignature = "";

  constructor(private readonly host: CloudHost) {
    window.addEventListener(ROOMS_CHANGED, () => this.roomsChanged());
    // Back online after a failure: try at once rather than wait for the timer.
    window.addEventListener("online", () => {
      if (this.failed.size) void this.retry();
    });
  }

  get account(): CloudAccount | null {
    return cloudAccount();
  }

  /** Recomputes the chip from what is in flight and what has failed. */
  private refresh(): void {
    if (!this.account) {
      this.failed.clear();
      this.status = "off";
      this.lastError = "";
    } else if (this.pushing.size) {
      this.status = "saving";
      this.lastError = "";
    } else if (this.failed.size) {
      this.status = "error";
      this.lastError = [...this.failed.values()].pop() ?? "Cloud saving failed";
    } else {
      this.status = "saved";
      this.lastError = "";
    }
    if (this.status === "error") this.scheduleRetry();
    else if (!this.failed.size) this.cancelRetry();
    try {
      this.host.onCloudChanged();
    } catch (error) {
      // A drawing problem in the UI must not leave the sync engine half-way.
      console.error(error);
    }
  }

  private fail(key: string, error: unknown): void {
    this.failed.set(key, messageOf(error));
    this.refresh();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryDelay = Math.min(Math.max(this.retryDelay * 2, RETRY_FIRST_MS), RETRY_MAX_MS);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.retry();
    }, this.retryDelay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelay = 0;
  }

  /** Seconds until the next automatic retry, for the chip's wording. */
  get retryingIn(): number {
    return this.retryTimer === null ? 0 : Math.round(this.retryDelay / 1000);
  }

  /**
   * Tries everything that failed again — the "try again" button, the timer
   * and coming back online all land here.
   */
  async retry(): Promise<void> {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const keys = [...this.failed.keys()];
    if (keys.includes(LIST)) {
      await this.reconcile();
    }
    for (const key of keys) {
      if (key === LIST) continue;
      if (key.startsWith("pull:")) {
        this.failed.delete(key);
        await this.pull(key.slice(5));
      } else if (key.startsWith("delete:")) {
        this.failed.delete(key);
        await this.deleted(key.slice(7));
      } else {
        await this.push(key, true);
      }
    }
    // Whatever failed again has re-armed the timer through refresh().
    this.refresh();
  }

  /**
   * Brings the board list in line with the cloud: lists canvases saved from
   * other devices, fetches the open one if it is behind, uploads anything
   * that has never been saved.
   */
  async reconcile(): Promise<void> {
    const account = this.account;
    if (!account) {
      this.refresh();
      return;
    }
    let remote;
    try {
      remote = await listCloudCanvases(account);
      this.failed.delete(LIST);
    } catch (error) {
      this.fail(LIST, error);
      return;
    }
    const seen = new Set<string>();
    const roomsRecord = remote.find((canvas) => canvas.id === ROOMS_RECORD);
    remote = remote.filter((canvas) => !canvas.id.startsWith("_"));
    for (const canvas of remote) {
      seen.add(canvas.id);
      const local = getBoard(canvas.id);
      if (!local) {
        addBoard({ id: canvas.id, name: canvas.name || "캔버스", updated: canvas.updated, remote: true });
        continue;
      }
      if (canvas.updated > (local.cloudSynced ?? 0) && canvas.name && canvas.name !== local.name) {
        renameBoard(canvas.id, canvas.name);
      }
    }
    this.host.onCloudChanged();
    const current = this.host.currentBoardId();
    const behind = remote.find((canvas) => canvas.id === current);
    if (behind && behind.updated > (getBoard(current)?.cloudSynced ?? 0)) await this.pull(current);
    // Anything never saved — or saved once and since deleted on another
    // device — goes up. Re-uploading rather than deleting here: a canvas that
    // vanished from the list is far more often a sync hiccup than a wish.
    for (const board of listBoards()) {
      if (!board.remote && !seen.has(board.id)) {
        setBoardLink(board.id, { cloudSynced: 0 });
        await this.push(board.id, true);
      }
    }
    await this.syncRooms(roomsRecord?.updated ?? 0);
    this.refresh();
  }

  private roomsSynced(): number {
    try {
      return Number(localStorage.getItem(ROOMS_SYNCED_KEY) ?? 0);
    } catch {
      return 0;
    }
  }

  private setRoomsSynced(version: number): void {
    try {
      localStorage.setItem(ROOMS_SYNCED_KEY, String(version));
    } catch {
      // Storage unavailable: the next sync merges again, which is harmless.
    }
  }

  /** The room list changed here; save it to the account shortly. */
  roomsChanged(): void {
    if (!this.account) return;
    if (this.roomsTimer !== null) window.clearTimeout(this.roomsTimer);
    this.roomsTimer = window.setTimeout(() => {
      this.roomsTimer = null;
      void this.syncRooms(0, true);
    }, 1500);
  }

  /**
   * Brings this browser's room list and the account's together: pull the
   * account copy when it is newer, merge room by room, and save the union if
   * this side had anything the account lacked.
   */
  private async syncRooms(remoteVersion: number, local = false): Promise<void> {
    const account = this.account;
    if (!account) return;
    try {
      if (remoteVersion > this.roomsSynced() || local) {
        const pulled = await pullCloudCanvas(account, ROOMS_RECORD);
        if (pulled) {
          const rooms = (pulled.scene as CloudScene & { rooms?: RoomMeta[] }).rooms ?? [];
          if (mergeRoomRecords(rooms)) this.host.onCloudChanged();
          this.setRoomsSynced(pulled.updated);
        }
      }
      const records = allRoomRecords();
      const signature = JSON.stringify(records);
      if (!records.length || signature === this.roomsSignature) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const updated = await pushCloudCanvas(
            account,
            ROOMS_RECORD,
            "rooms",
            { elements: [], files: {}, rooms: allRoomRecords() } as CloudScene,
            this.roomsSynced(),
          );
          this.setRoomsSynced(updated);
          this.roomsSignature = JSON.stringify(allRoomRecords());
          return;
        } catch (error) {
          if (!(error instanceof CloudConflict)) throw error;
          const pulled = await pullCloudCanvas(account, ROOMS_RECORD);
          if (pulled) {
            mergeRoomRecords((pulled.scene as CloudScene & { rooms?: RoomMeta[] }).rooms ?? []);
            this.setRoomsSynced(pulled.updated);
          }
        }
      }
    } catch {
      // Offline or a server hiccup: the list stays here and goes up next time.
    }
  }

  /** The open canvas changed; save it shortly. */
  changed(): void {
    if (!this.account) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.push(this.host.currentBoardId());
    }, PUSH_DELAY_MS);
  }

  /** Saves now whatever is waiting — before a canvas switch or a hidden tab. */
  flush(boardId = this.host.currentBoardId()): void {
    if (!this.account) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    void this.push(boardId);
  }

  /** A canvas was opened: fetch it if this browser's copy is behind. */
  async opened(boardId: string): Promise<void> {
    const board = getBoard(boardId);
    if (!this.account || !board) return;
    if (board.remote) {
      await this.pull(boardId);
      return;
    }
    // Cheap enough to ask every time: one small list request.
    try {
      const remote = (await listCloudCanvases(this.account)).find((canvas) => canvas.id === boardId);
      if (remote && remote.updated > (getBoard(boardId)?.cloudSynced ?? 0)) await this.pull(boardId);
    } catch {
      // Offline: the local copy is what there is.
    }
  }

  /** Resolves once nothing is waiting to be saved (or after 10s at most). */
  async idle(): Promise<void> {
    const deadline = Date.now() + 10000;
    while ((this.pushing.size || this.timer !== null) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  renamed(boardId: string): void {
    if (!this.account) return;
    void this.push(boardId, true);
  }

  async deleted(boardId: string): Promise<void> {
    const account = this.account;
    if (!account) return;
    try {
      await deleteCloudCanvas(account, boardId);
      this.failed.delete(`delete:${boardId}`);
      this.failed.delete(boardId);
      this.refresh();
    } catch (error) {
      this.fail(`delete:${boardId}`, error);
    }
  }

  private sceneOf(boardId: string): CloudPayload {
    const scene =
      boardId === this.host.currentBoardId() ? this.host.currentScene() : readBoardScene(boardId);
    return { elements: [...scene.elements], files: scene.files, room: getBoard(boardId)?.room };
  }

  /** Downloads a board's cloud copy and merges it into this browser's. */
  private async pull(boardId: string): Promise<void> {
    const account = this.account;
    if (!account) return;
    try {
      // Edits here that never reached the cloud must still go up after the
      // merge; only a copy that was clean beforehand counts as saved after.
      // A placeholder has no edits of its own: its download is the saved copy.
      const clean = Boolean(getBoard(boardId)?.remote) || this.known(boardId) === this.signatureOf(boardId);
      const pulled = await pullCloudCanvas(account, boardId);
      this.failed.delete(`pull:${boardId}`);
      if (!pulled) {
        // Listed but gone: nothing to merge, and nothing to wait for.
        setBoardLink(boardId, { remote: undefined });
        this.refresh();
        return;
      }
      this.mergeInto(boardId, pulled.scene as CloudPayload);
      setBoardLink(boardId, { cloudSynced: pulled.updated, remote: undefined });
      if (clean) this.remember(boardId, this.signatureOf(boardId));
      this.refresh();
    } catch (error) {
      this.fail(`pull:${boardId}`, error);
    }
  }

  private mergeInto(boardId: string, payload: CloudPayload): void {
    if (payload.room && !getBoard(boardId)?.room) setBoardLink(boardId, { room: payload.room });
    if (boardId === this.host.currentBoardId()) {
      this.host.mergeIntoCurrent(payload.elements, payload.files ?? {});
      return;
    }
    const stored = readBoardScene(boardId);
    writeBoardScene(
      boardId,
      mergeElements(stored.elements, payload.elements),
      { ...stored.files, ...(payload.files ?? {}) },
    );
  }

  private signatureOf(boardId: string): string {
    const scene = this.sceneOf(boardId);
    // The room link is part of what is saved: starting or stopping a live room
    // on a canvas must reach the account even when nothing is drawn after.
    const board = getBoard(boardId);
    return `${sceneSignature(scene.elements, scene.files)}|${board?.name ?? ""}|${board?.room?.id ?? ""}`;
  }

  /** Fingerprint of what the cloud holds for a board, if known. */
  private known(boardId: string): string | undefined {
    return this.signatures.get(boardId) ?? getBoard(boardId)?.cloudSignature;
  }

  private remember(boardId: string, signature: string, persist = true): void {
    this.signatures.set(boardId, signature);
    if (persist) setBoardLink(boardId, { cloudSignature: signature });
  }

  private async push(boardId: string, force = false): Promise<void> {
    const account = this.account;
    if (!account) return;
    const board = getBoard(boardId);
    // A placeholder has nothing local yet; saving it would blank the cloud
    // copy. A board deleted meanwhile has nothing left to save either.
    if (!board || board.remote) {
      if (this.failed.delete(boardId)) this.refresh();
      return;
    }
    if (this.pushing.has(boardId)) {
      this.again.add(boardId);
      return;
    }
    if (!force && this.known(boardId) === this.signatureOf(boardId)) {
      if (this.failed.delete(boardId)) this.refresh();
      return;
    }
    // Every new browser starts on a blank "캔버스 1"; uploading those would
    // fill the list with empty canvases from each device a person uses.
    if (!board.cloudSynced && !this.sceneOf(boardId).elements.some((element) => !element.isDeleted)) {
      if (this.failed.delete(boardId)) this.refresh();
      return;
    }

    this.pushing.add(boardId);
    try {
      this.refresh();
      for (let attempt = 0; attempt < 3; attempt++) {
        // Read what is sent and its fingerprint together, so the fingerprint
        // remembered afterwards is exactly what reached the cloud.
        const signature = this.signatureOf(boardId);
        try {
          const updated = await pushCloudCanvas(
            account,
            boardId,
            getBoard(boardId)?.name ?? board.name,
            this.sceneOf(boardId),
            getBoard(boardId)?.cloudSynced ?? 0,
          );
          setBoardLink(boardId, { cloudSynced: updated });
          this.remember(boardId, signature);
          this.failed.delete(boardId);
          return;
        } catch (error) {
          if (!(error instanceof CloudConflict)) throw error;
          // Another device saved first: take its work, then save the union.
          await this.pull(boardId);
        }
      }
      throw new Error("Could not save to the cloud — the canvas keeps changing on another device");
    } catch (error) {
      this.failed.set(boardId, messageOf(error));
    } finally {
      this.pushing.delete(boardId);
      this.refresh();
      if (this.again.delete(boardId)) void this.push(boardId);
    }
  }
}
