// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

import { extractFile, listPackage, uncache } from "@electron/asar";
import type { Metafile } from "esbuild";

import type { ElectronTargetPlatform } from "./build-context";
import { materializeLinuxAppArmor } from "./packaging-config";

const runtimeNames = new Set([
  "helper.js",
  "helper.js.map",
  "main.js",
  "main.js.map",
  "preload.js",
  "preload.js.map",
]);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const nativeExternals = new Set([
  "./myoxus_crypto.node",
  "./myoxus_media.node",
]);
const packagedNativePattern =
  /^dist\/(?:myoxus_crypto|myoxus_media|myoxus_storage\.[a-z0-9_-]+)\.node$/;
const distNativePattern =
  /^(?:myoxus_crypto|myoxus_media|myoxus_storage\.[a-z0-9_-]+)\.node$/;
const stageManifestKeys = [
  "author",
  "description",
  "license",
  "main",
  "name",
  "private",
  "productName",
  "type",
  "version",
];
// Packager 20.3 removes publishing-only metadata from the copied runtime
// manifest. Keep `private` mandatory in the internal stage, but reject it and
// every other non-runtime field once the application is packaged.
const packagedManifestKeys = stageManifestKeys.filter(
  key => key !== "private",
);
const stageIconFiles = [
  "app-icon.icns",
  "app-icon.ico",
  "app-icon.png",
  "app-icon.svg",
  "dmg-background.png",
  "dmg-background@2x.png",
  "edgeless.png",
  "journal.png",
  "monitor.png",
  "nsis-sidebar.bmp",
  "page.png",
  "tray.png",
  "waveform-recording.png",
  "waveform.png",
];
const nativeIconNames = [
  "edgeless.png",
  "journal.png",
  "monitor.png",
  "page.png",
  "tray.png",
  "waveform-recording.png",
  "waveform.png",
];

export function normalizeAsarEntryPath(entry: string): string {
  // @electron/asar lists entries with the host separator although archive
  // lookups and Myoxus allowlists use portable relative paths.
  return entry.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function asarLookupPath(
  entry: string,
  separator: string = path.sep,
): string {
  // @electron/asar traverses nested archive paths with the host separator.
  return normalizeAsarEntryPath(entry).replaceAll("/", separator);
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Stage contains a symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) await visit(absolute);
      else files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

export function assertBundledRuntime(metafile: Metafile): void {
  const invalidExternal = Object.values(metafile.outputs).flatMap((output) =>
    output.imports
      .filter(
        (entry) =>
          entry.external &&
          entry.path !== "electron" &&
          !builtins.has(entry.path) &&
          !nativeExternals.has(entry.path) &&
          // Sentry probes for its optional Classic-IPC preload with
          // require.resolve. Myoxus uses Protocol IPC and initializes the
          // bundled preload itself, so this caught lookup is not a runtime
          // dependency. Keep the exception exact so a real JS external still
          // fails the build.
          !(
            entry.kind === "require-resolve" &&
            entry.path === "../../preload/default.js"
          ),
      )
      .map((entry) => `${entry.kind}:${entry.path}`),
  );
  if (invalidExternal.length) {
    throw new Error(
      `JavaScript runtime dependencies remained external: ${[...new Set(invalidExternal)].join(", ")}`,
    );
  }
}

export async function assertDistLayout(
  distDir: string,
  checkoutRoot: string,
): Promise<void> {
  const entries = await fs.readdir(distDir, { withFileTypes: true });
  const invalid = entries
    .filter(
      (entry) =>
        !entry.isFile() ||
        (!runtimeNames.has(entry.name) && !distNativePattern.test(entry.name)),
    )
    .map((entry) => entry.name);
  if (invalid.length) {
    throw new Error(`Unexpected Electron dist artifacts: ${invalid.join(", ")}`);
  }
  const nativeEntries = entries
    .map((entry) => entry.name)
    .filter((name) => distNativePattern.test(name));
  if (
    nativeEntries.length !== 3 ||
    !nativeEntries.includes("myoxus_crypto.node") ||
    !nativeEntries.includes("myoxus_media.node") ||
    nativeEntries.filter((name) => name.startsWith("myoxus_storage.")).length !==
      1
  ) {
    throw new Error(
      `Electron dist must contain exactly the three native bindings; got ${nativeEntries.join(", ")}`,
    );
  }
  for (const name of ["main.js", "preload.js", "helper.js"]) {
    const source = await fs.readFile(path.join(distDir, name), "utf8");
    if (source.includes("sourceMappingURL=") || source.includes(checkoutRoot)) {
      throw new Error(`${name} exposes a source map link or checkout path`);
    }
  }
}

export async function replaceDirectoryAtomically(
  prepared: string,
  target: string,
): Promise<void> {
  const previous = `${target}.previous-${process.pid}`;
  await fs.rm(previous, { recursive: true, force: true });
  try {
    await fs.rename(target, previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(prepared, target);
  } catch (error) {
    if (await fs.stat(previous).catch(() => undefined)) {
      await fs.rename(previous, target);
    }
    throw error;
  }
  await fs.rm(previous, { recursive: true, force: true });
}

export async function assertStageLayout(
  stageRoot: string,
  checkoutRoot: string,
): Promise<{ digest: string; files: string[] }> {
  const files = await walk(stageRoot);
  const relativeFiles = files.map((file) => path.relative(stageRoot, file));
  const invalid = relativeFiles.filter(
    (file) =>
      file
        .split(path.sep)
        .some((segment) => segment === "node_modules" || segment.startsWith(".")) ||
      file.endsWith(".map") ||
      path.basename(file).startsWith("forge.config."),
  );
  if (invalid.length) {
    throw new Error(`Forbidden stage artifacts: ${invalid.join(", ")}`);
  }
  const manifest = JSON.parse(
    await fs.readFile(path.join(stageRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(stageManifestKeys)) {
    throw new Error(`Stage manifest keys differ: ${keys.join(", ")}`);
  }

  for (const file of files.filter((candidate) => candidate.endsWith(".js"))) {
    const source = await fs.readFile(file, "utf8");
    if (source.includes("sourceMappingURL=") || source.includes(checkoutRoot)) {
      throw new Error(`${path.relative(stageRoot, file)} exposes source metadata`);
    }
  }
  await assertMediabunnyNotices(stageRoot, (file) => fs.readFile(file));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(stageRoot, file));
    hash.update(await fs.readFile(file));
  }
  return { digest: hash.digest("hex"), files: relativeFiles };
}

/** Derive expected resources from the renderer output, not the staged copy:
 * a copy filter must not silently drop a first-use chunk and certify itself. */
export async function writeRendererAssetInventory(
  source: string,
  target: string,
): Promise<void> {
  const files = (await walk(source))
    .map(file => path.relative(source, file).replaceAll(path.sep, "/"))
    .filter(file =>
      file !== "RUNTIME-ASSETS.json" &&
      !file.endsWith(".map") &&
      !file.split("/").some(segment => segment.startsWith(".")),
    );
  const inventory = JSON.stringify(files) + "\n";
  await fs.writeFile(path.join(target, "RUNTIME-ASSETS.json"), inventory);
  await assertRendererAssetInventory(inventory, file =>
    fs.readFile(path.join(target, file)),
  );
}

/** Validate every emitted resource, including async JS/CSS and worker assets.
 * Relative public names keep this build contract independent of checkout paths. */
async function assertRendererAssetInventory(
  inventory: string,
  read: (file: string) => Buffer | Promise<Buffer>,
): Promise<void> {
  const files: unknown = JSON.parse(inventory);
  if (
    !Array.isArray(files) ||
    !files.includes("index.html") ||
    new Set(files).size !== files.length ||
    files.some(file =>
      typeof file !== "string" ||
      !file ||
      file.includes("\\") ||
      path.posix.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      path.posix.normalize(file) !== file ||
      file.split("/").some(segment => segment.startsWith(".")),
    )
  ) throw new Error("Invalid renderer asset inventory");
  for (const file of files) {
    try {
      await read(file);
    } catch (cause) {
      throw new Error(`Missing renderer asset: ${file}`, { cause });
    }
  }
}

export function assertPackagedManifestKeys(
  manifest: Record<string, unknown>,
): void {
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(packagedManifestKeys)) {
    throw new Error(`Packaged manifest keys differ: ${keys.join(", ")}`);
  }
}

function assertPng(
  contents: Buffer,
  expectedWidth: number,
  expectedHeight: number,
  label: string,
  requireAlpha = true,
): void {
  if (
    contents.length < 33 ||
    !contents.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    contents.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error(`${label} is not a PNG with an IHDR chunk`);
  }
  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  const colorType = contents.readUInt8(25);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `${label} must be ${expectedWidth}x${expectedHeight}; got ${width}x${height}`,
    );
  }
  if (requireAlpha && colorType !== 4 && colorType !== 6) {
    throw new Error(`${label} must retain an alpha channel`);
  }
  if (!requireAlpha && ![2, 4, 6].includes(colorType)) {
    throw new Error(`${label} has an unsupported PNG color type ${colorType}`);
  }
}

function assertIco(contents: Buffer): void {
  if (
    contents.length < 6 ||
    contents.readUInt16LE(0) !== 0 ||
    contents.readUInt16LE(2) !== 1
  ) {
    throw new Error("app-icon.ico has an invalid ICO header");
  }
  const count = contents.readUInt16LE(4);
  const sizes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    if (offset + 16 > contents.length) {
      throw new Error("app-icon.ico has a truncated directory");
    }
    sizes.push(contents.readUInt8(offset) || 256);
  }
  const expected = [16, 32, 48, 64, 128, 256];
  if (JSON.stringify(sizes) !== JSON.stringify(expected)) {
    throw new Error(`app-icon.ico has invalid sizes: ${sizes.join(", ")}`);
  }
}

function assertIcns(contents: Buffer): void {
  if (
    contents.length < 8 ||
    contents.toString("ascii", 0, 4) !== "icns" ||
    contents.readUInt32BE(4) !== contents.length
  ) {
    throw new Error("app-icon.icns has an invalid ICNS header");
  }
  const types: string[] = [];
  let offset = 8;
  while (offset < contents.length) {
    if (offset + 8 > contents.length) {
      throw new Error("app-icon.icns has a truncated chunk header");
    }
    const length = contents.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > contents.length) {
      throw new Error("app-icon.icns has an invalid chunk length");
    }
    types.push(contents.toString("ascii", offset, offset + 4));
    offset += length;
  }
  const expected = ["icp4", "icp5", "icp6", "ic07", "ic08", "ic09", "ic10"];
  if (JSON.stringify(types) !== JSON.stringify(expected)) {
    throw new Error(`app-icon.icns has invalid size chunks: ${types.join(", ")}`);
  }
}

function assertNsisBmp(contents: Buffer): void {
  if (contents.length < 54 || contents.toString("ascii", 0, 2) !== "BM") {
    throw new Error("nsis-sidebar.bmp has an invalid BMP header");
  }
  const width = contents.readInt32LE(18);
  const height = Math.abs(contents.readInt32LE(22));
  const bitsPerPixel = contents.readUInt16LE(28);
  if (width !== 164 || height !== 314 || bitsPerPixel !== 24) {
    throw new Error(
      `nsis-sidebar.bmp must be 164x314 24-bit RGB; got ${width}x${height} ${bitsPerPixel}-bit`,
    );
  }
}

export async function assertStageIconLayout(stageRoot: string): Promise<void> {
  const iconsRoot = path.join(stageRoot, "resources", "icons");
  const entries = (await fs.readdir(iconsRoot, { withFileTypes: true })).map(
    entry => entry.name,
  );
  if (
    entries.some(name => name.startsWith(".")) ||
    JSON.stringify(entries.sort()) !== JSON.stringify(stageIconFiles)
  ) {
    throw new Error(
      `Stage icon inventory differs: expected ${stageIconFiles.join(", ")}; got ${entries.sort().join(", ")}`,
    );
  }
  const readIcon = (name: string) => fs.readFile(path.join(iconsRoot, name));
  assertPng(await readIcon("app-icon.png"), 512, 512, "app-icon.png");
  assertPng(
    await readIcon("dmg-background.png"),
    610,
    365,
    "dmg-background.png",
    false,
  );
  assertPng(
    await readIcon("dmg-background@2x.png"),
    1220,
    730,
    "dmg-background@2x.png",
    false,
  );
  for (const name of nativeIconNames) {
    assertPng(await readIcon(name), 64, 64, name);
  }
  assertIco(await readIcon("app-icon.ico"));
  assertIcns(await readIcon("app-icon.icns"));
  assertNsisBmp(await readIcon("nsis-sidebar.bmp"));
}

export async function assertPackagedLayout({
  checkoutRoot,
  packagedPath,
  productName,
  targetPlatform,
}: {
  checkoutRoot: string;
  packagedPath: string;
  productName: string;
  targetPlatform: ElectronTargetPlatform | "mas";
}): Promise<void> {
  const applePlatform = ["darwin", "mas"].includes(targetPlatform);
  const resourcesRoot = applePlatform
    ? path.join(packagedPath, `${productName}.app`, "Contents", "Resources")
    : path.join(packagedPath, "resources");
  if (targetPlatform === "linux") {
    const rootMode = (await fs.stat(packagedPath)).mode & 0o777;
    if (rootMode !== 0o755) {
      throw new Error(
        `Linux package root must be traversable by desktop users; got ${rootMode.toString(8)}`,
      );
    }
    const profile = await fs.readFile(path.join(resourcesRoot, "apparmor-profile"), "utf8");
    if (profile !== materializeLinuxAppArmor({ productName })) {
      throw new Error("Linux packaged AppArmor profile differs from its executable identity");
    }
  }
  const asarPath = path.join(resourcesRoot, "app.asar");
  // Packager may replace this path in the same process. Cached header offsets
  // describe the previous archive, not the bytes this gate is certifying.
  uncache(asarPath);
  const entries = listPackage(asarPath, { isPack: false }).map(
    normalizeAsarEntryPath,
  );
  const readAsarFile = (file: string): Buffer =>
    extractFile(asarPath, asarLookupPath(file));
  const forbidden = entries.filter(
    (entry) =>
      entry.endsWith(".map") ||
      entry
        .split("/")
        .some((segment) => segment === "node_modules" || segment.startsWith(".")),
  );
  if (forbidden.length) {
    throw new Error(`Forbidden packaged ASAR artifacts: ${forbidden.join(", ")}`);
  }
  await assertMediabunnyNotices("", async (file) =>
    readAsarFile(file).toString(),
  );

  const manifest = JSON.parse(readAsarFile("package.json").toString()) as Record<
    string,
    unknown
  >;
  assertPackagedManifestKeys(manifest);

  for (const entry of [
    "dist/main.js",
    "dist/preload.js",
    "dist/helper.js",
    "resources/web-static/index.html",
  ]) {
    if (!readAsarFile(entry).length) {
      throw new Error(`Packaged runtime resource is empty: ${entry}`);
    }
  }
  await assertRendererAssetInventory(
    readAsarFile("resources/web-static/RUNTIME-ASSETS.json").toString(),
    file => readAsarFile(`resources/web-static/${file}`),
  );

  const provenance = readAsarFile("BUILD-PROVENANCE.txt").toString();
  if (!/^buildType=(?:stable|beta|internal)\nplatform=(?:darwin|linux|win32)\narch=(?:arm64|x64)\nsource=[0-9a-f]{40}\nelectronE2e=(?:true|false)\n$/.test(provenance)) {
    throw new Error("Packaged build provenance is missing or invalid");
  }

  for (const entry of entries.filter((candidate) => candidate.endsWith(".js"))) {
    const source = readAsarFile(entry).toString();
    if (source.includes("sourceMappingURL=") || source.includes(checkoutRoot)) {
      throw new Error(`${entry} exposes source metadata in the packaged ASAR`);
    }
  }

  const unpackedRoot = path.join(resourcesRoot, "app.asar.unpacked");
  const unpacked = (await fs.stat(unpackedRoot).catch(() => undefined))
    ? (await walk(unpackedRoot)).map((entry) =>
        path.relative(unpackedRoot, entry).replaceAll(path.sep, "/"),
      )
    : [];
  if (
    unpacked.length !== 3 ||
    !unpacked.includes("dist/myoxus_crypto.node") ||
    !unpacked.includes("dist/myoxus_media.node") ||
    unpacked.filter(entry => /^dist\/myoxus_storage\.[a-z0-9_-]+\.node$/.test(entry)).length !== 1 ||
    unpacked.some((entry) => !packagedNativePattern.test(entry))
  ) {
    throw new Error(
      `Packaged unpacked tree must contain exactly the three native bindings; got ${unpacked.join(", ")}`,
    );
  }
}

async function assertMediabunnyNotices(
  root: string,
  read: (file: string) => Promise<Buffer | string>,
): Promise<void> {
  const noticePath = root
    ? path.join(root, "THIRD_PARTY_NOTICES.md")
    : "THIRD_PARTY_NOTICES.md";
  const licensePath = root
    ? path.join(root, "THIRD_PARTY_LICENSES", "mediabunny-MPL-2.0.txt")
    : "THIRD_PARTY_LICENSES/mediabunny-MPL-2.0.txt";
  const [notice, license] = await Promise.all([
    read(noticePath).then(String),
    read(licensePath).then(String),
  ]);
  if (
    !notice.includes("Mediabunny") ||
    !notice.includes("Version: 1.50.9") ||
    !notice.includes("License: MPL-2.0") ||
    !license.startsWith("Mozilla Public License Version 2.0")
  ) {
    throw new Error("Packaged Mediabunny provenance is missing or invalid");
  }
}
