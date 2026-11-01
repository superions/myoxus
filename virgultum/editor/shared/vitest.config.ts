import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { createDecoratorTransform } from "../../../build/scripts/test/vite-decorator-transform.mjs";

const vitestGlobalSetup = fileURLToPath(
  new URL("../../scripts/vitest-global.js", import.meta.url),
);

export default defineConfig({
  plugins: [createDecoratorTransform()],
  // The title renderer reaches these dependencies through its editor imports.
  // Prebundle them before the browser suite starts to prevent mid-test reloads.
  optimizeDeps: {
    include: [
      "lit/directives/class-map.js",
      "lit-html/directives/if-defined.js",
      "lit-html/directives/repeat.js",
      "lit/directives/cache.js",
      "lit/directives/join.js",
      "lit-html/directives/when.js",
      "lit/directives/keyed.js",
      "lit/directives/ref.js",
      "react",
      "react/jsx-runtime",
      "html2canvas",
      "lodash-es/chunk",
    ],
  },
  oxc: {
    jsx: { runtime: "automatic" },
    target: "es2018",
  },
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }, { browser: "firefox" }],
      provider: playwright(),
      isolate: false,
    },
    globalSetup: vitestGlobalSetup,
    // Cross-package renderer integration stays outside the published shared source graph.
    include: ["src/__tests__/**/*.unit.spec.ts", "tests/**/*.unit.spec.ts"],
    testTimeout: 1000,
    coverage: {
      provider: "istanbul", // or 'c8'
      reporter: ["lcov"],
      reportsDirectory: "../../../.coverage/myoxus-shared",
    },
    /**
     * Custom handler for console.log in tests.
     *
     * Return `false` to ignore the log.
     */
    onConsoleLog(log, type) {
      if (log.includes("https://lit.dev/msg/dev-mode")) {
        return false;
      }
      console.warn(`Unexpected ${type} log`, log);
      throw new Error(log);
    },
    restoreMocks: true,
  },
});
