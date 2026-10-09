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
// The automatic one-time sweep of empty canvases is off: it removed
// canvases that earlier bugs had already emptied, together with their cloud
// copies, and with them any chance of recovering what was there.
void app.startCloud();

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
