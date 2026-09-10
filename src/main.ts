import "./style.css";
import { App } from "./app";
import { createUI } from "./ui";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from the page");

const app = new App(root);
createUI(app);

// Opened through a share link? Fetch and decrypt it over the autosaved scene.
// A #room=… link instead joins a live collaboration session.
void app.loadFromShareLink();
void app.joinCollabFromHash();

// Pasting a link into a tab that already has axdraw open only changes the
// fragment, which is a same-document navigation: nothing reloads, so without
// this the paste appears to do nothing at all and the user sits in their own
// canvas wondering why they cannot see anyone.
window.addEventListener("hashchange", () => {
  void app.loadFromShareLink();
  void app.joinCollabFromHash();
});

// Handy for debugging from the console.
(window as unknown as { axdraw: App }).axdraw = app;
