import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { createDecoratorTransform } from "../../build/scripts/test/vite-decorator-transform.mjs";

export default defineConfig((_configEnv) =>
  defineConfig({
    plugins: [createDecoratorTransform()],
    oxc: {
      jsx: { runtime: "automatic" },
      target: "es2022",
    },
    optimizeDeps: {
      force: true,
      rolldownOptions: {
        transform: {
          // Keep top-level await available in browser fixtures and workers.
          target: "es2022",
        },
      },
    },
    test: {
      // Integration fixtures expose one editor and document on `window`.
      // Preserve the established single-session model while serializing files;
      // each test creates and cleans up its own editor and workspace fixture.
      fileParallelism: false,
      isolate: false,
      include: ["src/__tests__/**/*.spec.ts"],
      retry: process.env.CI === "true" ? 3 : 0,
      browser: {
        enabled: true,
        headless: true,
        instances: [{ browser: "chromium" }, { browser: "firefox" }],
        provider: playwright(),
        viewport: {
          width: 1024,
          height: 768,
        },
      },
      coverage: {
        provider: "istanbul", // or 'c8'
        reporter: ["lcov"],
        reportsDirectory: "../../.coverage/integration-test",
      },
      deps: {
        interopDefault: true,
      },
    },
  }),
);
