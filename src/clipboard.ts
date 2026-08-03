/** Copy / cut / paste, including system clipboard and images. */

import type { AxElement, BinaryFiles } from "./types";

const MIME_MARKER = "axdraw/clipboard";

export interface ClipboardPayload {
  type: typeof MIME_MARKER;
  elements: AxElement[];
  files: BinaryFiles;
}

/** In-memory fallback for browsers that deny clipboard access. */
let internalClipboard: ClipboardPayload | null = null;

export function buildPayload(elements: readonly AxElement[], files: BinaryFiles): ClipboardPayload {
  const used: BinaryFiles = {};
  for (const element of elements) {
    const fileId = (element as { fileId?: string | null }).fileId;
    if (fileId && files[fileId]) used[fileId] = files[fileId];
  }
  return { type: MIME_MARKER, elements: structuredClone(elements as AxElement[]), files: used };
}

export async function copyElements(
  elements: readonly AxElement[],
  files: BinaryFiles,
): Promise<void> {
  const payload = buildPayload(elements, files);
  internalClipboard = payload;
  const text = JSON.stringify(payload);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permission denied — the internal buffer still works.
  }
}

export function parsePayload(text: string): ClipboardPayload | null {
  try {
    const data = JSON.parse(text) as { type?: string; elements?: unknown; files?: unknown };
    if (data?.type === MIME_MARKER && Array.isArray(data.elements)) {
      return {
        type: MIME_MARKER,
        elements: data.elements as AxElement[],
        files: (data.files as BinaryFiles) ?? {},
      };
    }
    // Excalidraw's clipboard format is compatible enough to accept.
    if (data?.type === "excalidraw/clipboard" && Array.isArray(data.elements)) {
      return { type: MIME_MARKER, elements: data.elements as AxElement[], files: (data.files as BinaryFiles) ?? {} };
    }
  } catch {
    // Not JSON — treat as plain text.
  }
  return null;
}

export function getInternalClipboard(): ClipboardPayload | null {
  return internalClipboard;
}

export function readFileAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export function readFileAsText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsText(file);
  });
}
