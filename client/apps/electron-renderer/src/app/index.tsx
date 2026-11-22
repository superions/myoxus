import "./setup";

import { DesktopPageRendererContext } from "@myoxus/core/editor/virgultum/doc-editor/page-renderer-context";
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
      <DesktopPageRendererContext value={true}>
        <App />
      </DesktopPageRendererContext>
    </StrictMode>,
  );
}

try {
  main();
} catch (err) {
  console.error("Failed to bootstrap app", err);
}
