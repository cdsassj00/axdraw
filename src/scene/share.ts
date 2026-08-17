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
import { encryptBytes, decryptBytes, fromBase64Url, generateKeyBytes, importAesKey, toBase64Url } from "./crypto";
import { parseScene, serializeScene, type ParsedScene } from "./export";

export const API_BASE: string = import.meta.env.VITE_SHARE_API ?? "";

const HASH_PATTERN = /^#share=([A-Za-z0-9]+),([A-Za-z0-9_-]+)$/;

/** Encrypts the scene, uploads it, and returns the full share URL. */
export async function createShareLink(
  elements: readonly AxElement[],
  files: BinaryFiles,
  state: AppState,
): Promise<string> {
  const json = serializeScene(elements, files, state);

  const keyBytes = generateKeyBytes();
  const key = await importAesKey(keyBytes, ["encrypt"]);
  const body = await encryptBytes(key, new TextEncoder().encode(json));

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
  const key = await importAesKey(fromBase64Url(keyText), ["decrypt"]);
  const plaintext = await decryptBytes(key, await response.arrayBuffer());
  const scene = parseScene(new TextDecoder().decode(plaintext));

  history.replaceState(null, "", location.pathname + location.search);
  return scene;
}
