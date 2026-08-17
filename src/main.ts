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

// Handy for debugging from the console.
(window as unknown as { axdraw: App }).axdraw = app;
