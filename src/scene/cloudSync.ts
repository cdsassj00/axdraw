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

  constructor(private readonly host: CloudHost) {}

  get account(): CloudAccount | null {
    return cloudAccount();
  }

  private setStatus(status: CloudStatus, error = ""): void {
    this.status = status;
    this.lastError = error;
    this.host.onCloudChanged();
  }

  /**
   * Brings the board list in line with the cloud: lists canvases saved from
   * other devices, fetches the open one if it is behind, uploads anything
   * that has never been saved.
   */
  async reconcile(): Promise<void> {
    const account = this.account;
    if (!account) {
      this.setStatus("off");
      return;
    }
    let remote;
    try {
      remote = await listCloudCanvases(account);
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
      return;
    }
    const seen = new Set<string>();
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
    if (this.status !== "error") this.setStatus("saved");
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
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
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
      const pulled = await pullCloudCanvas(account, boardId);
      if (!pulled) {
        // Listed but gone: nothing to merge, and nothing to wait for.
        setBoardLink(boardId, { remote: undefined });
        return;
      }
      this.mergeInto(boardId, pulled.scene as CloudPayload);
      setBoardLink(boardId, { cloudSynced: pulled.updated, remote: undefined });
      this.signatures.set(boardId, this.signatureOf(boardId));
      this.host.onCloudChanged();
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
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
    return `${sceneSignature(scene.elements, scene.files)}|${getBoard(boardId)?.name ?? ""}`;
  }

  private async push(boardId: string, force = false): Promise<void> {
    const account = this.account;
    const board = getBoard(boardId);
    // A placeholder has nothing local yet; saving it would blank the cloud copy.
    if (!account || !board || board.remote) return;
    if (this.pushing.has(boardId)) {
      this.again.add(boardId);
      return;
    }
    const signature = this.signatureOf(boardId);
    if (!force && this.signatures.get(boardId) === signature) return;
    // Every new browser starts on a blank "캔버스 1"; uploading those would
    // fill the list with empty canvases from each device a person uses.
    if (!getBoard(boardId)?.cloudSynced && !this.sceneOf(boardId).elements.some((element) => !element.isDeleted)) {
      return;
    }

    this.pushing.add(boardId);
    this.setStatus("saving");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const updated = await pushCloudCanvas(
            account,
            boardId,
            getBoard(boardId)?.name ?? board.name,
            this.sceneOf(boardId),
            getBoard(boardId)?.cloudSynced ?? 0,
          );
          setBoardLink(boardId, { cloudSynced: updated });
          this.signatures.set(boardId, signature);
          this.setStatus("saved");
          return;
        } catch (error) {
          if (!(error instanceof CloudConflict)) throw error;
          // Another device saved first: take its work, then save the union.
          await this.pull(boardId);
        }
      }
      throw new Error("Could not save to the cloud — the canvas keeps changing on another device");
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      this.pushing.delete(boardId);
      if (this.again.delete(boardId)) void this.push(boardId);
    }
  }
}
