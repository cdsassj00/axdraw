/**
 * Cloud canvases — every canvas kept on the server, free, behind an email.
 *
 * Until a user leaves an email, canvases live in this browser only, and a
 * cleared cache or a different computer means they are gone. Registering
 * creates a workspace: a random id plus a secret that never leaves the
 * browser. Two things are derived from the secret —
 *
 *   - an access token (a SHA-256 of it), which the server stores hashed and
 *     checks on every request, and
 *   - the AES-GCM key every canvas and canvas name is encrypted with.
 *
 * So the server holds the email and consent record, and ciphertext. Opening
 * the same canvases on another device takes the workspace link (which carries
 * the secret in the `#` fragment, like every other link in axdraw).
 *
 * Link shape:  https://…/#cloud=<workspace>,<secret>
 */

import type { AxElement, BinaryFiles } from "../types";
import { decryptBytes, decryptJson, encryptBytes, encryptJson, fromBase64Url, importAesKey, toBase64Url } from "./crypto";
import { API_BASE } from "./share";

const ACCOUNT_KEY = "axdraw:cloud";
export const CLOUD_HASH_PATTERN = /^#cloud=([A-Za-z0-9]{10,40}),([A-Za-z0-9_-]{20,60})$/;

export interface CloudAccount {
  workspace: string;
  /** base64url, 32 random bytes. The only copy is this browser (and the link). */
  secret: string;
  email: string;
}

export interface CloudCanvasMeta {
  id: string;
  name: string;
  updated: number;
  size: number;
}

export interface CloudScene {
  elements: AxElement[];
  files: BinaryFiles;
}

/** A save that lost the race to another device; merge and try again. */
export class CloudConflict extends Error {
  constructor(readonly updated: number) {
    super("This canvas changed on another device");
  }
}

export function cloudAccount(): CloudAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloudAccount;
    return parsed && typeof parsed.workspace === "string" && typeof parsed.secret === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function storeAccount(account: CloudAccount | null): void {
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // Storage unavailable: the account lasts for this tab only.
  }
}

async function tokenFor(secret: string): Promise<string> {
  const material = new TextEncoder().encode(`axdraw-cloud-auth:${secret}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", material)));
}

async function keyFor(secret: string): Promise<CryptoKey> {
  // AES-256 straight from the 32 random bytes. The token above is a hash of
  // the same secret, so the server can verify access without learning the key.
  return importAesKey(fromBase64Url(secret));
}

async function authHeaders(account: CloudAccount): Promise<Record<string, string>> {
  return { authorization: `Bearer ${account.workspace}.${await tokenFor(account.secret)}` };
}

async function failure(response: Response, fallback: string): Promise<Error> {
  if (response.status === 503) return new Error("Cloud saving is not switched on yet on this server");
  if (response.status === 401) return new Error("This browser's cloud access is no longer valid");
  if (response.status === 413) return new Error("This canvas is too large to save to the cloud");
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

/**
 * Creates the workspace. `privacy` must be true — it is the required consent
 * — while `marketing` is the separate, optional newsletter opt-in.
 */
export async function registerCloud(
  email: string,
  consent: { privacy: boolean; marketing: boolean },
): Promise<CloudAccount> {
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const response = await fetch(`${API_BASE}/api/cloud/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      privacy: consent.privacy,
      marketing: consent.marketing,
      token: await tokenFor(secret),
      source: "app",
    }),
  });
  if (!response.ok) throw await failure(response, "Could not switch on cloud saving");
  const { workspace } = (await response.json()) as { workspace: string };
  const account = { workspace, secret, email: email.trim().toLowerCase() };
  storeAccount(account);
  return account;
}

/**
 * The password, stretched in the browser so the server never sees it: PBKDF2,
 * 200,000 rounds, salted with the email. The server stores only a salted hash
 * of the result.
 */
async function authKeyFor(email: string, password: string): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(`axdraw-account:${email.trim().toLowerCase()}`),
      iterations: 200_000,
    },
    material,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

async function accountRequest(path: string, body: unknown): Promise<{ workspace: string; secret: string }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401) throw new Error("Wrong email or password");
  if (response.status === 409) throw new Error("This email already has an account — log in instead");
  if (response.status === 429) throw new Error("Too many attempts — try again in 15 minutes");
  if (!response.ok) throw await failure(response, "Could not reach the server");
  return (await response.json()) as { workspace: string; secret: string };
}

/**
 * Creates an account. Whatever this browser already keeps in the cloud comes
 * along: an earlier link-based workspace becomes the account's.
 */
export async function signupAccount(
  email: string,
  password: string,
  consent: { privacy: boolean; marketing: boolean },
): Promise<CloudAccount> {
  const existing = cloudAccount();
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const result = await accountRequest("/api/account/signup", {
    email,
    authKey: await authKeyFor(email, password),
    privacy: consent.privacy,
    marketing: consent.marketing,
    workspace: existing
      ? { id: existing.workspace, secret: existing.secret, token: await tokenFor(existing.secret) }
      : undefined,
    fresh: { secret, token: await tokenFor(secret) },
  });
  const account = { workspace: result.workspace, secret: result.secret, email: email.trim().toLowerCase() };
  storeAccount(account);
  return account;
}

/** Logs in on this device: the account's canvases follow. */
export async function loginAccount(email: string, password: string): Promise<CloudAccount> {
  const result = await accountRequest("/api/account/login", {
    email,
    authKey: await authKeyFor(email, password),
  });
  const account = { workspace: result.workspace, secret: result.secret, email: email.trim().toLowerCase() };
  storeAccount(account);
  return account;
}

/** Adopts a workspace from a #cloud=… link opened on another device. */
export function adoptCloudFromHash(): CloudAccount | null {
  const match = CLOUD_HASH_PATTERN.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, "", location.pathname + location.search);
  const previous = cloudAccount();
  const account = {
    workspace: match[1],
    secret: match[2],
    email: previous?.workspace === match[1] ? previous.email : "",
  };
  storeAccount(account);
  return account;
}

export function cloudLink(account: CloudAccount): string {
  return `${location.origin}${location.pathname}#cloud=${account.workspace},${account.secret}`;
}

/** Forgets the workspace in this browser only; the server copy stays. */
export function disconnectCloud(): void {
  storeAccount(null);
}

export async function fetchAccount(account: CloudAccount): Promise<{ email: string; marketing: boolean }> {
  const response = await fetch(`${API_BASE}/api/cloud/account`, { headers: await authHeaders(account) });
  if (!response.ok) throw await failure(response, "Could not reach cloud storage");
  const result = (await response.json()) as { email: string; marketing: boolean };
  if (result.email && result.email !== account.email) storeAccount({ ...account, email: result.email });
  return result;
}

export async function setMarketingConsent(account: CloudAccount, marketing: boolean): Promise<void> {
  const response = await fetch(`${API_BASE}/api/cloud/consent`, {
    method: "POST",
    headers: { ...(await authHeaders(account)), "content-type": "application/json" },
    body: JSON.stringify({ marketing }),
  });
  if (!response.ok) throw await failure(response, "Could not update the newsletter setting");
}

/** Deletes every cloud canvas and the account, then forgets it locally. */
export async function deleteCloudAccount(account: CloudAccount): Promise<void> {
  const response = await fetch(`${API_BASE}/api/cloud/account`, {
    method: "DELETE",
    headers: await authHeaders(account),
  });
  if (!response.ok) throw await failure(response, "Could not delete cloud data");
  storeAccount(null);
}

export async function listCloudCanvases(account: CloudAccount): Promise<CloudCanvasMeta[]> {
  const response = await fetch(`${API_BASE}/api/cloud/canvases`, { headers: await authHeaders(account) });
  if (!response.ok) throw await failure(response, "Could not list cloud canvases");
  const { canvases } = (await response.json()) as {
    canvases: { id: string; name: string; updated: number; size: number }[];
  };
  const key = await keyFor(account.secret);
  return Promise.all(
    canvases.map(async (canvas) => {
      let name = "";
      try {
        name = new TextDecoder().decode(await decryptBytes(key, fromBase64Url(canvas.name).buffer));
      } catch {
        // A name that does not decrypt is shown as untitled, not as an error.
      }
      return { id: canvas.id, name, updated: canvas.updated, size: canvas.size };
    }),
  );
}

export async function pullCloudCanvas(
  account: CloudAccount,
  id: string,
): Promise<{ scene: CloudScene; updated: number } | null> {
  const response = await fetch(`${API_BASE}/api/cloud/canvases/${id}`, { headers: await authHeaders(account) });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response, "Could not load the canvas from the cloud");
  const scene = await decryptJson<CloudScene>(await keyFor(account.secret), await response.arrayBuffer());
  return {
    scene: { elements: Array.isArray(scene.elements) ? scene.elements : [], files: scene.files ?? {} },
    updated: Number(response.headers.get("x-canvas-updated") ?? 0),
  };
}

/**
 * Saves one canvas. `base` is the server version this copy was built on; if
 * another device saved since, the server refuses with CloudConflict and the
 * caller merges before retrying, so neither device's work is overwritten.
 */
export async function pushCloudCanvas(
  account: CloudAccount,
  id: string,
  name: string,
  scene: CloudScene,
  base: number,
): Promise<number> {
  const key = await keyFor(account.secret);
  const encryptedName = toBase64Url(await encryptBytes(key, new TextEncoder().encode(name)));
  const response = await fetch(`${API_BASE}/api/cloud/canvases/${id}`, {
    method: "PUT",
    headers: {
      ...(await authHeaders(account)),
      "content-type": "application/octet-stream",
      "x-canvas-name": encryptedName,
      "x-base-version": String(base),
    },
    body: await encryptJson(key, scene),
  });
  if (response.status === 409) {
    const { updated } = (await response.json()) as { updated: number };
    throw new CloudConflict(updated);
  }
  if (!response.ok) throw await failure(response, "Could not save to the cloud");
  return ((await response.json()) as { updated: number }).updated;
}

export async function deleteCloudCanvas(account: CloudAccount, id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/cloud/canvases/${id}`, {
    method: "DELETE",
    headers: await authHeaders(account),
  });
  if (!response.ok && response.status !== 404) throw await failure(response, "Could not delete the cloud copy");
}
