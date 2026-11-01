// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const expectedPlatformSources = [
  "app-beta.svg",
  "app-internal.svg",
  "app-stable.svg",
  "browser-favicon.svg",
];
const expectedNativeSources = [
  "edgeless.svg",
  "journal.svg",
  "monitor.svg",
  "page.svg",
  "tray.svg",
  "waveform-recording.svg",
  "waveform.svg",
];
const sourceDirectories = {
  native: expectedNativeSources,
  platform: expectedPlatformSources,
};
const exactManifestKeys = [
  "generator",
  "license",
  "outputs",
  "recipes",
  "sources",
];
const exactSourceKeys = ["id", "path", "sha256"];
const exactRecipeKeys = [
  "channel",
  "consumers",
  "format",
  "id",
  "sizes",
  "source",
];
const exactOutputKeys = ["path", "recipe", "sha256"];
const allowedFormats = new Set(["bmp", "icns", "ico", "png", "svg"]);
const allowedChannels = new Set(["beta", "internal", "shared", "stable"]);
const sha256Pattern = /^[a-f0-9]{64}$/;

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function isCanonicalOrder(values, key) {
  const actual = values.map((value) => value[key]);
  return actual.every(
    (value, index) =>
      index === 0 || actual[index - 1].localeCompare(value) <= 0,
  );
}

function assertExactKeys(value, expected, label, failures) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${label} must be an object`);
    return false;
  }
  const actual = sortedKeys(value);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    failures.push(
      `${label} has invalid fields: expected ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
    return false;
  }
  return true;
}

function assertRelativePath(value, label, failures) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.split("/").includes("..") ||
    value.includes("\\")
  ) {
    failures.push(`${label} must be a canonical relative path`);
    return false;
  }
  return true;
}

function validateManifest(manifest, root, { verifyFiles = true } = {}) {
  const failures = [];
  if (!assertExactKeys(manifest, exactManifestKeys, "manifest", failures)) {
    return failures;
  }
  if (manifest.generator !== "@myoxus/icons/scripts/build-assets.mjs") {
    failures.push("manifest.generator is not the canonical generator path");
  }
  if (manifest.license !== "AGPL-3.0-or-later") {
    failures.push("manifest.license is not AGPL-3.0-or-later");
  }
  for (const field of ["sources", "recipes", "outputs"]) {
    if (!Array.isArray(manifest[field])) {
      failures.push(`manifest.${field} must be an array`);
    }
  }
  if (failures.length) return failures;

  if (!isCanonicalOrder(manifest.sources, "id")) {
    failures.push("manifest.sources is not sorted by id");
  }
  if (!isCanonicalOrder(manifest.recipes, "id")) {
    failures.push("manifest.recipes is not sorted by id");
  }
  if (
    manifest.outputs.some(
      (output, index) =>
        index > 0 &&
        (manifest.outputs[index - 1].path.localeCompare(output.path) > 0 ||
          (manifest.outputs[index - 1].path === output.path &&
            manifest.outputs[index - 1].recipe.localeCompare(output.recipe) >
              0)),
    )
  ) {
    failures.push("manifest.outputs is not sorted by path and recipe");
  }

  const sourceIds = new Set();
  for (const [index, source] of manifest.sources.entries()) {
    const label = `manifest.sources[${index}]`;
    if (!assertExactKeys(source, exactSourceKeys, label, failures)) continue;
    if (typeof source.id !== "string" || source.id.length === 0) {
      failures.push(`${label}.id must be non-empty`);
    } else if (sourceIds.has(source.id)) {
      failures.push(`${label}.id is duplicated`);
    } else {
      sourceIds.add(source.id);
    }
    if (!assertRelativePath(source.path, `${label}.path`, failures)) continue;
    if (!sha256Pattern.test(source.sha256)) {
      failures.push(`${label}.sha256 is invalid`);
    }
    if (verifyFiles) {
      const sourcePath = path.join(root, source.path);
      if (!fs.existsSync(sourcePath)) {
        failures.push(`${source.path}: source is missing`);
      } else if (sha256(fs.readFileSync(sourcePath)) !== source.sha256) {
        failures.push(`${source.path}: source hash mismatch`);
      }
    }
  }

  const recipeIds = new Set();
  const recipeChannels = new Map();
  for (const [index, recipe] of manifest.recipes.entries()) {
    const label = `manifest.recipes[${index}]`;
    if (!assertExactKeys(recipe, exactRecipeKeys, label, failures)) continue;
    if (typeof recipe.id !== "string" || recipe.id.length === 0) {
      failures.push(`${label}.id must be non-empty`);
    } else if (recipeIds.has(recipe.id)) {
      failures.push(`${label}.id is duplicated`);
    } else {
      recipeIds.add(recipe.id);
      recipeChannels.set(recipe.id, recipe.channel);
    }
    if (!sourceIds.has(recipe.source)) {
      failures.push(`${label}.source is unknown`);
    }
    if (!allowedFormats.has(recipe.format)) {
      failures.push(`${label}.format is invalid`);
    }
    if (!allowedChannels.has(recipe.channel)) {
      failures.push(`${label}.channel is invalid`);
    }
    if (
      !Array.isArray(recipe.sizes) ||
      !recipe.sizes.every((size) => /^\d+x\d+$/.test(size)) ||
      new Set(recipe.sizes).size !== recipe.sizes.length ||
      !recipe.sizes.every((size, sizeIndex) => {
        if (sizeIndex === 0) return true;
        const [previousWidth, previousHeight] = recipe.sizes[sizeIndex - 1]
          .split("x")
          .map(Number);
        const [width, height] = size.split("x").map(Number);
        return (
          previousWidth < width ||
          (previousWidth === width && previousHeight <= height)
        );
      }) ||
      (recipe.format === "svg"
        ? recipe.sizes.length !== 0
        : recipe.sizes.length === 0)
    ) {
      failures.push(`${label}.sizes is not canonical for ${recipe.format}`);
    }
    if (
      !Array.isArray(recipe.consumers) ||
      recipe.consumers.length === 0 ||
      new Set(recipe.consumers).size !== recipe.consumers.length ||
      !recipe.consumers.every(
        (consumer) => typeof consumer === "string" && consumer,
      ) ||
      !recipe.consumers.every(
        (consumer, consumerIndex) =>
          consumerIndex === 0 ||
          recipe.consumers[consumerIndex - 1].localeCompare(consumer) <= 0,
      )
    ) {
      failures.push(`${label}.consumers must be a non-empty sorted list`);
    }
  }

  const outputPaths = new Set();
  for (const [index, output] of manifest.outputs.entries()) {
    const label = `manifest.outputs[${index}]`;
    if (!assertExactKeys(output, exactOutputKeys, label, failures)) continue;
    if (!recipeIds.has(output.recipe)) {
      failures.push(`${label}.recipe is unknown`);
    }
    if (!assertRelativePath(output.path, `${label}.path`, failures)) continue;
    const outputKey = `${recipeChannels.get(output.recipe)}:${output.path}`;
    if (outputPaths.has(outputKey)) {
      failures.push(`${label}.path is duplicated within its channel`);
    } else {
      outputPaths.add(outputKey);
    }
    if (!sha256Pattern.test(output.sha256)) {
      failures.push(`${label}.sha256 is invalid`);
    }
  }
  return failures;
}

function validateSourceLayout(root) {
  const failures = [];
  const sourceRoot = path.join(root, "client/libs/icons/src/assets");
  for (const [directory, expected] of Object.entries(sourceDirectories)) {
    const absolute = path.join(sourceRoot, directory);
    const actual = fs.existsSync(absolute)
      ? fs
          .readdirSync(absolute)
          .filter((name) => !name.startsWith("."))
          .sort()
      : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `${relative(absolute)} must contain exactly ${expected.join(", ")}; got ${actual.join(", ")}`,
      );
    }
    for (const name of actual) {
      const file = path.join(absolute, name);
      const contents = fs.readFileSync(file, "utf8");
      const lines = contents.split(/\r?\n/);
      if (lines[0] !== '<?xml version="1.0" encoding="UTF-8"?>') {
        failures.push(`${relative(file)}: XML declaration must be line 1`);
      }
      if (lines[1] !== "<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->") {
        failures.push(`${relative(file)}: SPDX declaration must be line 2`);
      }
      if (contents.includes("<text")) {
        failures.push(
          `${relative(file)}: fixed artwork text must be outlined, not host-font rendered`,
        );
      }
    }
  }

  // Installer illustrations share the runtime artwork source, not the icon directory.
  for (const name of ["installer-dmg.svg", "installer-nsis.svg"]) {
    const file = path.join(root, "client/branding/artwork", name);
    if (!fs.existsSync(file)) {
      failures.push(`${relative(file)}: installer artwork is missing`);
      continue;
    }
    const contents = fs.readFileSync(file, "utf8");
    if (
      !contents.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->',
      )
    ) {
      failures.push(
        `${relative(file)}: XML and SPDX declarations are required`,
      );
    }
    if (/<(?:image|text|script|foreignObject)\b/i.test(contents)) {
      failures.push(
        `${relative(file)}: installer artwork must contain self-contained vector paths`,
      );
    }
  }

  const generated = path.join(sourceRoot, "generated");
  const generatedFiles = fs.existsSync(generated)
    ? fs
        .readdirSync(generated)
        .filter((name) => !name.startsWith("."))
        .sort()
    : [];
  if (JSON.stringify(generatedFiles) !== JSON.stringify(["manifest.json"])) {
    failures.push("generated asset directory must contain only manifest.json");
  }
  if (fs.existsSync(path.join(root, "client/apps/electron/resources/icons"))) {
    failures.push(
      "tracked Electron resources/icons source tree must not exist",
    );
  }
  return failures;
}

function validateRemovedAnchors(root) {
  const failures = [];
  const files = [
    "client/apps/electron/scripts/lib/application-packager.ts",
    "client/apps/electron/scripts/lib/build-context.ts",
    "client/apps/electron/scripts/lib/packaging-config.ts",
    "client/apps/electron/scripts/stage-package.ts",
    "client/apps/electron/scripts/packaging/desktop.ts",
    "client/apps/electron/scripts/packaging/linux.ts",
    "client/apps/electron/scripts/packaging/windows-nsis.ts",
    "client/apps/electron/src/main/windows-manager/main-window.ts",
    "client/apps/electron/src/main/tray/icons.ts",
  ];
  const forbidden = [
    /iconX64PngPath/,
    /iconX512PngPath/,
    /_64x64/,
    /_512x512/,
    /appCanary/,
    /myoxus_installing/,
    /(?:^|[/'"`])pause\.(?:png|svg)/m,
    /(?:^|[/'"`])stop\.(?:png|svg)/m,
    /maybePlaywrightBrowser/,
    /dockerRender/,
    /renderPngWithSips/,
  ];
  for (const name of files) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const contents = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(contents)) {
        failures.push(`${name}: forbidden resource anchor ${pattern}`);
      }
    }
  }
  const generator = fs.readFileSync(
    path.join(root, "client/libs/icons/scripts/build-assets.mjs"),
    "utf8",
  );
  for (const pattern of forbidden) {
    if (pattern.test(generator)) {
      failures.push(
        `client/libs/icons/scripts/build-assets.mjs: forbidden renderer or asset ${pattern}`,
      );
    }
  }
  return failures;
}

function createValidFixture(root) {
  const sourcePath = "client/libs/icons/src/assets/platform/app-stable.svg";
  const source = Buffer.from("fixture");
  fs.mkdirSync(path.join(root, path.dirname(sourcePath)), { recursive: true });
  fs.writeFileSync(path.join(root, sourcePath), source);
  return {
    generator: "@myoxus/icons/scripts/build-assets.mjs",
    license: "AGPL-3.0-or-later",
    sources: [{ id: "app-stable", path: sourcePath, sha256: sha256(source) }],
    recipes: [
      {
        id: "app-stable-runtime",
        source: "app-stable",
        format: "png",
        sizes: ["512x512"],
        channel: "stable",
        consumers: ["electron-runtime"],
      },
    ],
    outputs: [
      {
        recipe: "app-stable-runtime",
        path: "resources/icons/app-runtime.png",
        sha256: sha256("output"),
      },
    ],
  };
}

function runSelfTest() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "electron-resource-guard-"),
  );
  try {
    const valid = createValidFixture(root);
    if (validateManifest(valid, root).length !== 0) {
      throw new Error("valid resource-manifest fixture was rejected");
    }
    const cases = [
      { ...valid, version: 1 },
      { ...valid, sources: [{ ...valid.sources[0], path: "/absolute.svg" }] },
      { ...valid, recipes: [{ ...valid.recipes[0], consumers: [] }] },
      { ...valid, outputs: [...valid.outputs, { ...valid.outputs[0] }] },
      { ...valid, recipes: [{ ...valid.recipes[0], unknown: true }] },
    ];
    for (const [index, fixture] of cases.entries()) {
      if (validateManifest(fixture, root).length === 0) {
        throw new Error(
          `negative resource-manifest fixture ${index} was accepted`,
        );
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write("Electron resource guard negative fixtures passed.\n");
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const manifestPath = path.join(
  repoRoot,
  "client/libs/icons/src/assets/generated/manifest.json",
);
const failures = [
  ...validateSourceLayout(repoRoot),
  ...validateRemovedAnchors(repoRoot),
];
if (!fs.existsSync(manifestPath)) {
  failures.push(
    "client/libs/icons/src/assets/generated/manifest.json is missing",
  );
} else {
  try {
    failures.push(
      ...validateManifest(
        JSON.parse(fs.readFileSync(manifestPath, "utf8")),
        repoRoot,
      ),
    );
  } catch (error) {
    failures.push(`resource manifest is invalid JSON: ${error.message}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Electron resource verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  "Electron resources match the canonical SVG/recipe contract.\n",
);
