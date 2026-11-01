import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: resolve(rootDir, "client/apps/electron"),
  resolve: {
    alias: {
      // prevent tests using two different sources of yjs
      yjs: resolve(rootDir, "node_modules/yjs"),
      "@myoxus/electron": resolve(rootDir, "client/apps/electron/src"),
    },
  },

  test: {
    name: "electron",
    setupFiles: [resolve(rootDir, "./build/scripts/test/setup/global.ts")],
    include: ["./test/**/*.spec.ts", "./src/**/*.spec.ts"],
    testTimeout: 5000,
    // The local-store addon is part of the Electron test contract. The
    // electron.vitest matrix suite builds its host binding before Vitest.
    maxWorkers: 1,
    isolate: false,
    coverage: {
      provider: "istanbul", // or 'c8'
      reporter: ["lcov"],
      reportsDirectory: resolve(rootDir, ".coverage/electron"),
    },
  },
});
