// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  assertPackagingHost,
  packageElectronApplication,
} from "../../scripts/lib/application-packager";
import {
  createBuildContext,
  nativeTargetFromTriple,
  targetTripleFor,
} from "../../scripts/lib/build-context";
import {
  assertPackagingTarget,
  createApplicationPackagerValues,
  createPackagingIdentity,
  materializeLinuxAppArmor,
  materializeLinuxMetainfo,
} from "../../scripts/lib/packaging-config";
import {
  packageWithNativeTools,
  publishArtifactSet,
} from "../../scripts/lib/packaging-runner";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "myoxus-packaging-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("Electron packaging identity", () => {
  test.each(["stable"])(
    "Linux %s permits user namespaces only for its own installed executable",
    (buildType) => {
      const context = createBuildContext({ BUILD_TYPE: buildType }, [
        "--platform",
        "linux",
        "--arch",
        "x64",
      ]);
      const profile = materializeLinuxAppArmor(context);
      expect(profile).toContain(
        `profile ${context.productName} /opt/${context.productName}/${context.productName} flags=(unconfined)`,
      );
      expect(profile).toMatch(/^  userns,$/m);
      expect(profile).toContain(
        `include if exists <local/${context.productName}>`,
      );
      expect(profile).not.toContain("/opt/**");
    },
  );
  test("materializes current Linux release metadata without stale placeholders", () => {
    const identity = createPackagingIdentity(
      createBuildContext({ BUILD_TYPE: "stable" }, [
        "--platform",
        "linux",
        "--arch",
        "x64",
      ]),
      "0.40.0",
    );
    const metainfo = materializeLinuxMetainfo(
      '<component><id>old</id><name>Old</name><url type="homepage">__MYOXUS_HOMEPAGE_URL__</url><url type="bugtracker">__MYOXUS_ISSUES_URL__</url><url type="help">__MYOXUS_HELP_URL__</url><url type="vcs-browser">__MYOXUS_SOURCE_URL__</url><mediatype>x-scheme-handler/old</mediatype><launchable type="desktop-id">Old.desktop</launchable><release version="__MYOXUS_VERSION__"/></component>',
      identity,
    );

    expect(metainfo).toContain("<id>org.myoxus.desktop</id>");
    expect(metainfo).toContain('<release version="0.40.0"/>');
    expect(metainfo).toContain(
      '<url type="bugtracker">https://github.com/superions/myoxus/issues</url>',
    );
    expect(metainfo).toContain(
      '<url type="help">https://github.com/superions/myoxus/blob/main/docs/README.md</url>',
    );
    expect(metainfo).not.toContain("__MYOXUS_");
  });

  test.each([
    ["stable", "linux", "x64", "org.myoxus.desktop", "Myoxus"],
    ["beta", "darwin", "arm64", "org.myoxus.beta", "Myoxus-beta"],
    ["internal", "darwin", "x64", "org.myoxus.internal", "Myoxus-internal"],
    ["stable", "win32", "x64", "org.myoxus.desktop", "Myoxus"],
  ] as const)(
    "keeps %s %s/%s metadata aligned",
    (buildType, platform, arch, appId, productName) => {
      const context = createBuildContext({ BUILD_TYPE: buildType }, [
        "--platform",
        platform,
        "--arch",
        arch,
      ]);
      assertPackagingTarget(context);
      const identity = createPackagingIdentity(context, "0.40.0");
      const packager = createApplicationPackagerValues(context);
      expect(identity).toMatchObject({
        appId,
        productName,
        protocolScheme: productName.toLowerCase(),
        appIconSvg: path.join(
          context.stageAppDir,
          "resources/icons/app-icon.svg",
        ),
        runtimeIconPng: path.join(
          context.stageAppDir,
          "resources/icons/app-icon.png",
        ),
      });
      expect(identity.artifactName("zip")).toBe(
        `myoxus-0.40.0-${buildType}-${platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux"}-${arch}.zip`,
      );
      expect(packager).toMatchObject({
        appBundleId: appId,
        executableName: productName,
        productName,
        protocolScheme: productName.toLowerCase(),
      });
    },
  );

  test("rejects targets that are not in the release matrix", () => {
    const context = createBuildContext({ BUILD_TYPE: "stable" }, [
      "--platform",
      "linux",
      "--arch",
      "arm64",
    ]);
    expect(() => assertPackagingTarget(context)).toThrow(
      "Unsupported packaging target linux/arm64",
    );
    expect(() => createPackagingIdentity(context, "not-semver")).toThrow(
      "Invalid Electron release version",
    );
  });

  test("uses one reversible native target-triple mapping", () => {
    for (const [platform, arch, libc, triple] of [
      ["darwin", "arm64", "gnu", "aarch64-apple-darwin"],
      ["darwin", "x64", "gnu", "x86_64-apple-darwin"],
      ["win32", "arm64", "gnu", "aarch64-pc-windows-msvc"],
      ["win32", "x64", "gnu", "x86_64-pc-windows-msvc"],
      ["linux", "arm64", "gnu", "aarch64-unknown-linux-gnu"],
      ["linux", "x64", "musl", "x86_64-unknown-linux-musl"],
    ] as const) {
      expect(targetTripleFor(platform, arch, libc)).toBe(triple);
      expect(nativeTargetFromTriple(triple)).toMatchObject({ platform, arch });
    }
    expect(nativeTargetFromTriple("unsupported-target")).toBeNull();
  });
});

describe("Electron application packager", () => {
  test("permits macOS cross-packaging without pretending to run the target", () => {
    expect(() =>
      assertPackagingHost(
        { platform: "darwin", arch: "arm64" },
        { platform: "darwin", arch: "x64" },
      ),
    ).not.toThrow();
    expect(() =>
      assertPackagingHost(
        { platform: "darwin", arch: "x64" },
        { platform: "darwin", arch: "arm64" },
      ),
    ).not.toThrow();
    expect(() =>
      assertPackagingHost(
        { platform: "darwin", arch: "arm64" },
        { platform: "linux", arch: "x64" },
      ),
    ).toThrow("requires its owning");
    expect(() =>
      assertPackagingHost(
        { platform: "linux", arch: "arm64" },
        { platform: "linux", arch: "x64" },
      ),
    ).toThrow("requires its owning");
  });

  test("rejects a target that does not belong to the current host", async () => {
    const foreignPlatform = process.platform === "linux" ? "win32" : "linux";
    const context = createBuildContext({ BUILD_TYPE: "stable" }, [
      "--platform",
      foreignPlatform,
      "--arch",
      "x64",
    ]);
    const packager = vi.fn();

    await expect(
      packageElectronApplication({
        context,
        packager: packager as never,
      }),
    ).rejects.toThrow("requires its owning");
    expect(packager).not.toHaveBeenCalled();
  });

  test("passes the immutable stage contract to the direct packager", async () => {
    if (
      !["darwin", "linux", "win32"].includes(process.platform) ||
      !["arm64", "x64"].includes(process.arch)
    ) {
      return;
    }
    const root = await temporaryDirectory();
    const electronDir = path.join(root, "electron");
    const stageAppDir = path.join(root, "stage");
    const outDir = path.join(root, "out");
    await fs.mkdir(path.join(stageAppDir, "resources"), { recursive: true });
    await fs.mkdir(electronDir, { recursive: true });
    await fs.writeFile(
      path.join(electronDir, "package.json"),
      `${JSON.stringify({
        devDependencies: { electron: "44.2.0" },
        version: "0.41.1",
      })}\n`,
    );
    await fs.writeFile(
      path.join(stageAppDir, "resources", "app-update.yml"),
      "provider: generic\n",
    );
    const context = {
      ...createBuildContext({ BUILD_TYPE: "stable" }, [
        "--platform",
        process.platform,
        "--arch",
        process.arch,
      ]),
      electronDir,
      outDir,
      stageAppDir,
    };
    const expected = new Error("stop after option inspection");
    const packager = vi.fn(async (options) => {
      expect(options).toMatchObject({
        arch: process.arch,
        asar: { unpack: "**/*.node" },
        dir: stageAppDir,
        electronVersion: "44.2.0",
        out: path.join(
          outDir,
          `.package-${process.platform}-${process.arch}-${process.pid}`,
        ),
        platform: process.platform,
        prune: false,
      });
      expect(options.afterCopy).toHaveLength(1);
      const mismatchedPlatform =
        process.platform === "linux" ? "win32" : "linux";
      await expect(
        options.afterCopy[0]({
          arch: process.arch,
          buildPath: stageAppDir,
          electronVersion: "44.2.0",
          platform: mismatchedPlatform,
        }),
      ).rejects.toThrow(
        `Electron Packager hook target differs: expected ${process.platform}/${process.arch}, got ${mismatchedPlatform}/${process.arch}`,
      );
      expect(options.extraResource).toEqual([
        path.join(stageAppDir, "resources", "app-update.yml"),
        ...(process.platform === "linux"
          ? [path.join(stageAppDir, "resources", "apparmor-profile")]
          : []),
      ]);
      throw expected;
    });

    await expect(
      packageElectronApplication({
        context,
        environment: {},
        packager: packager as never,
      }),
    ).rejects.toBe(expected);
    expect(packager).toHaveBeenCalledOnce();
    await expect(fs.readdir(outDir)).resolves.toEqual([]);
  });
});

describe("Electron native packaging runner", () => {
  test("passes the macOS app bundle itself to the native archive tool", async () => {
    const root = await temporaryDirectory();
    const packagedAppDir = path.join(root, "packaged");
    const makeDir = path.join(root, "make");
    await fs.mkdir(path.join(packagedAppDir, "Myoxus.app"), {
      recursive: true,
    });
    const context = {
      ...createBuildContext({ BUILD_TYPE: "stable" }, [
        "--platform",
        "darwin",
        "--arch",
        "arm64",
      ]),
      makeDir,
      packagedAppDir,
    };

    await packageWithNativeTools({
      artifactExtensions: ["zip"],
      build: async (options) => {
        expect(path.basename(options.application)).toBe("Myoxus.app");
        const artifact = path.join(options.outputDirectory, "myoxus.zip");
        await fs.writeFile(artifact, "complete");
        return [artifact];
      },
      context,
      target: "desktop-darwin-arm64",
    });
    await expect(
      fs.readdir(path.join(makeDir, "desktop-darwin-arm64")),
    ).resolves.toEqual(["myoxus.zip"]);
  });

  test.runIf(process.platform !== "win32")(
    "keeps POSIX framework links portable after the original application is removed",
    async () => {
      const root = await temporaryDirectory();
      const packagedAppDir = path.join(root, "packaged");
      const relativeFramework =
        "Myoxus.app/Contents/Frameworks/Electron Framework.framework";
      const framework = path.join(packagedAppDir, relativeFramework);
      await fs.mkdir(path.join(framework, "Versions/A"), { recursive: true });
      await fs.writeFile(
        path.join(framework, "Versions/A/Electron Framework"),
        "binary",
      );
      await fs.symlink("A", path.join(framework, "Versions/Current"), "dir");
      await fs.symlink(
        "Versions/Current/Electron Framework",
        path.join(framework, "Electron Framework"),
      );
      const context = {
        ...createBuildContext({ BUILD_TYPE: "stable" }, [
          "--platform",
          "darwin",
          "--arch",
          "arm64",
        ]),
        makeDir: path.join(root, "make"),
        packagedAppDir,
      };
      await packageWithNativeTools({
        artifactExtensions: ["zip"],
        build: async (options) => {
          const copiedFramework = path.join(
            path.dirname(options.application),
            relativeFramework,
          );
          expect(
            await fs.readlink(path.join(copiedFramework, "Versions/Current")),
          ).toBe("A");
          expect(
            await fs.readlink(path.join(copiedFramework, "Electron Framework")),
          ).toBe("Versions/Current/Electron Framework");
          await fs.rm(packagedAppDir, { recursive: true });
          expect(
            await fs.readFile(
              path.join(copiedFramework, "Electron Framework"),
              "utf8",
            ),
          ).toBe("binary");
          const artifact = path.join(options.outputDirectory, "myoxus.zip");
          await fs.writeFile(artifact, "complete");
          return [artifact];
        },
        context,
        target: "desktop-darwin-arm64",
      });
    },
  );

  test("rejects orphaned native packager sidecars", async () => {
    const root = await temporaryDirectory();
    const packagedAppDir = path.join(root, "packaged");
    const makeDir = path.join(root, "make");
    await fs.mkdir(packagedAppDir, { recursive: true });
    const context = {
      ...createBuildContext({ BUILD_TYPE: "stable" }, [
        "--platform",
        "win32",
        "--arch",
        "x64",
      ]),
      makeDir,
      packagedAppDir,
    };

    await expect(
      packageWithNativeTools({
        artifactExtensions: ["zip"],
        build: async (options) => {
          const artifact = path.join(options.outputDirectory, "myoxus.zip");
          const orphanedSidecar = path.join(
            options.outputDirectory,
            "orphan.zip.blockmap",
          );
          await fs.writeFile(artifact, "complete");
          await fs.writeFile(orphanedSidecar, "unexpected");
          return [artifact, orphanedSidecar];
        },
        context,
        target: "desktop-win32-x64",
      }),
    ).rejects.toThrow("Native packager artifact set differs");
    await expect(
      fs.stat(path.join(makeDir, "desktop-win32-x64")),
    ).rejects.toThrow();
  });

  test("publishes a complete artifact set and rejects Squirrel output before replacement", async () => {
    const root = await temporaryDirectory();
    const packagedAppDir = path.join(root, "packaged");
    const makeDir = path.join(root, "make");
    await fs.mkdir(path.join(packagedAppDir, "resources"), { recursive: true });
    const context = {
      ...createBuildContext({ BUILD_TYPE: "stable" }, [
        "--platform",
        "linux",
        "--arch",
        "x64",
      ]),
      makeDir,
      packagedAppDir,
    };

    const artifacts = await packageWithNativeTools({
      artifactExtensions: ["deb"],
      build: async (options) => {
        expect(path.basename(options.outputDirectory)).toBe("output");
        const deb = path.join(options.outputDirectory, "myoxus.deb");
        await fs.writeFile(deb, "complete");
        return [deb];
      },
      context,
      target: "deb",
    });
    expect(artifacts).toEqual([path.join(makeDir, "deb", "myoxus.deb")]);
    await expect(fs.readFile(artifacts[0], "utf8")).resolves.toBe("complete");

    await expect(
      packageWithNativeTools({
        artifactExtensions: ["deb"],
        build: async (options) => {
          const forbidden = path.join(
            options.outputDirectory,
            "myoxus-full.nupkg",
          );
          await fs.writeFile(forbidden, "forbidden");
          return [forbidden];
        },
        context,
        target: "deb",
      }),
    ).rejects.toThrow("Forbidden Electron packaging artifacts");
    await expect(fs.readFile(artifacts[0], "utf8")).resolves.toBe("complete");
    expect(
      (await fs.readdir(makeDir)).some((name) => name.includes("prepared")),
    ).toBe(false);
  });

  test("propagates failure, removes its temporary tree, and does not log secrets", async () => {
    const root = await temporaryDirectory();
    const packagedAppDir = path.join(root, "packaged");
    await fs.mkdir(path.join(packagedAppDir, "resources"), { recursive: true });
    const context = {
      ...createBuildContext({ BUILD_TYPE: "stable" }, [
        "--platform",
        "linux",
        "--arch",
        "x64",
      ]),
      packagedAppDir,
    };
    let temporaryApp = "";
    const secret = "must-not-enter-structured-log";
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await expect(
      packageWithNativeTools({
        artifactExtensions: ["deb"],
        build: async (options) => {
          temporaryApp = options.application;
          await fs.writeFile(path.join(temporaryApp, "partial"), "partial");
          throw new Error(secret);
        },
        context,
        target: "deb",
      }),
    ).rejects.toThrow(secret);

    expect(temporaryApp).not.toBe("");
    await expect(fs.access(path.dirname(temporaryApp))).rejects.toThrow();
    const output = write.mock.calls.flat().join("");
    expect(output).toContain('"phase":"native-package"');
    expect(output).toContain('"status":"failed"');
    expect(output).toContain('"exitCode":1');
    expect(output).toContain('"target":"deb"');
    expect(output).not.toContain(secret);
  });
});

describe("Artifact publication safety", () => {
  test("rejects duplicate names without replacing a previous checkpoint", async () => {
    const root = await temporaryDirectory();
    const output = path.join(root, "published");
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, "previous.zip"), "sealed");
    await expect(
      publishArtifactSet({
        generatedPaths: ["a", "b"],
        artifactNames: ["same.zip", "SAME.zip"],
        targetOutput: output,
      }),
    ).rejects.toThrow("one basename per output");
    expect(await fs.readFile(path.join(output, "previous.zip"), "utf8")).toBe(
      "sealed",
    );
  });
});
