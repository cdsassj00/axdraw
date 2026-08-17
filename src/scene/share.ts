/**
 * Free cloud sharing.
 *
 * Excalidraw puts "save to cloud" behind a paid plan; here a share is one
 * request to a Cloudflare Worker backed by KV. The scene is encrypted in the
 * browser with AES-GCM and the key travels in the URL *fragment* — the part
 * after `#` that browsers never send to the server — so the Worker only ever
 * stores ciphertext it cannot read. Same scheme Excalidraw uses for its share
 * links, minus the paywall around persistence.
 *
 * Link shape:  https://…/#share=<id>,<key>
 *
 * The API origin defaults to the page's own origin (the Worker serves the
 * static app and the API together). A build for static hosting (e.g. GitHub
 * Pages) points VITE_SHARE_API at the Worker instead.
 */

import type { AppState, AxElement, BinaryFiles } from "../types";
import { parseScene, serializeScene, type ParsedScene } from "./export";

const API_BASE: string = import.meta.env.VITE_SHARE_API ?? "";

const HASH_PATTERN = /^#share=([A-Za-z0-9]+),([A-Za-z0-9_-]+)$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encrypts the scene, uploads it, and returns the full share URL. */
export async function createShareLink(
  elements: readonly AxElement[],
  files: BinaryFiles,
  state: AppState,
): Promise<string> {
  const json = serializeScene(elements, files, state);

  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json)),
  );

  // iv ‖ ciphertext in one opaque body — the server never parses it.
  const body = new Uint8Array(iv.length + ciphertext.length);
  body.set(iv, 0);
  body.set(ciphertext, iv.length);

  const response = await fetch(`${API_BASE}/api/scenes`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  if (!response.ok) {
    throw new Error(response.status === 413 ? "Scene is too large to share" : "Sharing failed — is the share server deployed?");
  }
  const { id } = (await response.json()) as { id: string };
  return `${location.origin}${location.pathname}#share=${id},${toBase64Url(keyBytes)}`;
}

/**
 * If the page was opened through a share link, fetches and decrypts the scene.
 * Returns null when there is no share fragment. Clears the fragment on success
 * so a reload shows the user's own (autosaved) canvas again.
 */
export async function loadSharedScene(): Promise<ParsedScene | null> {
  const match = HASH_PATTERN.exec(location.hash);
  if (!match) return null;
  const [, id, keyText] = match;

  const response = await fetch(`${API_BASE}/api/scenes/${id}`);
  if (!response.ok) {
    throw new Error(response.status === 404 ? "This share link has expired or does not exist" : "Could not load the shared scene");
  }
  const buffer = await response.arrayBuffer();
  const iv = new Uint8Array(buffer, 0, 12);
  const ciphertext = new Uint8Array(buffer, 12);
  const key = await crypto.subtle.importKey("raw", fromBase64Url(keyText), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const scene = parseScene(new TextDecoder().decode(plaintext));

  history.replaceState(null, "", location.pathname + location.search);
  return scene;
}
