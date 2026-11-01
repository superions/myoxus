import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { createDecoratorTransform } from "../../build/scripts/test/vite-decorator-transform.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  plugins: [createDecoratorTransform()],
  oxc: {
    jsx: { runtime: "automatic" },
  },
  assetsInclude: ["**/*.md", "**/*.zip"],
  resolve: {
    alias: {
      yjs: resolve(repoRoot, "node_modules/yjs"),
      "@myoxus/core": resolve(repoRoot, "client/libs/core/src"),
      "@myoxus/graphql": resolve(repoRoot, "client/libs/graphql/src/index.ts"),
      "@myoxus/icons/catalog": resolve(
        repoRoot,
        "client/libs/icons/src/catalog.ts",
      ),
      "@myoxus/icons/keywords/en": resolve(
        repoRoot,
        "client/libs/icons/src/keywords/en.ts",
      ),
      "@myoxus/icons/lit": resolve(repoRoot, "client/libs/icons/src/lit.ts"),
      "@myoxus/icons/names": resolve(
        repoRoot,
        "client/libs/icons/src/names.ts",
      ),
      "@myoxus/icons/assets": resolve(
        repoRoot,
        "client/libs/icons/src/assets/index.ts",
      ),
      "@myoxus/icons/react": resolve(
        repoRoot,
        "client/libs/icons/src/react.ts",
      ),
      "@myoxus/icons": resolve(repoRoot, "client/libs/icons/src/index.ts"),
      "@myoxus/routes": resolve(repoRoot, "client/libs/routes/src/index.ts"),
      "@myoxus/debug": resolve(repoRoot, "client/libs/debug/src/index.ts"),
      "@myoxus/error": resolve(repoRoot, "client/libs/error/src/index.ts"),
      "@myoxus/theme/client.css": resolve(
        repoRoot,
        "client/libs/theme/src/client.css",
      ),
      "@myoxus/theme/fonts.css": resolve(
        repoRoot,
        "client/libs/theme/src/fonts.css",
      ),
    },
  },
  test: {
    environmentOptions: {
      happyDOM: {
        settings: {
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    setupFiles: [
      resolve(repoRoot, "build/scripts/test/setup/polyfill.ts"),
      resolve(repoRoot, "build/scripts/test/setup/lit.ts"),
      resolve(repoRoot, "build/scripts/test/setup/vi-mock.ts"),
      resolve(repoRoot, "build/scripts/test/setup/global.ts"),
    ],
    include: [
      resolve(repoRoot, "client/admin/workspaces/admin/src/**/*.spec.{ts,tsx}"),
    ],
    exclude: ["**/node_modules", "**/dist", "**/build", "**/out"],
    testTimeout: 5000,
  },
});
