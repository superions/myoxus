#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfigFromFile } from "vite";

const repoRoot = resolve(import.meta.dirname, "../../..");
// This inventory deliberately uses Vite's bundled loader for mixed CJS/ESM
// package roots. The flag suppresses only Vite's future native-loader notice;
// build warnings remain part of the consuming integration smoke.
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = "true";
const ignoredDirectories = new Set([
  ".git",
  ".yarn",
  "dist",
  "node_modules",
  "output",
  "target",
]);
const expectedBrowserConfigs = new Set([
  "virgultum/editor/blocks/bookmark/vitest.config.ts",
  "virgultum/editor/inlines/footnote/vitest.config.ts",
  "virgultum/editor/shared/vitest.config.ts",
  "virgultum/framework/std/vitest.config.ts",
  "virgultum/integration-test/vitest.config.ts",
]);
const expectedDecoratorConfigs = new Set([
  "client/admin/vitest.config.mts",
  "vitest.config.mts",
  ...expectedBrowserConfigs,
]);

function configFiles(directory = repoRoot, relativeDirectory = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : configFiles(resolve(directory, entry.name), relativePath);
    }
    return /^(?:vite|vitest)\.config\.[cm]?[jt]s$/.test(entry.name)
      ? [relativePath]
      : [];
  });
}

async function load(path, mode = "test") {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode },
    resolve(repoRoot, path),
  );
  if (!loaded) throw new Error(`could not load ${path}`);
  return loaded.config;
}

const findings = [];
const browserConfigs = new Set();
for (const path of configFiles().sort()) {
  const config = await load(path);
  if (config.esbuild?.target !== undefined) {
    findings.push(`${path} still configures esbuild.target`);
  }
  const decoratorTransform = config.plugins
    ?.flat()
    .find((plugin) => plugin?.name === "swc");
  if (expectedDecoratorConfigs.has(path) && !decoratorTransform) {
    findings.push(`${path} lost the bounded decorator transform`);
  } else if (
    expectedDecoratorConfigs.has(path) &&
    decoratorTransform?.enforce !== "pre"
  ) {
    findings.push(`${path} must lower decorators before Vite's Oxc transform`);
  }
  const decoratorCodeFilter = decoratorTransform?.transform?.filter?.code;
  if (expectedDecoratorConfigs.has(path)) {
    if (!(decoratorCodeFilter instanceof RegExp)) {
      findings.push(`${path} must use a syntax-aware decorator filter`);
    } else {
      decoratorCodeFilter.lastIndex = 0;
      const matchesDecorator = decoratorCodeFilter.test(
        "class Example {\n  @property()\n  value = true;\n}",
      );
      decoratorCodeFilter.lastIndex = 0;
      const matchesAutoAccessor = decoratorCodeFilter.test(
        "class Example {\n  private accessor value = true;\n}",
      );
      decoratorCodeFilter.lastIndex = 0;
      const matchesScopedImport = decoratorCodeFilter.test(
        'import { Select } from "@myoxus/ui-facade";',
      );
      if (!matchesDecorator || !matchesAutoAccessor || matchesScopedImport) {
        findings.push(
          `${path} transform filter must accept decorators and auto-accessors while rejecting scoped imports`,
        );
      }
    }
  }
  if (
    expectedDecoratorConfigs.has(path) &&
    config.oxc?.jsx?.runtime !== "automatic"
  ) {
    findings.push(`${path} must preserve the automatic JSX runtime`);
  }
  if (!config.test?.browser?.enabled) continue;

  browserConfigs.add(path);
  const browser = config.test.browser;
  const instances = browser.instances?.map((instance) => instance.browser);
  if (browser.provider?.name !== "playwright") {
    findings.push(`${path} does not use the Playwright provider factory`);
  }
  if (JSON.stringify(instances) !== JSON.stringify(["chromium", "firefox"])) {
    findings.push(`${path} must execute Chromium and Firefox instances`);
  }
  if (browser.headless !== true) {
    findings.push(`${path} must keep browser gates headless`);
  }
}

for (const path of expectedBrowserConfigs) {
  if (!browserConfigs.has(path))
    findings.push(`missing browser config ${path}`);
}
for (const path of browserConfigs) {
  if (!expectedBrowserConfigs.has(path)) {
    findings.push(`unowned browser config ${path}`);
  }
}

const integrationTest = await load(
  "virgultum/integration-test/vitest.config.ts",
);
if (
  integrationTest.optimizeDeps?.rolldownOptions?.transform?.target !== "es2022"
) {
  findings.push("integration Vitest dependency transforms must target ES2022");
}
if (integrationTest.optimizeDeps?.esbuildOptions !== undefined) {
  findings.push("integration Vitest still uses optimizeDeps.esbuildOptions");
}
if (integrationTest.test?.deps?.interopDefault !== true) {
  findings.push("integration Vitest lost deps.interopDefault");
}
if (integrationTest.test?.testTransformMode !== undefined) {
  findings.push("integration Vitest still uses removed testTransformMode");
}
if (
  integrationTest.test?.fileParallelism !== false ||
  integrationTest.test?.isolate !== false
) {
  findings.push(
    "integration Vitest must serialize files in its established shared browser session",
  );
}

const rootVitest = await load("vitest.config.mts");
if (Object.hasOwn(rootVitest.test?.coverage ?? {}, "all")) {
  findings.push("root Vitest coverage must use Vitest 4 loaded-file semantics");
}

const electronVitest = await load("client/apps/electron/vitest.config.mts");
if (
  electronVitest.test?.maxWorkers !== 1 ||
  electronVitest.test?.isolate !== false
) {
  findings.push("Electron Vitest must use one non-isolated worker");
}
if (electronVitest.test?.poolOptions !== undefined) {
  findings.push("Electron Vitest still uses removed poolOptions.singleFork");
}

const integrationVite = await load(
  "virgultum/integration-test/vite.config.ts",
  "production",
);
if (integrationVite.oxc?.target !== "es2022") {
  findings.push("integration Vite Oxc target must remain ES2022");
}
if (
  integrationVite.build?.target !== "es2022" ||
  integrationVite.build?.sourcemap !== true ||
  integrationVite.build?.rolldownOptions?.treeshake !== true
) {
  findings.push(
    "integration Vite lost build target, sourcemap or tree-shaking",
  );
}
if (integrationVite.build?.rollupOptions !== undefined) {
  findings.push("integration Vite still uses build.rollupOptions");
}
const pluginNames = new Set(
  integrationVite.plugins?.flat().map((plugin) => plugin?.name),
);
for (const name of ["swc", "myoxus-api-fonts", "vite-plugin-wasm"]) {
  if (!pluginNames.has(name)) findings.push(`integration Vite lost ${name}`);
}
const warningHandler = integrationVite.build?.rolldownOptions?.onwarn;
if (typeof warningHandler !== "function") {
  findings.push("integration Vite lost its build warning filter");
} else {
  let forwarded = 0;
  warningHandler({ code: "EVAL" }, () => {
    forwarded += 1;
  });
  warningHandler({ code: "UNRESOLVED_IMPORT" }, () => {
    forwarded += 1;
  });
  if (forwarded !== 1) {
    findings.push("integration Vite warning filter changed behavior");
  }
}

if (findings.length) {
  findings.forEach((finding) => console.error(`toolchain-config: ${finding}`));
  process.exit(1);
}
console.log(
  `Vite/Vitest 4 config contract verified (${browserConfigs.size} browser configs).`,
);
