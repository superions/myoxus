import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { createDecoratorTransform } from "../../build/scripts/test/vite-decorator-transform.mjs";

export default defineConfig({
  plugins: [createDecoratorTransform()],
  // Avoid a mid-run browser reload when the registered block renderer is first imported.
  optimizeDeps: { include: ["lit/directives/guard.js"] },
  oxc: {
    jsx: { runtime: "automatic" },
    target: "es2018",
  },
  test: {
    browser: {
      enabled: true,
      headless: true,
      viewport: { width: 1280, height: 800 },
      instances: [{ browser: "chromium" }, { browser: "firefox" }],
      provider: playwright(),
      isolate: false,
    },
    include: ["src/inlines/footnote/__tests__/**/*.unit.spec.ts"],
    testTimeout: 500,
    coverage: {
      provider: "istanbul",
      reporter: ["lcov"],
      reportsDirectory: "../../.coverage/footnote",
    },
    restoreMocks: true,
  },
});
