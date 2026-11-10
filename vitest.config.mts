import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { createDecoratorTransform } from "./build/scripts/test/vite-decorator-transform.mjs";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [createDecoratorTransform()],
  oxc: {
    jsx: { runtime: "automatic" },
  },
  assetsInclude: ["**/*.md", "**/*.zip"],
  server: {
    watch: {
      // Exclude large directories that are not test sources to avoid hitting inotify limits
      ignored: [
        "**/target/**",
        "**/.git/**",
        "**/virgultum/**",
        "**/packages/**",
      ],
    },
  },
  resolve: {
    alias: {
      // prevent tests using two different sources of yjs
      yjs: resolve(rootDir, "node_modules/yjs"),
      "@myoxus/core": fileURLToPath(
        new URL("./client/libs/core/src", import.meta.url),
      ),
      "@myoxus/ui-facade/provider": fileURLToPath(
        new URL("./client/libs/ui-facade/src/provider.tsx", import.meta.url),
      ),
      "@myoxus/ui-facade/mobile-shell": fileURLToPath(
        new URL("./client/libs/ui-facade/src/mobile-shell.ts", import.meta.url),
      ),
      "@myoxus/ui-facade": fileURLToPath(
        new URL("./client/libs/ui-facade/src/index.tsx", import.meta.url),
      ),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "frontend-unit",
          include: [
            "{client/libs,client/apps,client/admin/workspaces/admin,client/web/workspaces/web,client/branding}/**/*.spec.{ts,tsx}",
            "virgultum/editor/widgets/**/*.unit.spec.ts",
            "virgultum/editor/all/src/__tests__/frontmatter.unit.spec.ts",
          ],
          exclude: [
            "**/node_modules",
            "**/dist",
            "**/build",
            "**/out",
            "**/client/apps/electron",
            // Project-local excludes own collection in Vitest's multi-project
            // setup; CLI excludes alone do not remove these Mobile UI owners.
            "client/libs/ui-facade/src/mobile-*.spec.tsx",
            "client/libs/core/src/mobile/**",
            "client/libs/core/src/components/mobile/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "virgultum-annotations",
          include: [
            "virgultum/editor/all/src/__tests__/annotation-model.unit.spec.ts",
            "virgultum/editor/all/src/__tests__/callout-model.unit.spec.ts",
            "virgultum/editor/all/src/__tests__/document-embed-model.unit.spec.ts",
            "virgultum/editor/all/src/__tests__/footnote-model.unit.spec.ts",
            "virgultum/editor/shared/src/__tests__/adapters/middlewares/document-reference.unit.spec.ts",
            "virgultum/editor/shared/src/__tests__/utils/document-field.unit.spec.ts",
            "virgultum/editor/inlines/footnote/src/__tests__/adapters/preprocessor.unit.spec.ts",
            "virgultum/editor/inlines/footnote/src/__tests__/citation-preview-session.unit.spec.ts",
            "virgultum/editor/fragments/outline/src/__tests__/document-outline-controller.unit.spec.ts",
            "virgultum/editor/blocks/bookmark/src/__tests__/adapters/preprocessor.unit.spec.ts",
            "virgultum/editor/blocks/image/src/__tests__/page-image.unit.spec.ts",
            "virgultum/editor/all/src/extensions/__tests__/manifest-consistency.unit.spec.ts",
          ],
          environment: "happy-dom",
        },
      },
      {
        extends: true,
        test: {
          name: "virgultum-markdown",
          include: [
            "virgultum/editor/all/src/__tests__/adapters/markdown.unit.spec.ts",
            "virgultum/editor/all/src/__tests__/adapters/html.unit.spec.ts",
          ],
          environment: "happy-dom",
          testNamePattern:
            /(?:line-break semantics stabilize across repeated and cross-writer roundtrips|full-document imports consume only their matching title heading|block anchor provenance survives native import, model edits and both writer passes|a matching title with an explicit anchor remains an ordinary editable heading|precise references resolve only current authorized native targets|client Markdown imports retain forward and local native navigation targets|footnote|table)/,
        },
      },
      "./client/apps/electron/vitest.config.mts",
    ],
    environmentOptions: {
      happyDOM: {
        settings: {
          // Unit tests assert DOM contract and loader behaviour; stylesheet
          // contents are covered by static file tests. Real CSS fetches from
          // Happy-DOM would make green tests noisy and environment-dependent.
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    setupFiles: [
      resolve(rootDir, "./build/scripts/test/setup/polyfill.ts"),
      resolve(rootDir, "./build/scripts/test/setup/lit.ts"),
      resolve(rootDir, "./build/scripts/test/setup/vi-mock.ts"),
      resolve(rootDir, "./build/scripts/test/setup/global.ts"),
    ],
    testTimeout: 5000,
    coverage: {
      provider: "istanbul", // or 'c8'
      reporter: ["lcov"],
      reportsDirectory: resolve(rootDir, ".coverage/store"),
    },
  },
});
