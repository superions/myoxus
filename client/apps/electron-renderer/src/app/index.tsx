import "./setup";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

function main() {
  mountApp();
}

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
  main();
} catch (err) {
  console.error("Failed to bootstrap app", err);
}
