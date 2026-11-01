/**
 * Application entry point for the Myoxus web frontend.
 *
 * Runs global setup (browser bootstrap, theme) via the side-effectful
 * `./setup` import, then mounts the React application into the `#app` DOM
 * element. Any bootstrap errors are caught and logged so that the failure is
 * visible in the browser console rather than producing a silent blank page.
 */
import "./setup";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

/**
 * Creates the React root on the `#app` element and renders the application.
 *
 * Uses React 18 `createRoot` for concurrent-mode rendering and wraps the tree
 * in `<StrictMode>` to surface potential issues during development.
 */
function mountApp() {
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const root = document.getElementById("app")!;
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

try {
  mountApp();
} catch (err) {
  console.error("Failed to bootstrap app", err);
  // Surface the failure visibly so the user knows the page didn't load silently.
  document.body.innerHTML =
    '<div style="font-family:sans-serif;padding:2rem;color:#c1473c">' +
    "<h2>Application failed to load</h2>" +
    "<p>Please try reloading the page. If the problem persists, contact your administrator.</p>" +
    "</div>";
}
