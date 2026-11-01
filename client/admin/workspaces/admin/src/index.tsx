/**
 * Application entry point for the Myoxus admin frontend.
 *
 * Bootstraps React by mounting the root `App` component into the `#app` DOM
 * node. Global CSS and the Sentry/environment setup shim are imported here so
 * they are guaranteed to be loaded before any component code runs.
 */
import "@myoxus/ui-facade/admin-app.css";
import "./setup";

import { createRoot } from "react-dom/client";

import { App } from "./app";

const appRoot = document.getElementById("app");

if (!appRoot) {
  throw new Error("Admin frontend root element #app is missing");
}

createRoot(appRoot).render(<App />);
