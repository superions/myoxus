import { defineConfig } from "vitest/config";
import { createDecoratorTransform } from "../../../../build/scripts/test/vite-decorator-transform.mjs";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [createDecoratorTransform()],
  oxc: {
    target: "es2018",
  },
  test: {
    globalSetup: "../../../scripts/vitest-global.js",
    include: ["src/__tests__/**/*.unit.spec.ts"],
    testTimeout: 2000,
    coverage: {
      provider: "istanbul",
      reporter: ["lcov"],
      reportsDirectory: "../../../.coverage/myoxus-gfx-shape",
    },
    onConsoleLog(log, type) {
      if (log.includes("lit.dev/msg/dev-mode")) {
        return false;
      }
      console.warn(`Unexpected ${type} log`, log);
      throw new Error(log);
    },
    environment: "happy-dom",
  },
});
