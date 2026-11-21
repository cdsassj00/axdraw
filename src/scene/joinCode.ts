/**
 * Six-digit join codes (worker/codes.js): a live room or a class board by a
 * number a class can read off a projector, scan as a QR, or open as a short
 * link — axdraw.org/j/482913.
 */

import { cloudFetch } from "./cloud";
import { API_BASE } from "./share";

export type JoinTarget = { kind: "room"; room: { id: string; key: string } } | { kind: "board"; slug: string };

export const JOIN_CODE_PATTERN = /^\d{6}$/;

/** The short link for a code. */
export function shortJoinLink(code: string): string {
  return `${location.origin}/j/${code}`;
}

/** "482913" → "482 913", easier to read aloud and to copy off a screen. */
export function spacedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await cloudFetch(`${API_BASE}${path}`, init, 20000);
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body as T;
}

/** A code for a room or a board; asking again for the same one renews it. */
export async function createJoinCode(target: JoinTarget): Promise<string> {
  const { code } = await call<{ code: string }>("/api/codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });
  return code;
}

export async function resolveJoinCode(code: string): Promise<JoinTarget> {
  return call<JoinTarget>(`/api/codes/${code}`);
}
