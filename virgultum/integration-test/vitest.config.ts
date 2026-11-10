import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { createDecoratorTransform } from "../../build/scripts/test/vite-decorator-transform.mjs";
import { getBuildConfig } from "../../tools/utils/src/build-config";
import { Workspace } from "../../tools/utils/src/workspace";

export default defineConfig((_configEnv) =>
  defineConfig({
    // Editor dependencies consume the same build flags as the Vite harness.
    define: {
      BUILD_CONFIG: JSON.stringify({
        ...getBuildConfig(new Workspace().getPackage("@myoxus/web"), {
          mode: "development",
          channel: "stable",
        }),
        debug: false,
      }),
    },
    plugins: [createDecoratorTransform()],
    oxc: {
      jsx: { runtime: "automatic" },
      target: "es2022",
    },
    optimizeDeps: {
      // Per-file processes share this graph; Vite invalidates it when its inputs change.
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
