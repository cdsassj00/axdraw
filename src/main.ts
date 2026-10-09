import "./style.css";
import { App } from "./app";
import { createUI } from "./ui";
import { watchForUpdates } from "./update";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from the page");

const app = new App(root);
createUI(app);

// Opened through a share link? Fetch and decrypt it into a canvas of its own.
// A #room=… link instead joins a live collaboration session.
// With neither, a canvas that belongs to a live room reconnects to it — the
// owner's tab comes back to the room the next day instead of a private copy.
if (location.hash.startsWith("#share=")) void app.loadFromShareLink();
else if (location.hash.startsWith("#room=")) void app.joinCollabFromHash();
else if (!location.hash.startsWith("#cloud=")) void app.resumeRoom();

// Cloud canvases: lists what other devices saved, uploads what is new here.
// A #cloud=… link (from "open on another device") adopts that workspace first.
const openedPlainly = !location.hash;
void app.startCloud().then(async () => {
  // A one-time sweep of the empty canvases and dead room links that piled up
  // while those bugs were live. Only on a plain visit: a link someone just
  // opened is never the moment to tidy around it.
  const CLEANUP_FLAG = "axdraw:cleanup-v1";
  try {
    if (!openedPlainly || localStorage.getItem(CLEANUP_FLAG)) return;
    const removed = await app.cleanupEmpty();
    localStorage.setItem(CLEANUP_FLAG, String(Date.now()));
    if (removed.canvases || removed.rooms) app.reportCleanup(removed);
  } catch {
    // Storage unavailable: nothing to tidy.
  }
});

// Pasting a link into a tab that already has axdraw open only changes the
// fragment, which is a same-document navigation: nothing reloads, so without
// this the paste appears to do nothing at all and the user sits in their own
// canvas wondering why they cannot see anyone.
window.addEventListener("hashchange", () => {
  void app.loadFromShareLink();
  void app.joinCollabFromHash();
});

watchForUpdates({ busy: () => app.isBusy(), beforeReload: () => app.saveNow() });

// Handy for debugging from the console.
(window as unknown as { axdraw: App }).axdraw = app;
