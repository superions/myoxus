import { defineConfig } from "vitest/config";
import { createDecoratorTransform } from "../../build/scripts/test/vite-decorator-transform.mjs";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [createDecoratorTransform()],
  oxc: {
    target: "es2018",
  },
  test: {
    globalSetup: "../scripts/vitest-global.js",
    projects: [
      {
        extends: true,
        test: {
          name: "canvas-group",
          include: ["src/gfx/group/__tests__/**/*.unit.spec.ts"],
          testTimeout: 1000,
        },
      },
      {
        extends: true,
        test: {
          name: "canvas-shape",
          include: ["src/gfx/shape/__tests__/**/*.unit.spec.ts"],
          testTimeout: 2000,
        },
      },
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["lcov"],
      reportsDirectory: "../../.coverage/myoxus-canvas",
    },
    onConsoleLog(log, type) {
      if (log.includes("lit.dev/msg/dev-mode")) {
        return false;
      }
      console.warn(`Unexpected ${type} log`, log);
      throw new Error(log);
    },
    environment: "happy-dom",
    environmentOptions: { happyDOM: { width: 1280, height: 800 } },
  },
});
