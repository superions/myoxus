import { defineConfig } from "vitest/config";

import { createDecoratorTransform } from "../../../../build/scripts/test/vite-decorator-transform.mjs";

export default defineConfig({
  plugins: [createDecoratorTransform()],
  root: import.meta.dirname,
  oxc: {
    jsx: { runtime: "automatic" },
    target: "es2018",
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
