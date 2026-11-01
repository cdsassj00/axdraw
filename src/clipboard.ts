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

/** The picture of a copy, as a data URL (sync) and a PNG blob. */
export interface ClipboardPicture {
  dataUrl: string;
  png: Promise<Blob | null>;
}

const HTML_MARKER = "axdraw-elements:";

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decodeBase64(text: string): string {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * The copy as HTML: a picture for every other program, with the shapes
 * themselves tucked into a comment for axdraw. Word, PowerPoint, Gmail,
 * Notion and messengers paste the picture; axdraw pastes editable shapes.
 */
export function payloadHtml(payload: ClipboardPayload, picture: ClipboardPicture | null): string {
  const image = picture ? `<img src="${picture.dataUrl}" alt="axdraw">` : "";
  return `<meta charset="utf-8">${image}<!--${HTML_MARKER}${encodeBase64(JSON.stringify(payload))}-->`;
}

export function payloadFromHtml(html: string): ClipboardPayload | null {
  const start = html.indexOf(`<!--${HTML_MARKER}`);
  if (start < 0) return null;
  const end = html.indexOf("-->", start);
  if (end < 0) return null;
  try {
    return parsePayload(decodeBase64(html.slice(start + 4 + HTML_MARKER.length, end).trim()));
  } catch {
    return null;
  }
}

/**
 * Puts a copy on the clipboard: the shapes for axdraw and, when a picture is
 * given, a PNG of them for everything else — so a diagram copied with Ctrl+C
 * pastes straight into a slide or a chat as an image.
 */
export async function copyElements(
  elements: readonly AxElement[],
  files: BinaryFiles,
  picture: ClipboardPicture | null = null,
): Promise<void> {
  const payload = buildPayload(elements, files);
  internalClipboard = payload;
  if (picture && typeof ClipboardItem !== "undefined") {
    try {
      const png = await picture.png;
      const html = payloadHtml(payload, picture);
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          ...(png ? { "image/png": png } : {}),
        }),
      ]);
      return;
    } catch {
      // A browser without rich clipboard writes: fall back to the shapes.
    }
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload));
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
