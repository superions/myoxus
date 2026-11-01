// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createBuildContext,
  nativeBuildEnvironment,
  targetTripleFor,
} from "../../scripts/lib/build-context";
import {
  asarLookupPath,
  assertBundledRuntime,
  assertDistLayout,
  assertPackagedManifestKeys,
  assertPackagedLayout,
  assertStageIconLayout,
  assertStageLayout,
  normalizeAsarEntryPath,
  replaceDirectoryAtomically,
  writeRendererAssetInventory,
} from "../../scripts/lib/package-layout";
import {
  ensureLinuxPackageRootPermissions,
  trimElectronLocales,
} from "../../scripts/lib/package-postprocess";
import { runProcess, stopProcessTree } from "../../scripts/lib/process";
import { materializeLinuxAppArmor } from "../../scripts/lib/packaging-config";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "myoxus-package-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function stageFixture(): Promise<string> {
  const root = await temporaryDirectory();
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "dist", "main.js"),
    "module.exports = {};\n",
  );
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "myoxus-desktop",
        productName: "Myoxus",
        version: "0.40.0",
        main: "dist/main.js",
        private: true,
        description: "Myoxus Desktop App",
        author: "Myoxus Contributors",
        license: "AGPL-3.0-or-later",
        type: "commonjs",
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(6, 25);
  return buffer;
}

function icoHeader(): Buffer {
  const sizes = [16, 32, 48, 64, 128, 256];
  const buffer = Buffer.alloc(6 + sizes.length * 16);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(sizes.length, 4);
  sizes.forEach((size, index) => {
    buffer.writeUInt8(size === 256 ? 0 : size, 6 + index * 16);
  });
  return buffer;
}

function icnsHeader(): Buffer {
  const types = ["icp4", "icp5", "icp6", "ic07", "ic08", "ic09", "ic10"];
  const chunks = types.map((type) => {
    const chunk = Buffer.alloc(8);
    chunk.write(type, 0, "ascii");
    chunk.writeUInt32BE(8, 4);
    return chunk;
  });
  const buffer = Buffer.concat([Buffer.alloc(8), ...chunks]);
  buffer.write("icns", 0, "ascii");
  buffer.writeUInt32BE(buffer.length, 4);
  return buffer;
}

async function stageIconFixture(): Promise<string> {
  const root = await temporaryDirectory();
  const icons = path.join(root, "resources", "icons");
  await fs.mkdir(icons, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(icons, "app-icon.svg"), "<svg/>"),
    fs.writeFile(path.join(icons, "app-icon.png"), pngHeader(512, 512)),
    fs.writeFile(path.join(icons, "app-icon.ico"), icoHeader()),
    fs.writeFile(path.join(icons, "app-icon.icns"), icnsHeader()),
    fs.writeFile(path.join(icons, "dmg-background.png"), pngHeader(610, 365)),
    fs.writeFile(
      path.join(icons, "dmg-background@2x.png"),
      pngHeader(1220, 730),
    ),
    ...[
      "edgeless.png",
      "journal.png",
      "monitor.png",
      "page.png",
      "tray.png",
      "waveform-recording.png",
      "waveform.png",
    ].map((name) => fs.writeFile(path.join(icons, name), pngHeader(64, 64))),
  ]);
  const bmp = Buffer.alloc(54);
  bmp.write("BM", 0, "ascii");
  bmp.writeInt32LE(164, 18);
  bmp.writeInt32LE(314, 22);
  bmp.writeUInt16LE(24, 28);
  await fs.writeFile(path.join(icons, "nsis-sidebar.bmp"), bmp);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Electron build context", () => {
  test("packaged Linux rejects a missing or another channel's external AppArmor profile", async () => {
    const packagedPath = await temporaryDirectory();
    await fs.chmod(packagedPath, 0o755);
    await fs.mkdir(path.join(packagedPath, "resources"));
    const verify = () =>
      assertPackagedLayout({
        checkoutRoot: "/checkout",
        packagedPath,
        productName: "Myoxus",
        targetPlatform: "linux",
      });
    await expect(verify()).rejects.toMatchObject({
      code: "ENOENT",
      path: path.join(packagedPath, "resources/apparmor-profile"),
    });
    await fs.writeFile(
      path.join(packagedPath, "resources/apparmor-profile"),
      materializeLinuxAppArmor({ productName: "Myoxus-beta" }),
    );
    await expect(verify()).rejects.toThrow("AppArmor profile differs");
  });
  test("makes the Linux package root traversable by unprivileged users", async () => {
    const packageRoot = await temporaryDirectory();
    await fs.chmod(packageRoot, 0o700);

    await ensureLinuxPackageRootPermissions(packageRoot, "linux");

    expect((await fs.stat(packageRoot)).mode & 0o777).toBe(0o755);
  });

  test("derives channel and target paths without mutating its environment", () => {
    const environment = { BUILD_TYPE: " Beta " };
    const before = { ...environment };

    const context = createBuildContext(environment, [
      "--platform",
      "darwin",
      "--arch",
      "arm64",
    ]);

    expect(environment).toEqual(before);
    expect(context).toMatchObject({
      arch: "arm64",
      buildType: "beta",
      platform: "darwin",
      productName: "Myoxus-beta",
    });
    expect(context.stageAppDir).toBe(
      path.join(context.outDir, "stage", "darwin-arm64", "app"),
    );
    expect(context).toMatchObject({
      appIconSvg: path.join(
        context.stageAppDir,
        "resources/icons/app-icon.svg",
      ),
      macosIcns: path.join(
        context.stageAppDir,
        "resources/icons/app-icon.icns",
      ),
      runtimeIconPng: path.join(
        context.stageAppDir,
        "resources/icons/app-icon.png",
      ),
      windowsIco: path.join(
        context.stageAppDir,
        "resources/icons/app-icon.ico",
      ),
    });
    expect(nativeBuildEnvironment(context, {})).toMatchObject({
      MYOXUS_NATIVE_ARCH: "arm64",
      MYOXUS_NATIVE_PLATFORM: "darwin",
      TARGET: "aarch64-apple-darwin",
      CARGO_BUILD_TARGET: "aarch64-apple-darwin",
    });
    expect(targetTripleFor("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(() =>
      nativeBuildEnvironment(context, { TARGET: "x86_64-apple-darwin" }),
    ).toThrow("differs from package darwin/arm64");
    expect(
      nativeBuildEnvironment(context, {
        CARGO_BUILD_TARGET: "x86_64-apple-darwin",
      }),
    ).toMatchObject({ CARGO_BUILD_TARGET: "aarch64-apple-darwin" });
  });

  test("rejects unsupported channels and target dimensions", () => {
    expect(() =>
      createBuildContext({ BUILD_TYPE: "nightly" }, [
        "--platform",
        "linux",
        "--arch",
        "x64",
      ]),
    ).toThrow("BUILD_TYPE must be one of stable, beta, internal");
    expect(() =>
      createBuildContext({ BUILD_TYPE: "stable" }, [
        "--platform",
        "freebsd",
        "--arch",
        "x64",
      ]),
    ).toThrow("platform must be one of darwin, linux, win32");
  });
});

describe("Electron package layout", () => {
  test("requires Packager's sanitized runtime manifest surface", () => {
    const runtimeManifest = {
      author: "Myoxus Contributors",
      description: "Myoxus Desktop App",
      license: "AGPL-3.0-or-later",
      main: "dist/main.js",
      name: "myoxus-desktop",
      productName: "Myoxus",
      type: "commonjs",
      version: "0.41.11",
    };

    expect(() => assertPackagedManifestKeys(runtimeManifest)).not.toThrow();
    expect(() =>
      assertPackagedManifestKeys({ ...runtimeManifest, private: true }),
    ).toThrow("Packaged manifest keys differ");
    expect(() =>
      assertPackagedManifestKeys({ ...runtimeManifest, scripts: {} }),
    ).toThrow("Packaged manifest keys differ");
  });

  test.each([
    ["/dist/helper.js", "dist/helper.js"],
    ["\\dist\\helper.js", "dist/helper.js"],
    ["dist/helper.js", "dist/helper.js"],
  ])("normalizes ASAR entry %s for extraction", (entry, expected) => {
    expect(normalizeAsarEntryPath(entry)).toBe(expected);
  });

  test("uses host separators for nested ASAR lookups", () => {
    expect(asarLookupPath("\\resources\\web-static\\js\\chunk.js", "\\")).toBe(
      "resources\\web-static\\js\\chunk.js",
    );
    expect(asarLookupPath("/resources/web-static/js/chunk.js", "/")).toBe(
      "resources/web-static/js/chunk.js",
    );
  });

  test("accepts only the exact platform resource formats", async () => {
    const root = await stageIconFixture();
    await expect(assertStageIconLayout(root)).resolves.toBeUndefined();

    const bmpPath = path.join(root, "resources", "icons", "nsis-sidebar.bmp");
    const invalidBmp = await fs.readFile(bmpPath);
    invalidBmp.writeUInt16LE(32, 28);
    await fs.writeFile(bmpPath, invalidBmp);

    await expect(assertStageIconLayout(root)).rejects.toThrow(
      "164x314 24-bit RGB",
    );
  });

  test("allows only host, native, and Sentry's non-loading preload probe as externals", () => {
    const metafile = (imports: Array<Record<string, unknown>>) =>
      ({ outputs: { "dist/main.js": { imports } } }) as never;

    expect(() =>
      assertBundledRuntime(
        metafile([
          { external: true, kind: "require-call", path: "electron" },
          { external: true, kind: "require-call", path: "node:path" },
          {
            external: true,
            kind: "require-resolve",
            path: "../../preload/default.js",
          },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      assertBundledRuntime(
        metafile([
          {
            external: true,
            kind: "require-call",
            path: "../../preload/default.js",
          },
        ]),
      ),
    ).toThrow("require-call:../../preload/default.js");
    expect(() =>
      assertBundledRuntime(
        metafile([
          {
            external: true,
            kind: "import-statement",
            path: "electron-updater",
          },
        ]),
      ),
    ).toThrow("import-statement:electron-updater");
  });

  test("atomically replaces a dirty target instead of merging stale files", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "stage", "app");
    const prepared = path.join(root, "prepared");
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(prepared, { recursive: true });
    await fs.writeFile(path.join(target, "stale.js"), "stale");
    await fs.writeFile(path.join(prepared, "main.js"), "current");

    await replaceDirectoryAtomically(prepared, target);

    await expect(
      fs.readFile(path.join(target, "main.js"), "utf8"),
    ).resolves.toBe("current");
    await expect(fs.access(path.join(target, "stale.js"))).rejects.toThrow();
  });

  test("rejects TSC and stale files from the runtime dist", async () => {
    const root = await temporaryDirectory();
    for (const name of ["main.js", "preload.js", "helper.js"]) {
      await fs.writeFile(path.join(root, name), "module.exports = {};\n");
    }
    for (const name of [
      "myoxus_crypto.node",
      "myoxus_media.node",
      "myoxus_storage.linux-x64-gnu.node",
    ]) {
      await fs.writeFile(path.join(root, name), "native");
    }
    await fs.writeFile(path.join(root, "stale.d.ts"), "export {};\n");

    await expect(assertDistLayout(root, "/checkout")).rejects.toThrow(
      "stale.d.ts",
    );
  });

  test("rejects an incomplete or extra native runtime binding set", async () => {
    const root = await temporaryDirectory();
    for (const name of ["main.js", "preload.js", "helper.js"]) {
      await fs.writeFile(path.join(root, name), "module.exports = {};\n");
    }
    await fs.writeFile(path.join(root, "myoxus_crypto.node"), "native");
    await expect(assertDistLayout(root, "/checkout")).rejects.toThrow(
      "exactly the three native bindings",
    );

    await fs.writeFile(path.join(root, "unowned.node"), "native");
    await expect(assertDistLayout(root, "/checkout")).rejects.toThrow(
      "unowned.node",
    );
  });

  test("requires the three distinct native bindings and runtime resources in a real packaged ASAR", async () => {
    const stage = await stageFixture();
    const manifest = JSON.parse(
      await fs.readFile(path.join(stage, "package.json"), "utf8"),
    );
    delete manifest.private;
    await fs.writeFile(
      path.join(stage, "package.json"),
      JSON.stringify(manifest),
    );
    await fs.mkdir(path.join(stage, "THIRD_PARTY_LICENSES"));
    await fs.writeFile(
      path.join(stage, "THIRD_PARTY_NOTICES.md"),
      "Mediabunny\nVersion: 1.50.9\nLicense: MPL-2.0\n",
    );
    await fs.writeFile(
      path.join(stage, "THIRD_PARTY_LICENSES/mediabunny-MPL-2.0.txt"),
      "Mozilla Public License Version 2.0\n",
    );
    await fs.writeFile(
      path.join(stage, "BUILD-PROVENANCE.txt"),
      `buildType=stable\nplatform=darwin\narch=arm64\nsource=${"a".repeat(40)}\nelectronE2e=false\n`,
    );
    for (const name of ["preload.js", "helper.js"]) {
      await fs.writeFile(
        path.join(stage, "dist", name),
        "module.exports = {};\n",
      );
    }
    await fs.mkdir(path.join(stage, "resources/web-static"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(stage, "resources/web-static/index.html"),
      "<!doctype html>",
    );
    const renderer = path.join(stage, "resources/web-static");
    await fs.writeFile(
      path.join(renderer, "bpmn-modeller.css"),
      ".react-flow {}",
    );
    await writeRendererAssetInventory(renderer, renderer);
    for (const name of [
      "myoxus_crypto.node",
      "myoxus_media.node",
      "myoxus_storage.darwin-arm64.node",
    ]) {
      await fs.writeFile(path.join(stage, "dist", name), "native");
    }
    const packagedPath = await temporaryDirectory();
    const resources = path.join(packagedPath, "Myoxus.app/Contents/Resources");
    await fs.mkdir(resources, { recursive: true });
    const asar = path.join(resources, "app.asar");
    const verify = () =>
      assertPackagedLayout({
        checkoutRoot: "/checkout",
        packagedPath,
        productName: "Myoxus",
        targetPlatform: "darwin",
      });
    await createPackageWithOptions(stage, asar, { unpack: "**/*.node" });
    await expect(verify()).resolves.toBeUndefined();
    const unpacked = path.join(resources, "app.asar.unpacked/dist");
    await fs.rename(
      path.join(unpacked, "myoxus_media.node"),
      path.join(unpacked, "myoxus_storage.darwin-x64.node"),
    );
    await expect(verify()).rejects.toThrow("exactly the three native bindings");
    await fs.rename(
      path.join(unpacked, "myoxus_storage.darwin-x64.node"),
      path.join(unpacked, "myoxus_media.node"),
    );
    await fs.rm(path.join(renderer, "bpmn-modeller.css"));
    await createPackageWithOptions(stage, asar, { unpack: "**/*.node" });
    await expect(verify()).rejects.toThrow(
      "Missing renderer asset: bpmn-modeller.css",
    );
    await fs.writeFile(
      path.join(renderer, "bpmn-modeller.css"),
      ".react-flow {}",
    );
    await fs.rm(path.join(stage, "dist/preload.js"));
    await createPackageWithOptions(stage, asar, { unpack: "**/*.node" });
    await expect(verify()).rejects.toThrow();
  });

  test.each([
    ".gitignore",
    "resources/web-static/.cache/entry",
    "main.js.map",
    "node_modules/dependency/index.js",
  ])("rejects forbidden stage artifact %s", async (relativePath) => {
    const root = await stageFixture();
    const absolute = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "fixture");
    await expect(assertStageLayout(root, "/checkout")).rejects.toThrow(
      "Forbidden stage artifacts",
    );
  });

  test("rejects source disclosure and retired packaging config", async () => {
    const root = await stageFixture();
    await fs.writeFile(
      path.join(root, "dist", "main.js"),
      '//# sourceMappingURL=main.js.map\nconst source = "/checkout/src/main.ts";\n',
    );
    await expect(assertStageLayout(root, "/checkout")).rejects.toThrow(
      "source metadata",
    );

    await fs.writeFile(
      path.join(root, "dist", "main.js"),
      "module.exports = {};\n",
    );
    await fs.writeFile(
      path.join(root, "forge.config.mjs"),
      "export default {};\n",
    );
    await expect(assertStageLayout(root, "/checkout")).rejects.toThrow(
      "Forbidden stage artifacts",
    );
  });

  test("trims packaged locales to the configured set with English fallbacks", async () => {
    const root = await temporaryDirectory();
    const resourcesApp = path.join(root, "resources", "app");
    const locales = path.join(root, "locales");
    await fs.mkdir(resourcesApp, { recursive: true });
    await fs.mkdir(locales);
    for (const locale of ["de", "en-GB", "en-US", "nl"]) {
      await fs.writeFile(path.join(locales, `${locale}.pak`), locale);
    }

    await trimElectronLocales(resourcesApp, "linux", {
      ELECTRON_LOCALES_KEEP: "nl",
    });

    await expect(fs.readdir(locales)).resolves.toEqual([
      "en-GB.pak",
      "en-US.pak",
      "nl.pak",
    ]);
  });
});

describe("Electron process tree cleanup", () => {
  test("propagates a non-zero child exit", async () => {
    await expect(
      runProcess({
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: process.cwd(),
        stdio: "pipe",
      }),
    ).rejects.toThrow("exited with code 7");
  });

  test("aborts and reaps a real POSIX process", async () => {
    if (process.platform === "win32") return;
    const controller = new AbortController();
    const child = runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      signal: controller.signal,
      stdio: "pipe",
    });
    setTimeout(() => controller.abort(), 50);

    await expect(child).rejects.toThrow("was aborted");
  });

  test("uses taskkill tree and force flags in the Windows adapter", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    const taskkill = vi.fn().mockImplementation(async () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return { stdout: "", stderr: "" };
    });

    await stopProcessTree(child, "win32", taskkill);

    expect(taskkill).toHaveBeenCalledWith("taskkill", [
      "/pid",
      "4242",
      "/t",
      "/f",
    ]);
  });
});
