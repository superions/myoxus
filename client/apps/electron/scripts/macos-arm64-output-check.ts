import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBuildContext } from "./lib/build-context";
import { runProcessCapture } from "./lib/process";

const context = createBuildContext();
const { arch, buildType, productName } = context;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const electronRoot = path.resolve(__dirname, "..");
const appPath =
  process.env.MYOXUS_MACOS_APP ||
  path.join(
    electronRoot,
    "out",
    buildType,
    `${productName}-darwin-${arch}`,
    `${productName}.app`,
  );
const contentsPath = path.join(appPath, "Contents");
const resourcesPath = path.join(contentsPath, "Resources");
const infoPlistPath = path.join(contentsPath, "Info.plist");
const executablePath = path.join(contentsPath, "MacOS", productName);
const asarPath = path.join(resourcesPath, "app.asar");
const asarUnpackedPath = path.join(resourcesPath, "app.asar.unpacked");
const clientFontAssetsScript = path.join(
  electronRoot,
  "..",
  "..",
  "..",
  "build",
  "scripts",
  "fonts",
  "client-font-assets.mjs",
);
const dmgPath =
  process.env.MYOXUS_MACOS_DMG ||
  path.join(electronRoot, "out", buildType, "make", `${productName}.dmg`);

function assertExists(candidatePath: string, label: string) {
  if (!fs.existsSync(candidatePath)) {
    throw new Error(`${label} is missing at ${candidatePath}`);
  }
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await runProcessCapture({
    command,
    args,
    cwd: electronRoot,
  });
  return stdout.trim();
}

function listFilesDeep(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listFilesDeep(resolved);
    }
    return [resolved];
  });
}

assertExists(appPath, "macOS app bundle");
assertExists(infoPlistPath, "Info.plist");
assertExists(executablePath, "main executable");
assertExists(asarPath, "app.asar");
assertExists(asarUnpackedPath, "app.asar.unpacked");

const plist = JSON.parse(
  await run("plutil", ["-convert", "json", "-o", "-", infoPlistPath]),
);
const expectedBundleId = context.appId;
if (plist.CFBundleIdentifier !== expectedBundleId) {
  throw new Error(
    `Unexpected bundle id ${plist.CFBundleIdentifier}; expected ${expectedBundleId}`,
  );
}

const urlSchemes =
  plist.CFBundleURLTypes?.flatMap(
    (urlType: { CFBundleURLSchemes?: string[] }) =>
      urlType.CFBundleURLSchemes ?? [],
  ) ?? [];
if (!urlSchemes.includes(productName.toLowerCase())) {
  throw new Error(
    `Missing URL scheme ${productName.toLowerCase()} in Info.plist`,
  );
}

const nativeFiles = new Set(
  listFilesDeep(asarUnpackedPath).map((file) => path.basename(file)),
);
const requiredNativeFiles = [
  "myoxus_crypto.node",
  "myoxus_media.node",
  `myoxus_storage.darwin-${arch}.node`,
];
for (const nativeFile of requiredNativeFiles) {
  if (!nativeFiles.has(nativeFile)) {
    throw new Error(`Missing packaged native binding ${nativeFile}`);
  }
}

await run(process.execPath, [
  clientFontAssetsScript,
  "verify-asar",
  "--asar",
  asarPath,
  "--asar-root",
  "resources/web-static",
]);

if (process.platform === "darwin") {
  await run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);

  if (fs.existsSync(dmgPath)) {
    await run("hdiutil", ["verify", dmgPath]);
  }
}

console.log("Output check passed");
