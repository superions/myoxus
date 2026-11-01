#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Platform derivatives are generated from reviewable Myoxus-owned SVG sources.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "../../..");
const manifestPath = path.join(
  packageDir,
  "src/assets/generated/manifest.json",
);
const generatorPath = "@myoxus/icons/scripts/build-assets.mjs";
const license = "AGPL-3.0-or-later";
const channels = new Set(["stable", "beta", "internal", "shared"]);
const formats = new Set(["svg", "png", "ico", "icns", "bmp"]);
const appChannels = new Set(["stable", "beta", "internal"]);
const svgHeader = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->",
];

function rel(...parts) {
  return path.join(...parts).replaceAll(path.sep, "/");
}

const sourceDefinitions = [
  ["app-beta", rel("client/libs/icons/src/assets/platform/app-beta.svg")],
  [
    "app-internal",
    rel("client/libs/icons/src/assets/platform/app-internal.svg"),
  ],
  ["app-stable", rel("client/libs/icons/src/assets/platform/app-stable.svg")],
  [
    "browser-favicon",
    rel("client/libs/icons/src/assets/platform/browser-favicon.svg"),
  ],
  ["dmg-background", rel("client/branding/artwork/installer-dmg.svg")],
  ["edgeless", rel("client/libs/icons/src/assets/native/edgeless.svg")],
  ["journal", rel("client/libs/icons/src/assets/native/journal.svg")],
  ["monitor", rel("client/libs/icons/src/assets/native/monitor.svg")],
  ["nsis-sidebar", rel("client/branding/artwork/installer-nsis.svg")],
  ["page", rel("client/libs/icons/src/assets/native/page.svg")],
  ["tray", rel("client/libs/icons/src/assets/native/tray.svg")],
  ["waveform", rel("client/libs/icons/src/assets/native/waveform.svg")],
  [
    "waveform-recording",
    rel("client/libs/icons/src/assets/native/waveform-recording.svg"),
  ],
].map(([id, sourcePath]) => ({ id, path: sourcePath }));

const workspaceFaviconRoot = "client/libs/core/public";
const stageIconRoot = "resources/icons";
const recipes = [];

function addRecipe({
  id,
  source,
  format,
  sizes,
  channel,
  consumers,
  output,
  scope,
}) {
  recipes.push({
    id,
    source,
    format,
    sizes,
    channel,
    consumers: [...consumers].sort(),
    output,
    scope,
  });
}

for (const size of [32, 36, 48, 72, 96, 144, 192]) {
  addRecipe({
    id: `browser-favicon-${size}`,
    source: "browser-favicon",
    format: "png",
    sizes: [`${size}x${size}`],
    channel: "shared",
    consumers: ["browser.web-favicon"],
    output: rel(workspaceFaviconRoot, `favicon-${size}.png`),
    scope: "workspace",
  });
}
addRecipe({
  id: "browser-apple-touch-icon",
  source: "browser-favicon",
  format: "png",
  sizes: ["180x180"],
  channel: "shared",
  consumers: ["browser.apple-touch-icon"],
  output: rel(workspaceFaviconRoot, "apple-touch-icon.png"),
  scope: "workspace",
});
addRecipe({
  id: "browser-favicon-ico",
  source: "browser-favicon",
  format: "ico",
  sizes: ["16x16", "32x32", "48x48"],
  channel: "shared",
  consumers: ["browser.web-favicon"],
  output: rel(workspaceFaviconRoot, "favicon.ico"),
  scope: "workspace",
});

for (const channel of ["stable", "beta", "internal"]) {
  const source = `app-${channel}`;
  addRecipe({
    id: `electron-app-${channel}-svg`,
    source,
    format: "svg",
    sizes: [],
    channel,
    consumers: ["electron.linux-package-metadata"],
    output: rel(stageIconRoot, "app-icon.svg"),
    scope: "electron",
  });
  addRecipe({
    id: `electron-app-${channel}-png`,
    source,
    format: "png",
    sizes: ["512x512"],
    channel,
    consumers: ["electron.browser-window", "electron.native-image"],
    output: rel(stageIconRoot, "app-icon.png"),
    scope: "electron",
  });
  addRecipe({
    id: `electron-app-${channel}-ico`,
    source,
    format: "ico",
    sizes: ["16x16", "32x32", "48x48", "64x64", "128x128", "256x256"],
    channel,
    consumers: [
      "electron.file-association.windows",
      "electron.nsis",
      "electron.packager.windows",
    ],
    output: rel(stageIconRoot, "app-icon.ico"),
    scope: "electron",
  });
  addRecipe({
    id: `electron-app-${channel}-icns`,
    source,
    format: "icns",
    sizes: [
      "16x16",
      "32x32",
      "64x64",
      "128x128",
      "256x256",
      "512x512",
      "1024x1024",
    ],
    channel,
    consumers: ["electron.dmg", "electron.packager.macos"],
    output: rel(stageIconRoot, "app-icon.icns"),
    scope: "electron",
  });
}

for (const [source, output, consumer] of [
  ["tray", "tray.png", "electron.native-image.tray"],
  ["journal", "journal.png", "electron.native-image.journal"],
  ["page", "page.png", "electron.native-image.page"],
  ["edgeless", "edgeless.png", "electron.native-image.edgeless"],
  ["monitor", "monitor.png", "electron.native-image.monitor"],
  ["waveform", "waveform.png", "electron.native-image.waveform"],
  [
    "waveform-recording",
    "waveform-recording.png",
    "electron.native-image.waveform-recording",
  ],
]) {
  addRecipe({
    id: `electron-native-${source}`,
    source,
    format: "png",
    sizes: ["64x64"],
    channel: "shared",
    consumers: [consumer],
    output: rel(stageIconRoot, output),
    scope: "electron",
  });
}

for (const [id, size, output] of [
  ["electron-dmg-background", "610x365", "dmg-background.png"],
  ["electron-dmg-background-2x", "1220x730", "dmg-background@2x.png"],
]) {
  addRecipe({
    id,
    source: "dmg-background",
    format: "png",
    sizes: [size],
    channel: "shared",
    consumers: ["electron.forge-dmg"],
    output: rel(stageIconRoot, output),
    scope: "electron",
  });
}
addRecipe({
  id: "electron-nsis-sidebar",
  source: "nsis-sidebar",
  format: "bmp",
  sizes: ["164x314"],
  channel: "shared",
  consumers: ["electron.builder-nsis"],
  output: rel(stageIconRoot, "nsis-sidebar.bmp"),
  scope: "electron",
});
recipes.sort((a, b) => a.id.localeCompare(b.id));

function parseArguments(argv) {
  const result = {
    check: false,
    selfCheck: false,
    stageRoot: null,
    channel: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      result.check = true;
    } else if (argument === "--self-check") {
      result.selfCheck = true;
    } else if (argument === "--stage-root" || argument === "--channel") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--stage-root") result.stageRoot = value;
      else result.channel = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const modeCount =
    Number(result.check) +
    Number(result.selfCheck) +
    Number(!!result.stageRoot);
  if (modeCount > 1) {
    throw new Error("--check, --self-check, and --stage-root are exclusive");
  }
  if (!!result.stageRoot !== !!result.channel) {
    throw new Error("--stage-root and --channel must be provided together");
  }
  if (result.channel && !appChannels.has(result.channel)) {
    throw new Error(
      `--channel must be stable, beta, or internal; got ${result.channel}`,
    );
  }
  return result;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function writeIfChanged(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (
    fs.existsSync(file) &&
    Buffer.compare(fs.readFileSync(file), data) === 0
  ) {
    return;
  }
  fs.writeFileSync(file, data);
}

function isRelativeCanonicalPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function parseSize(value) {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`Invalid output size: ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function compareSizes(left, right) {
  const a = parseSize(left);
  const b = parseSize(right);
  return a.width - b.width || a.height - b.height;
}

function isSorted(values, compare = (a, b) => a.localeCompare(b)) {
  return values.every(
    (value, index) => index === 0 || compare(values[index - 1], value) <= 0,
  );
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `${label} fields must be exactly ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
}

function loadSources() {
  const result = new Map();
  const hashes = new Set();
  for (const definition of sourceDefinitions) {
    const absolute = path.join(repoRoot, definition.path);
    if (!fs.existsSync(absolute)) {
      throw new Error(`${definition.path}: source is missing`);
    }
    const buffer = fs.readFileSync(absolute);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (lines[0] !== svgHeader[0] || lines[1] !== svgHeader[1]) {
      throw new Error(
        `${definition.path}: XML declaration and SPDX header must be lines 1 and 2`,
      );
    }
    if (/<(?:image|text)\b|font-family\s*=/.test(buffer.toString("utf8"))) {
      throw new Error(
        `${definition.path}: embedded rasters and host-font text are forbidden`,
      );
    }
    const hash = sha256(buffer);
    if (hashes.has(hash)) {
      throw new Error(`${definition.path}: duplicates another SVG source`);
    }
    hashes.add(hash);
    result.set(definition.id, {
      ...definition,
      absolute,
      buffer,
      markup: buffer
        .toString("utf8")
        .replace(`${svgHeader[0]}\n${svgHeader[1]}\n`, ""),
      sha256: hash,
    });
  }
  return result;
}

function publicRecipe(recipe) {
  return {
    id: recipe.id,
    source: recipe.source,
    format: recipe.format,
    sizes: recipe.sizes,
    channel: recipe.channel,
    consumers: recipe.consumers,
  };
}

function manifestFor(sources, outputBuffers) {
  const manifestSources = [...sources.values()]
    .map(({ id, path: sourcePath, sha256: sourceHash }) => ({
      id,
      path: sourcePath,
      sha256: sourceHash,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const manifestRecipes = recipes.map(publicRecipe);
  const outputs = recipes
    .map((recipe) => ({
      recipe: recipe.id,
      path: recipe.output,
      sha256: sha256(outputBuffers.get(recipe.id)),
    }))
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.recipe.localeCompare(b.recipe),
    );
  return {
    generator: generatorPath,
    license,
    sources: manifestSources,
    recipes: manifestRecipes,
    outputs,
  };
}

function validateManifest(manifest, expected) {
  assertExactKeys(
    manifest,
    ["generator", "license", "sources", "recipes", "outputs"],
    "manifest",
  );
  if (manifest.generator !== generatorPath) {
    throw new Error(`manifest.generator must be ${generatorPath}`);
  }
  if (manifest.license !== license) {
    throw new Error(`manifest.license must be ${license}`);
  }
  if (
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.recipes) ||
    !Array.isArray(manifest.outputs)
  ) {
    throw new Error("manifest sources, recipes, and outputs must be arrays");
  }

  const sourceIds = new Set();
  for (const [index, source] of manifest.sources.entries()) {
    assertExactKeys(source, ["id", "path", "sha256"], `sources[${index}]`);
    if (typeof source.id !== "string" || sourceIds.has(source.id)) {
      throw new Error(`sources[${index}].id must be unique`);
    }
    sourceIds.add(source.id);
    if (!isRelativeCanonicalPath(source.path)) {
      throw new Error(`sources[${index}].path must be workspace-relative`);
    }
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new Error(`sources[${index}].sha256 is invalid`);
    }
  }
  if (!isSorted(manifest.sources.map((source) => source.id))) {
    throw new Error("sources must be sorted by id");
  }

  const recipeIds = new Set();
  for (const [index, recipe] of manifest.recipes.entries()) {
    assertExactKeys(
      recipe,
      ["id", "source", "format", "sizes", "channel", "consumers"],
      `recipes[${index}]`,
    );
    if (typeof recipe.id !== "string" || recipeIds.has(recipe.id)) {
      throw new Error(`recipes[${index}].id must be unique`);
    }
    recipeIds.add(recipe.id);
    if (!sourceIds.has(recipe.source)) {
      throw new Error(`recipes[${index}].source is unknown`);
    }
    if (!formats.has(recipe.format)) {
      throw new Error(`recipes[${index}].format is invalid`);
    }
    if (!channels.has(recipe.channel)) {
      throw new Error(`recipes[${index}].channel is invalid`);
    }
    if (!Array.isArray(recipe.sizes)) {
      throw new Error(`recipes[${index}].sizes must be an array`);
    }
    for (const size of recipe.sizes) parseSize(size);
    if (
      !isSorted(recipe.sizes, compareSizes) ||
      new Set(recipe.sizes).size !== recipe.sizes.length
    ) {
      throw new Error(`recipes[${index}].sizes must be sorted and unique`);
    }
    if (recipe.format === "svg" && recipe.sizes.length !== 0) {
      throw new Error(`recipes[${index}].sizes must be empty for SVG`);
    }
    if (recipe.format !== "svg" && recipe.sizes.length === 0) {
      throw new Error(`recipes[${index}].sizes must not be empty`);
    }
    if (
      !Array.isArray(recipe.consumers) ||
      recipe.consumers.length === 0 ||
      recipe.consumers.some(
        (consumer) => typeof consumer !== "string" || !consumer,
      ) ||
      !isSorted(recipe.consumers) ||
      new Set(recipe.consumers).size !== recipe.consumers.length
    ) {
      throw new Error(
        `recipes[${index}].consumers must be a sorted non-empty unique list`,
      );
    }
  }
  if (!isSorted(manifest.recipes.map((recipe) => recipe.id))) {
    throw new Error("recipes must be sorted by id");
  }

  const outputRecipes = new Set();
  const outputKeys = new Set();
  for (const [index, output] of manifest.outputs.entries()) {
    assertExactKeys(output, ["recipe", "path", "sha256"], `outputs[${index}]`);
    if (!recipeIds.has(output.recipe)) {
      throw new Error(`outputs[${index}].recipe is unknown`);
    }
    if (outputRecipes.has(output.recipe)) {
      throw new Error(`recipe ${output.recipe} has more than one output`);
    }
    outputRecipes.add(output.recipe);
    if (!isRelativeCanonicalPath(output.path)) {
      throw new Error(`outputs[${index}].path must be relative`);
    }
    const recipe = manifest.recipes.find((item) => item.id === output.recipe);
    const outputKey = `${recipe.channel}:${output.path}`;
    if (outputKeys.has(outputKey)) {
      throw new Error(
        `outputs[${index}].path duplicates another output in its channel`,
      );
    }
    outputKeys.add(outputKey);
    if (!/^[a-f0-9]{64}$/.test(output.sha256)) {
      throw new Error(`outputs[${index}].sha256 is invalid`);
    }
  }
  const sortedOutputs = [...manifest.outputs].sort(
    (a, b) => a.path.localeCompare(b.path) || a.recipe.localeCompare(b.recipe),
  );
  if (
    manifest.outputs.some(
      (output, index) =>
        output.path !== sortedOutputs[index].path ||
        output.recipe !== sortedOutputs[index].recipe,
    )
  ) {
    throw new Error("outputs must be sorted by path and then recipe");
  }
  if (outputRecipes.size !== recipeIds.size) {
    throw new Error("every recipe must have exactly one output");
  }
  if (expected && JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error("manifest source, recipe, output, or hash drift detected");
  }
}

function writeUInt16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function writeUInt32BE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function makeIco(images) {
  let offset = 6 + images.length * 16;
  const entries = images.map((image) => {
    const dimension = image.size >= 256 ? 0 : image.size;
    const entry = Buffer.concat([
      Buffer.from([dimension, dimension, 0, 0]),
      writeUInt16LE(1),
      writeUInt16LE(32),
      writeUInt32LE(image.buffer.length),
      writeUInt32LE(offset),
    ]);
    offset += image.buffer.length;
    return entry;
  });
  return Buffer.concat([
    writeUInt16LE(0),
    writeUInt16LE(1),
    writeUInt16LE(images.length),
    ...entries,
    ...images.map((image) => image.buffer),
  ]);
}

const icnsTypes = new Map([
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"],
]);
const icnsSizes = new Map([...icnsTypes].map(([size, type]) => [type, size]));

function makeIcns(images) {
  const chunks = images.map((image) => {
    const type = icnsTypes.get(image.size);
    if (!type) throw new Error(`Unsupported ICNS size ${image.size}`);
    return Buffer.concat([
      Buffer.from(type),
      writeUInt32BE(image.buffer.length + 8),
      image.buffer,
    ]);
  });
  const length = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return Buffer.concat([Buffer.from("icns"), writeUInt32BE(length), ...chunks]);
}

function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.subarray(0, 8).compare(signature) !== 0) {
    throw new Error("Invalid PNG signature");
  }
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const compressed = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (
    !width ||
    !height ||
    bitDepth !== 8 ||
    ![2, 6].includes(colorType) ||
    interlace !== 0
  ) {
    throw new Error("PNG must be non-interlaced 8-bit RGB or RGBA");
  }
  const channelsPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * channelsPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(compressed));
  if (inflated.length !== (stride + 1) * height) {
    throw new Error("PNG scanline length is invalid");
  }
  const raw = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)];
    const sourceOffset = y * (stride + 1) + 1;
    const targetOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[sourceOffset + x];
      const left =
        x >= channelsPerPixel ? raw[targetOffset + x - channelsPerPixel] : 0;
      const up = y > 0 ? raw[targetOffset + x - stride] : 0;
      const upperLeft =
        y > 0 && x >= channelsPerPixel
          ? raw[targetOffset + x - stride - channelsPerPixel]
          : 0;
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) decoded = value + paeth(left, up, upperLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
      raw[targetOffset + x] = decoded & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const sourceOffset = index * channelsPerPixel;
    const targetOffset = index * 4;
    rgba[targetOffset] = raw[sourceOffset];
    rgba[targetOffset + 1] = raw[sourceOffset + 1];
    rgba[targetOffset + 2] = raw[sourceOffset + 2];
    rgba[targetOffset + 3] =
      channelsPerPixel === 4 ? raw[sourceOffset + 3] : 255;
  }
  return { width, height, rgba };
}

function makeBmp(pngBuffer) {
  const { width, height, rgba } = decodePng(pngBuffer);
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] !== 255) {
      throw new Error("BMP source must be fully opaque");
    }
  }
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowStride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 4;
      const targetOffset = (height - 1 - y) * rowStride + x * 3;
      pixels[targetOffset] = rgba[sourceOffset + 2];
      pixels[targetOffset + 1] = rgba[sourceOffset + 1];
      pixels[targetOffset + 2] = rgba[sourceOffset];
    }
  }
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(header.length + pixels.length, 2);
  header.writeUInt32LE(header.length, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

function inspectIco(buffer, expectedSizes) {
  if (
    buffer.readUInt16LE(0) !== 0 ||
    buffer.readUInt16LE(2) !== 1 ||
    buffer.readUInt16LE(4) !== expectedSizes.length
  ) {
    throw new Error("ICO header or image count is invalid");
  }
  const actual = [];
  for (let index = 0; index < expectedSizes.length; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    if (width !== height || buffer.readUInt16LE(offset + 12) <= 0) {
      throw new Error("ICO entry is invalid");
    }
    actual.push(width);
  }
  if (actual.some((size, index) => size !== expectedSizes[index])) {
    throw new Error("ICO size set is invalid");
  }
}

function inspectIcns(buffer, expectedSizes) {
  if (
    buffer.toString("ascii", 0, 4) !== "icns" ||
    buffer.readUInt32BE(4) !== buffer.length
  ) {
    throw new Error("ICNS header is invalid");
  }
  const actual = [];
  let offset = 8;
  while (offset < buffer.length) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (!icnsSizes.has(type) || length < 8 || offset + length > buffer.length) {
      throw new Error("ICNS chunk is invalid");
    }
    actual.push(icnsSizes.get(type));
    offset += length;
  }
  if (
    offset !== buffer.length ||
    actual.length !== expectedSizes.length ||
    actual.some((size, index) => size !== expectedSizes[index])
  ) {
    throw new Error("ICNS size set is invalid");
  }
}

function inspectBmp(buffer, expectedWidth, expectedHeight) {
  if (
    buffer.toString("ascii", 0, 2) !== "BM" ||
    buffer.readUInt32LE(14) !== 40 ||
    buffer.readInt32LE(18) !== expectedWidth ||
    buffer.readInt32LE(22) !== expectedHeight ||
    buffer.readUInt16LE(26) !== 1 ||
    buffer.readUInt16LE(28) !== 24 ||
    buffer.readUInt32LE(30) !== 0
  ) {
    throw new Error("BMP must be exact-size uncompressed 24-bit RGB");
  }
}

function validateRenderedOutput(recipe, buffer) {
  const dimensions = recipe.sizes.map(parseSize);
  if (recipe.format === "svg") {
    if (
      buffer.toString("utf8").split(/\r?\n/)[0] !== svgHeader[0] ||
      buffer.toString("utf8").split(/\r?\n/)[1] !== svgHeader[1]
    ) {
      throw new Error(`${recipe.id}: staged SVG lost its XML/SPDX header`);
    }
  } else if (recipe.format === "png") {
    const png = decodePng(buffer);
    if (
      png.width !== dimensions[0].width ||
      png.height !== dimensions[0].height
    ) {
      throw new Error(`${recipe.id}: PNG dimensions are invalid`);
    }
    const shouldBeOpaque = recipe.source === "dmg-background";
    const hasTransparency = png.rgba.some(
      (value, index) => index % 4 === 3 && value < 255,
    );
    if (shouldBeOpaque === hasTransparency) {
      throw new Error(
        `${recipe.id}: PNG transparency does not match its source contract`,
      );
    }
  } else if (recipe.format === "ico") {
    inspectIco(
      buffer,
      dimensions.map(({ width }) => width),
    );
  } else if (recipe.format === "icns") {
    inspectIcns(
      buffer,
      dimensions.map(({ width }) => width),
    );
  } else if (recipe.format === "bmp") {
    inspectBmp(buffer, dimensions[0].width, dimensions[0].height);
  }
}

function pinnedPlaywrightContract() {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const pin = rootPackage.devDependencies?.["@playwright/test"];
  if (typeof pin !== "string" || !/^=\d+\.\d+\.\d+$/.test(pin)) {
    throw new Error("@playwright/test must be exactly pinned in package.json");
  }
  const resolvedPackage = JSON.parse(
    fs.readFileSync(require.resolve("@playwright/test/package.json"), "utf8"),
  );
  if (`=${resolvedPackage.version}` !== pin) {
    throw new Error(
      `Resolved @playwright/test ${resolvedPackage.version} differs from ${pin}`,
    );
  }
  return { version: resolvedPackage.version };
}

function assertChromiumExecutable(executable) {
  if (!executable || !fs.existsSync(executable)) {
    throw new Error(
      "Pinned Playwright Chromium is missing; run the workspace Playwright browser install",
    );
  }
}

async function createRenderer() {
  const contract = pinnedPlaywrightContract();
  const { chromium } = await import("@playwright/test");
  const executable = chromium.executablePath();
  assertChromiumExecutable(executable);
  const browser = await chromium.launch({ headless: true });
  return {
    browser,
    version: contract.version,
    async png(source, width, height) {
      const page = await browser.newPage({
        deviceScaleFactor: 1,
        viewport: { width, height },
      });
      try {
        await page.setContent(
          `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent">${source.markup.replace(
            "<svg ",
            `<svg style="display:block;width:${width}px;height:${height}px" `,
          )}</body></html>`,
          { waitUntil: "load" },
        );
        return await page.locator("svg").screenshot({
          animations: "disabled",
          caret: "hide",
          omitBackground: true,
          scale: "css",
        });
      } finally {
        await page.close();
      }
    },
  };
}

async function renderOutputs(selectedRecipes, sources) {
  const renderer = await createRenderer();
  const pngCache = new Map();
  async function pngFor(sourceId, width, height) {
    const key = `${sourceId}:${width}x${height}`;
    if (!pngCache.has(key)) {
      pngCache.set(
        key,
        renderer.png(sources.get(sourceId), width, height).then((buffer) => {
          const png = decodePng(buffer);
          if (png.width !== width || png.height !== height) {
            throw new Error(`${key}: renderer emitted unexpected dimensions`);
          }
          return buffer;
        }),
      );
    }
    return pngCache.get(key);
  }
  const outputBuffers = new Map();
  try {
    for (const recipe of selectedRecipes) {
      const dimensions = recipe.sizes.map(parseSize);
      let buffer;
      if (recipe.format === "svg") {
        buffer = sources.get(recipe.source).buffer;
      } else if (recipe.format === "png") {
        buffer = await pngFor(
          recipe.source,
          dimensions[0].width,
          dimensions[0].height,
        );
      } else if (recipe.format === "ico") {
        buffer = makeIco(
          await Promise.all(
            dimensions.map(async ({ width, height }) => ({
              size: width,
              buffer: await pngFor(recipe.source, width, height),
            })),
          ),
        );
      } else if (recipe.format === "icns") {
        buffer = makeIcns(
          await Promise.all(
            dimensions.map(async ({ width, height }) => ({
              size: width,
              buffer: await pngFor(recipe.source, width, height),
            })),
          ),
        );
      } else if (recipe.format === "bmp") {
        buffer = makeBmp(
          await pngFor(
            recipe.source,
            dimensions[0].width,
            dimensions[0].height,
          ),
        );
      } else {
        throw new Error(`${recipe.id}: unsupported format ${recipe.format}`);
      }
      validateRenderedOutput(recipe, buffer);
      outputBuffers.set(recipe.id, buffer);
    }
  } finally {
    await renderer.browser.close();
  }
  return outputBuffers;
}

function verifyGeneratedDirectory() {
  const generatedDirectory = path.dirname(manifestPath);
  const entries = fs
    .readdirSync(generatedDirectory, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  if (entries.length !== 1 || entries[0] !== "manifest.json") {
    throw new Error(
      "src/assets/generated must contain only generated/manifest.json",
    );
  }
}

function verifyWorkspaceOutputs(outputBuffers) {
  for (const recipe of recipes.filter((item) => item.scope === "workspace")) {
    const absolute = path.join(repoRoot, recipe.output);
    if (!fs.existsSync(absolute)) {
      throw new Error(`${recipe.output}: generated browser asset is missing`);
    }
    if (
      sha256(fs.readFileSync(absolute)) !== sha256(outputBuffers.get(recipe.id))
    ) {
      throw new Error(
        `${recipe.output}: generated browser asset hash mismatch`,
      );
    }
  }
}

async function checkAssets(sources) {
  verifyGeneratedDirectory();
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Platform asset manifest is missing");
  }
  const outputBuffers = await renderOutputs(recipes, sources);
  const expected = manifestFor(sources, outputBuffers);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateManifest(manifest, expected);
  verifyWorkspaceOutputs(outputBuffers);
  process.stdout.write(
    `Platform assets match the unversioned manifest using pinned Playwright Chromium.\n`,
  );
}

async function generateAssets(sources) {
  verifyGeneratedDirectory();
  const outputBuffers = await renderOutputs(recipes, sources);
  for (const recipe of recipes.filter((item) => item.scope === "workspace")) {
    writeIfChanged(
      path.join(repoRoot, recipe.output),
      outputBuffers.get(recipe.id),
    );
  }
  const manifest = manifestFor(sources, outputBuffers);
  validateManifest(manifest, manifest);
  writeIfChanged(
    manifestPath,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  process.stdout.write(
    `Generated ${manifest.outputs.length} manifest-owned assets with pinned Playwright Chromium.\n`,
  );
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function materializeStage(stageRootArgument, channel, sources) {
  const stageRoot = path.resolve(repoRoot, stageRootArgument);
  const iconRoot = path.join(stageRoot, "resources", "icons");
  if (isInside(packageDir, iconRoot)) {
    throw new Error("Stage output must not be inside @myoxus/icons");
  }
  const selectedRecipes = recipes.filter(
    (recipe) =>
      recipe.scope === "electron" &&
      (recipe.channel === "shared" || recipe.channel === channel),
  );
  const outputBuffers = await renderOutputs(selectedRecipes, sources);
  fs.rmSync(iconRoot, { recursive: true, force: true });
  fs.mkdirSync(iconRoot, { recursive: true });
  for (const recipe of selectedRecipes) {
    const relativeOutput = recipe.output.slice(`${stageIconRoot}/`.length);
    writeIfChanged(
      path.join(iconRoot, relativeOutput),
      outputBuffers.get(recipe.id),
    );
  }
  process.stdout.write(
    `Materialized ${selectedRecipes.length} ${channel} Electron assets under ${iconRoot}.\n`,
  );
}

function assertFixtureRejects(label, operation) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`Negative fixture did not fail: ${label}`);
}

function runSelfChecks(sources) {
  const fakeOutputs = new Map(
    recipes.map((recipe) => [recipe.id, Buffer.from(recipe.id)]),
  );
  const valid = manifestFor(sources, fakeOutputs);
  validateManifest(valid, valid);
  const mutate = (operation) => {
    const fixture = structuredClone(valid);
    operation(fixture);
    return fixture;
  };
  for (const [label, fixture] of [
    ["unknown field", mutate((value) => (value.extra = true))],
    ["version field", mutate((value) => (value.version = 1))],
    ["schemaVersion field", mutate((value) => (value.schemaVersion = 1))],
    ["manifestVersion field", mutate((value) => (value.manifestVersion = 1))],
    [
      "absolute source path",
      mutate((value) => (value.sources[0].path = "/tmp/source.svg")),
    ],
    [
      "missing source",
      mutate((value) => {
        value.sources.shift();
      }),
    ],
    [
      "source drift",
      mutate((value) => {
        value.sources[0].sha256 = "0".repeat(64);
      }),
    ],
    [
      "unsorted sources",
      mutate((value) => {
        value.sources.reverse();
      }),
    ],
    [
      "recipe without consumers",
      mutate((value) => {
        value.recipes[0].consumers = [];
      }),
    ],
    [
      "duplicate recipe output",
      mutate((value) => {
        value.outputs.push({ ...value.outputs[0] });
      }),
    ],
    [
      "unsorted outputs",
      mutate((value) => {
        value.outputs.reverse();
      }),
    ],
  ]) {
    assertFixtureRejects(label, () => validateManifest(fixture, valid));
  }
  assertFixtureRejects("missing pinned Chromium", () =>
    assertChromiumExecutable(
      path.join(os.tmpdir(), "myoxus-missing-playwright-chromium"),
    ),
  );
  const rgbaPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+5vK3WQAAAABJRU5ErkJggg==",
    "base64",
  );
  assertFixtureRejects("BMP alpha", () => makeBmp(rgbaPng));
  const validBmp = Buffer.alloc(54);
  validBmp.write("BM", 0, "ascii");
  validBmp.writeUInt32LE(40, 14);
  validBmp.writeInt32LE(164, 18);
  validBmp.writeInt32LE(314, 22);
  validBmp.writeUInt16LE(1, 26);
  validBmp.writeUInt16LE(32, 28);
  assertFixtureRejects("32-bit BMP", () => inspectBmp(validBmp, 164, 314));
  const incompleteIco = makeIco(
    [16, 32].map((size) => ({ size, buffer: Buffer.from([size]) })),
  );
  assertFixtureRejects("missing ICO size", () =>
    inspectIco(incompleteIco, [16, 32, 48]),
  );
  const incompleteIcns = makeIcns(
    [16, 32].map((size) => ({ size, buffer: Buffer.from([size]) })),
  );
  assertFixtureRejects("missing ICNS size", () =>
    inspectIcns(incompleteIcns, [16, 32, 64]),
  );
  process.stdout.write("Asset generator negative fixtures passed.\n");
}

const options = parseArguments(process.argv.slice(2));
const sources = loadSources();
if (options.selfCheck) {
  runSelfChecks(sources);
} else if (options.check) {
  await checkAssets(sources);
} else if (options.stageRoot) {
  await materializeStage(options.stageRoot, options.channel, sources);
} else {
  await generateAssets(sources);
}
