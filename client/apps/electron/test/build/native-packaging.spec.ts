// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";
import { FuseV1Options } from "@electron/fuses";

import { applePackagingOptions } from "../../scripts/lib/application-packager";
import { fuseOptions } from "../../scripts/lib/package-postprocess";

import { createBuildContext } from "../../scripts/lib/build-context";
import { buildLinuxPackage } from "../../scripts/lib/linux-native-packager";
import { createPackagingIdentity } from "../../scripts/lib/packaging-config";
import * as processes from "../../scripts/lib/process";
import {
  windowsInstallerGuid,
  writeInstallerTranslations,
} from "../../scripts/lib/windows-native-packager";

test("uses profile cookies only on macOS while preserving other platform encryption", () => {
  for (const targetPlatform of ["darwin", "linux", "win32"] as const) {
    expect(
      fuseOptions({ targetPlatform, resetAdHocDarwinSignature: false })[
        FuseV1Options.EnableCookieEncryption
      ],
    ).toBe(targetPlatform !== "darwin");
  }
});

test.each(["stable"])(
  "Flatpak %s metadata uses the unchanged stage raster without an optional SVG loader",
  async (buildType) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "myoxus-flatpak-icon-"),
    );
    const run = vi.spyOn(processes, "runProcess").mockResolvedValue(undefined);
    try {
      const context = {
        ...createBuildContext({ BUILD_TYPE: buildType }, [
          "--platform",
          "linux",
        ]),
        repoRoot: root,
        stageAppDir: path.join(root, "stage"),
        appIconSvg: path.join(root, "source.svg"),
        runtimeIconPng: path.join(root, "runtime.png"),
      };
      const identity = createPackagingIdentity(context, "0.41.21");
      const application = path.join(root, "application");
      const outputDirectory = path.join(root, "artifacts");
      await fs.mkdir(application);
      await fs.mkdir(outputDirectory);
      await fs.mkdir(path.join(context.stageAppDir, "resources"), {
        recursive: true,
      });
      await fs.writeFile(path.join(root, "LICENSE"), "AGPL-3.0-or-later");
      await fs.writeFile(context.appIconSvg, "<svg/>");
      const raster = Buffer.from("stage-owned raster bytes");
      await fs.writeFile(context.runtimeIconPng, raster);
      await fs.writeFile(
        path.join(context.stageAppDir, "resources/myoxus.metainfo.xml"),
        '<component><launchable type="desktop-id">Myoxus.desktop</launchable></component>',
      );
      await buildLinuxPackage({
        application,
        outputDirectory,
        context,
        identity,
        target: "flatpak",
      });
      expect(
        await fs.readFile(
          path.join(
            root,
            `payload/share/icons/hicolor/512x512/apps/${identity.appId}.png`,
          ),
        ),
      ).toEqual(raster);
      await expect(
        fs.stat(
          path.join(
            root,
            `payload/share/icons/hicolor/scalable/apps/${identity.appId}.svg`,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(context.appIconSvg, "utf8")).toBe("<svg/>");
      expect(run.mock.calls.map(([options]) => options.command)).toEqual([
        "flatpak-builder",
        "flatpak",
      ]);
    } finally {
      run.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test.each([["org.myoxus.desktop", "3b3c6ba0-b356-5741-ac1c-e4649155e928"]])(
  "retains deployed Windows registry identity for %s",
  (appId, expected) => {
    expect(windowsInstallerGuid(appId)).toBe(expected);
  },
);

test("uses the supported per-file hardened runtime contract with notarization", () => {
  const options = applePackagingOptions({
    APPLE_SIGNING_IDENTITY: "Myoxus signing",
    APPLE_ID: "qa@example.invalid",
    APPLE_PASSWORD: "test-value",
    APPLE_TEAM_ID: "TESTTEAM",
  });
  expect(options.osxSign).toBeTruthy();
  const signing = options.osxSign as Exclude<
    typeof options.osxSign,
    boolean | undefined
  >;
  expect(
    signing.optionsForFile?.("Myoxus.app/Contents/MacOS/Myoxus"),
  ).toMatchObject({ hardenedRuntime: true });
  expect(
    signing.optionsForFile?.("Myoxus.app/Contents/Frameworks/helper"),
  ).toMatchObject({ hardenedRuntime: true });
  expect(options.osxNotarize).toMatchObject({ teamId: "TESTTEAM" });
  expect(() =>
    applePackagingOptions({ APPLE_ID: "qa@example.invalid" }),
  ).toThrow("requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID");
});

test("writes all shared installer locales, native-language fallback and safe NSIS values", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "myoxus-installer-locale-"),
  );
  try {
    const output = path.join(root, "translations.nsh");
    const context = createBuildContext({}, []);
    await writeInstallerTranslations(context.repoRoot, 'Myoxus $"QA"', output, [
      "Japanese",
      "Dutch",
    ]);
    const bytes = await fs.readFile(output);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const source = bytes.toString("utf8");
    for (const [locale, id] of [
      ["en", 1033],
      ["de", 1031],
      ["fr", 1036],
      ["es", 3082],
    ] as const) {
      const resources = JSON.parse(
        await fs.readFile(
          path.join(
            context.repoRoot,
            `client/libs/i18n/src/resources/${locale}.json`,
          ),
          "utf8",
        ),
      );
      expect(source).toContain(
        `LangString PreviousUninstallFailed ${id} "${resources["com.myoxus.appInstaller.previousUninstallFailed"]}"`,
      );
    }
    expect(source).toContain("LangString WriteFailed ${LANG_JAPANESE}");
    expect(source).toContain("LangString WriteFailed ${LANG_DUTCH}");
    expect(source).toContain('Myoxus $$$\\"QA$\\"');
    expect(source).not.toContain("{{appName}}");
    await expect(
      writeInstallerTranslations(context.repoRoot, "Myoxus", output, [
        "English\n!error injected",
      ]),
    ).rejects.toThrow("Invalid NSIS language name");
    await expect(
      writeInstallerTranslations(
        context.repoRoot,
        "Myoxus\n!error injected",
        output,
      ),
    ).rejects.toThrow("Invalid NSIS define value");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
