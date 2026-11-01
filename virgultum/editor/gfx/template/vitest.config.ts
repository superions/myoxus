import { defineConfig } from "vitest/config";

export default defineConfig({
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
      reportsDirectory: "../../../.coverage/myoxus-gfx-template",
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
