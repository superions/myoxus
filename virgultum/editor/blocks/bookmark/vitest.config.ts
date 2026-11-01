import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { createDecoratorTransform } from "../../../../build/scripts/test/vite-decorator-transform.mjs";

export default defineConfig({
  plugins: [createDecoratorTransform()],
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
    include: ["src/__tests__/**/*.unit.spec.ts"],
    testTimeout: 500,
    coverage: {
      provider: "istanbul",
      reporter: ["lcov"],
      reportsDirectory: "../../../.coverage/bookmark",
    },
    restoreMocks: true,
  },
});
