/**
 * File cards: non-image attachments (PDF, ZIP, …) rendered as a small
 * card — document icon, filename, size — that downloads on double-click.
 * They reuse the image element + BinaryFiles pipeline, so they ride
 * through share links and live collaboration unchanged.
 */

import type { AxElement, BinaryFile, BinaryFiles } from "../types";

export const FILE_CARD_WIDTH = 232;
export const FILE_CARD_HEIGHT = 68;

/** True when the element is an image element whose file is not an image. */
export function isFileCard(element: AxElement, files: BinaryFiles): boolean {
  if (element.type !== "image") return false;
  const file = element.fileId ? files[element.fileId] : null;
  return !!file && !file.mimeType.startsWith("image/");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short uppercase tag for the icon, e.g. "PDF", "ZIP". */
export function fileKindTag(file: BinaryFile): string {
  const byName = /\.([A-Za-z0-9]{1,5})$/.exec(file.name ?? "");
  if (byName) return byName[1].toUpperCase().slice(0, 4);
  const bySubtype = /\/([A-Za-z0-9.+-]+)$/.exec(file.mimeType);
  return (bySubtype?.[1] ?? "FILE").replace(/^x-/, "").toUpperCase().slice(0, 4);
}

export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, max - 1 - half)}…${text.slice(text.length - half)}`;
}

/** Paint the card onto a canvas, in scene coordinates. */
export function drawFileCard(
  ctx: CanvasRenderingContext2D,
  element: AxElement,
  file: BinaryFile,
): void {
  const { x, y, width, height } = element;
  const radius = Math.min(12, height / 4);

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#d8d2c8";
  ctx.stroke();

  // Document icon with a folded corner.
  const pad = height * 0.18;
  const iconH = height - pad * 2;
  const iconW = iconH * 0.78;
  const ix = x + pad;
  const iy = y + pad;
  const fold = iconW * 0.32;
  ctx.beginPath();
  ctx.moveTo(ix, iy);
  ctx.lineTo(ix + iconW - fold, iy);
  ctx.lineTo(ix + iconW, iy + fold);
  ctx.lineTo(ix + iconW, iy + iconH);
  ctx.lineTo(ix, iy + iconH);
  ctx.closePath();
  ctx.fillStyle = "#f3efe7";
  ctx.fill();
  ctx.strokeStyle = "#b9b2a5";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ix + iconW - fold, iy);
  ctx.lineTo(ix + iconW - fold, iy + fold);
  ctx.lineTo(ix + iconW, iy + fold);
  ctx.stroke();

  // Kind tag inside the icon.
  ctx.fillStyle = "#8a8172";
  ctx.font = `700 ${Math.max(8, iconH * 0.24)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(fileKindTag(file), ix + iconW / 2, iy + iconH * 0.68, iconW - 4);

  // Filename + size.
  const textX = ix + iconW + pad * 0.9;
  const nameSize = Math.max(11, height * 0.21);
  ctx.textAlign = "left";
  ctx.fillStyle = "#3d3a33";
  ctx.font = `600 ${nameSize}px system-ui, sans-serif`;
  const name = middleTruncate(file.name ?? "file", 24);
  ctx.fillText(name, textX, y + height * 0.4, x + width - textX - pad * 0.5);
  ctx.fillStyle = "#94908a";
  ctx.font = `${Math.max(10, height * 0.17)}px system-ui, sans-serif`;
  const sub = file.size != null ? formatFileSize(file.size) : file.mimeType;
  ctx.fillText(sub, textX, y + height * 0.68, x + width - textX - pad * 0.5);
  ctx.restore();
}
