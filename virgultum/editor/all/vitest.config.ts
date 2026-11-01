import { defineConfig } from "vitest/config";
import { createDecoratorTransform } from "../../../build/scripts/test/vite-decorator-transform.mjs";

export default defineConfig({
  plugins: [createDecoratorTransform()],
  oxc: {
    target: "es2018",
  },
  test: {
    globalSetup: "../../scripts/vitest-global.js",
    include: [
      "src/__tests__/**/*.unit.spec.ts",
      "src/**/__tests__/**/*.unit.spec.ts",
    ],
    testTimeout: 1000,
    coverage: {
      provider: "istanbul", // or 'c8'
      reporter: ["lcov"],
      reportsDirectory: "../../../.coverage/virgultum-affine",
    },
    /**
     * Custom handler for console.log in tests.
     *
     * Return `false` to ignore the log.
     */
    onConsoleLog(log, type) {
      if (
        log.includes("lit.dev/msg/dev-mode") ||
        log.includes(
          `KaTeX doesn't work in quirks mode. Make sure your website has a suitable doctype.`,
        )
      ) {
        return false;
      }
      console.warn(`Unexpected ${type} log`, log);
      throw new Error(log);
    },
    environment: "happy-dom",
  },
});
