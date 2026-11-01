import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Clipanion 3.2's ESM build contains an extensionless directory import;
    // the published CommonJS entry preserves the same API under Vitest.
    alias: {
      clipanion: fileURLToPath(
        new URL(
          "../../node_modules/clipanion/lib/advanced/index.js",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: ["src/**/*.spec.ts"],
  },
});
