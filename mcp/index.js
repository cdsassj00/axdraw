#!/usr/bin/env node
/**
 * axdraw MCP server — lets an AI agent draw on https://axdraw.org.
 *
 * Zero dependencies (Node ≥ 20: global WebSocket, fetch, webcrypto).
 * Speaks MCP over stdio (newline-delimited JSON-RPC), exposing two tools:
 *
 *   axdraw_create_drawing  — build a scene from a simple element spec,
 *                            encrypt it client-side, upload to the share
 *                            API and return a share URL. The server only
 *                            ever stores ciphertext; the key rides in the
 *                            URL fragment.
 *
 *   axdraw_draw_live       — join a live-collaboration room by its
 *                            #room=<id>,<key> URL (the same E2E-encrypted
 *                            protocol the browser speaks) and broadcast
 *                            elements into it, so they appear on every
 *                            participant's canvas in real time.
 *
 * Register with Claude Code:
 *   claude mcp add axdraw -- node /path/to/axdraw/mcp/index.js
 */

import { createInterface } from "node:readline";
import { webcrypto as crypto } from "node:crypto";

const ORIGIN = process.env.AXDRAW_ORIGIN || "https://axdraw.org";

/* ---------------------------------------------------------------- *
 * Crypto — mirrors src/scene/crypto.ts
 * ---------------------------------------------------------------- */

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64url = (text) => new Uint8Array(Buffer.from(text, "base64url"));

async function encryptJson(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))),
  );
  const body = new Uint8Array(iv.length + ciphertext.length);
  body.set(iv, 0);
  body.set(ciphertext, iv.length);
  return body;
}

/* ---------------------------------------------------------------- *
 * Element builder — a friendly spec in, full axdraw elements out
 * ---------------------------------------------------------------- */

const randomId = () => Math.random().toString(36).slice(2, 12);

function baseElement(spec) {
  return {
    id: randomId(),
    x: spec.x,
    y: spec.y,
    width: spec.width ?? 0,
    height: spec.height ?? 0,
    angle: spec.angle ?? 0,
    strokeColor: spec.strokeColor ?? "#1e1e1e",
    backgroundColor: spec.backgroundColor ?? "transparent",
    fillStyle: spec.fillStyle ?? "solid",
    strokeWidth: spec.strokeWidth ?? 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    roundness: spec.type === "rectangle" ? { type: "round" } : null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    groupIds: [],
    frameId: null,
    boundElements: null,
    locked: false,
    isDeleted: false,
    link: null,
    updated: Date.now(),
  };
}

/** Rough width estimate; the app re-measures with real fonts on load. */
function textSize(text, fontSize) {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((line) => [...line].reduce(
    (w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55), 0)));
  return { width: Math.max(10, longest * fontSize), height: lines.length * fontSize * 1.25 };
}

function buildElements(specs) {
  const out = [];
  for (const spec of specs) {
    const base = baseElement(spec);
    switch (spec.type) {
      case "rectangle":
      case "ellipse":
      case "diamond":
        out.push({ ...base, type: spec.type });
        break;
      case "arrow":
      case "line": {
        const points = spec.points ?? [[0, 0], [spec.width ?? 100, spec.height ?? 0]];
        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        out.push({
          ...base,
          type: spec.type,
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
          points,
          startBinding: null,
          endBinding: null,
          startArrowhead: "none",
          endArrowhead: spec.type === "arrow" ? "arrow" : "none",
          elbowed: false,
        });
        break;
      }
      case "text": {
        const fontSize = spec.fontSize ?? 20;
        const size = textSize(spec.text ?? "", fontSize);
        out.push({
          ...base,
          type: "text",
          text: spec.text ?? "",
          originalText: spec.text ?? "",
          fontSize,
          fontFamily: spec.fontFamily ?? "hand",
          textAlign: spec.textAlign ?? "left",
          verticalAlign: "top",
          containerId: null,
          lineHeight: 1.25,
          letterSpacing: 0,
          autoResize: true,
          width: spec.width ?? size.width,
          height: spec.height ?? size.height,
          backgroundColor: "transparent",
        });
        break;
      }
      default:
        throw new Error(`Unknown element type: ${spec.type}`);
    }
    // Convenience: label a shape by centring a text element on it.
    if (spec.label && spec.type !== "text") {
      const fontSize = spec.fontSize ?? 20;
      const size = textSize(spec.label, fontSize);
      out.push({
        ...baseElement({ type: "text", x: spec.x + (spec.width - size.width) / 2, y: spec.y + (spec.height - size.height) / 2 }),
        type: "text",
        text: spec.label,
        originalText: spec.label,
        fontSize,
        fontFamily: "hand",
        textAlign: "center",
        verticalAlign: "top",
        containerId: null,
        lineHeight: 1.25,
        letterSpacing: 0,
        autoResize: true,
        width: size.width,
        height: size.height,
        strokeColor: spec.strokeColor ?? "#1e1e1e",
        backgroundColor: "transparent",
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * Tools
 * ---------------------------------------------------------------- */

async function createDrawing({ elements, background }) {
  const built = buildElements(elements);
  const scene = {
    type: "axdraw",
    version: 1,
    source: "axdraw-mcp",
    elements: built,
    appState: { viewBackgroundColor: background ?? "#faf7f2" },
    files: {},
  };
  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptJson(keyBytes, scene);
  const response = await fetch(`${ORIGIN}/api/scenes`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  if (!response.ok) throw new Error(`Upload failed: HTTP ${response.status}`);
  const { id } = await response.json();
  return `${ORIGIN}/#share=${id},${b64url(keyBytes)}`;
}

async function drawLive({ room_url, elements }) {
  const match = /#room=([A-Za-z0-9]+),([A-Za-z0-9_-]+)/.exec(room_url);
  if (!match) throw new Error("room_url must contain #room=<id>,<key> — ask the user to start Live collaboration and share the link");
  const [, roomId, keyText] = match;
  const origin = new URL(room_url).origin;
  const keyBytes = fromB64url(keyText);
  const built = buildElements(elements);
  const selfId = randomId();

  const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/rooms/${roomId}/ws`);
  ws.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("Could not reach the collaboration room"));
    setTimeout(() => reject(new Error("Room connection timed out")), 10000);
  });
  // hello, then the scene — same envelope the browser sends.
  ws.send(await encryptJson(keyBytes, { t: "hello", from: selfId }));
  ws.send(await encryptJson(keyBytes, { t: "scene", from: selfId, elements: built, files: {} }));
  // Give the relay a moment to fan out before closing.
  await new Promise((resolve) => setTimeout(resolve, 600));
  ws.send(await encryptJson(keyBytes, { t: "bye", from: selfId }));
  ws.close();
  return `Drew ${built.length} element(s) into the live room.`;
}

/* ---------------------------------------------------------------- *
 * MCP over stdio (newline-delimited JSON-RPC)
 * ---------------------------------------------------------------- */

const ELEMENT_SCHEMA = {
  type: "array",
  description: "Elements to draw, in scene coordinates (y grows downward).",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["rectangle", "ellipse", "diamond", "arrow", "line", "text"] },
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
      text: { type: "string", description: "Content for type=text" },
      label: { type: "string", description: "Optional centred label for shapes" },
      points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "For arrow/line: points relative to (x,y), first [0,0]" },
      strokeColor: { type: "string" },
      backgroundColor: { type: "string", description: "Fill colour, e.g. #a5d8ff" },
      fillStyle: { type: "string", enum: ["solid", "hachure", "cross-hatch", "zigzag"] },
      strokeWidth: { type: "number" },
      fontSize: { type: "number" },
      fontFamily: { type: "string", enum: ["hand", "normal", "code", "pretendard", "noto", "serif"] },
      textAlign: { type: "string", enum: ["left", "center", "right"] },
      angle: { type: "number", description: "Rotation in radians" },
    },
    required: ["type", "x", "y"],
  },
};

const TOOLS = [
  {
    name: "axdraw_create_drawing",
    description:
      "Create a hand-drawn style diagram on axdraw.org and return a share URL the user can open. " +
      "The scene is encrypted client-side; the server only stores ciphertext. " +
      "Use for flowcharts, mind maps, architecture sketches and quick visual explanations.",
    inputSchema: {
      type: "object",
      properties: {
        elements: ELEMENT_SCHEMA,
        background: { type: "string", description: "Canvas colour (default warm paper #faf7f2)" },
      },
      required: ["elements"],
    },
  },
  {
    name: "axdraw_draw_live",
    description:
      "Draw elements into a LIVE axdraw collaboration room so they appear on the user's canvas in real time. " +
      "The user must first start Live collaboration in axdraw and paste the #room=… link here.",
    inputSchema: {
      type: "object",
      properties: {
        room_url: { type: "string", description: "Full room URL containing #room=<id>,<key>" },
        elements: ELEMENT_SCHEMA,
      },
      required: ["room_url", "elements"],
    },
  },
];

const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const respondError = (id, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      respond(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "axdraw", version: "1.0.0" },
      });
    } else if (method === "tools/list") {
      respond(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      let text;
      if (name === "axdraw_create_drawing") text = await createDrawing(args);
      else if (name === "axdraw_draw_live") text = await drawLive(args);
      else throw new Error(`Unknown tool: ${name}`);
      respond(id, { content: [{ type: "text", text }] });
    } else if (method === "ping") {
      respond(id, {});
    } else if (id !== undefined) {
      respondError(id, `Unknown method: ${method}`);
    }
  } catch (error) {
    if (id !== undefined) respondError(id, error instanceof Error ? error.message : String(error));
  }
});
