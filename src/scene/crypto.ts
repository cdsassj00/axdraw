/**
 * Shared E2E-encryption helpers.
 *
 * Both cloud share links and live-collaboration rooms encrypt in the browser
 * with AES-GCM and carry the key in the URL fragment, so the server only ever
 * relays or stores ciphertext.
 */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateKeyBytes(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function importAesKey(
  keyBytes: Uint8Array<ArrayBuffer>,
  usages: KeyUsage[] = ["encrypt", "decrypt"],
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, usages);
}

/** Returns iv ‖ ciphertext in one opaque buffer — servers never parse it. */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const body = new Uint8Array(iv.length + ciphertext.length);
  body.set(iv, 0);
  body.set(ciphertext, iv.length);
  return body;
}

export async function decryptBytes(key: CryptoKey, body: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = new Uint8Array(body, 0, 12);
  const ciphertext = new Uint8Array(body, 12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

export async function encryptJson(key: CryptoKey, data: unknown): Promise<Uint8Array<ArrayBuffer>> {
  return encryptBytes(key, new TextEncoder().encode(JSON.stringify(data)));
}

export async function decryptJson<T>(key: CryptoKey, body: ArrayBuffer): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await decryptBytes(key, body))) as T;
}
