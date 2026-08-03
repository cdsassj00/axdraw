/** Decoded image cache, keyed by file id. */

import type { BinaryFiles } from "../types";

const cache = new Map<string, HTMLImageElement>();
const pending = new Set<string>();

export function getCachedImage(fileId: string): HTMLImageElement | null {
  const image = cache.get(fileId);
  return image && image.complete && image.naturalWidth > 0 ? image : null;
}

/** Decode a file into the cache; `onLoad` fires once it is renderable. */
export function ensureImage(fileId: string, files: BinaryFiles, onLoad: () => void): void {
  if (cache.has(fileId) || pending.has(fileId)) return;
  const file = files[fileId];
  if (!file) return;
  pending.add(fileId);
  const image = new Image();
  image.onload = () => {
    cache.set(fileId, image);
    pending.delete(fileId);
    onLoad();
  };
  image.onerror = () => {
    pending.delete(fileId);
  };
  image.src = file.dataURL;
}

export function clearImageCache(): void {
  cache.clear();
  pending.clear();
}

/** Natural size of a data URL, used when placing a pasted/dropped image. */
export function loadImageDimensions(dataURL: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Could not decode image"));
    image.src = dataURL;
  });
}
