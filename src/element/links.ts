/**
 * Links on elements.
 *
 * Any element can carry a URL. Text that contains an address picks it up on
 * its own, so typing or pasting "https://cdsa.kr" onto the canvas gives you
 * something you can click straight through to. A linked element shows a
 * small badge at its top-right corner; one click on the badge opens the link
 * in a new tab, as does Ctrl/Cmd+click anywhere on the element.
 *
 * Only web and mail addresses are accepted. A link travels with shared and
 * collaborative scenes, so anything else — `javascript:` above all — would
 * let one person's drawing run code in another person's browser.
 */

import type { AxElement, Point } from "../types";
import { getElementAbsoluteCoords } from "./bounds";

/** Badge size on screen, in CSS pixels, at any zoom. */
export const LINK_BADGE_PX = 22;

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i;

/** A safe, absolute URL for what the user typed, or null if it is not one. */
export function normalizeLink(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (/^www\./i.test(text)) text = `https://${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /^[^\s/]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(text)) {
    // "cdsa.kr/edu" — a bare domain is a web address.
    text = `https://${text}`;
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The first web address in a piece of text, ready to open. */
export function findLinkInText(text: string): string | null {
  const match = URL_IN_TEXT.exec(text);
  if (!match) return null;
  // A sentence ending in a link usually ends with punctuation that is not
  // part of it: "자료는 https://cdsa.kr." must not open "cdsa.kr.".
  const trimmed = match[0].replace(/[.,;:!?)\]}'"。、]+$/, "");
  return normalizeLink(trimmed);
}

/** The badge's square in scene coordinates: just outside the top-right corner. */
export function linkBadgeRect(element: AxElement, zoom: number): { x: number; y: number; size: number } {
  const [, y1, x2] = getElementAbsoluteCoords(element);
  const size = LINK_BADGE_PX / zoom;
  // Clear of the selection's corner resize handle, which sits at ~4px.
  const gap = 10 / zoom;
  return { x: x2 + gap, y: y1 - size - gap, size };
}

/** The linked element whose badge is under the point, topmost first. */
export function getLinkBadgeAt(
  elements: readonly AxElement[],
  point: Point,
  zoom: number,
): AxElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (element.isDeleted || !element.link) continue;
    const badge = linkBadgeRect(element, zoom);
    if (
      point.x >= badge.x &&
      point.x <= badge.x + badge.size &&
      point.y >= badge.y &&
      point.y <= badge.y + badge.size
    ) {
      return element;
    }
  }
  return null;
}

export function openLink(url: string): void {
  const safe = normalizeLink(url);
  if (safe) window.open(safe, "_blank", "noopener,noreferrer");
}
