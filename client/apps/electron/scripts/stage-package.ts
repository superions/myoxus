// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs/promises";
import path from "node:path";

import { packageElectronApplication } from "./lib/application-packager";
import {
  createBuildContext,
  nativeBuildEnvironment,
} from "./lib/build-context";
import {
  assertStageIconLayout,
  assertStageLayout,
  replaceDirectoryAtomically,
  writeRendererAssetInventory,
} from "./lib/package-layout";
import {
  createPackagingIdentity,
  materializeLinuxAppArmor,
  materializeLinuxMetainfo,
} from "./lib/packaging-config";
import { writePackagingEvent } from "./lib/packaging-runner";
import { runProcess, runProcessCapture, yarnInvocation } from "./lib/process";

const context = createBuildContext();

async function copyRenderer(source: string, target: string): Promise<void> {
  await fs.cp(source, target, {
    recursive: true,
    force: true,
    filter: (candidate) =>
      !path.basename(candidate).startsWith(".") && !candidate.endsWith(".map"),
  });
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.name.endsWith(".js")) {
        const sourceText = await fs.readFile(absolute, "utf8");
        await fs.writeFile(
          absolute,
          sourceText
            .replace(/\n?\/\/[#@] sourceMappingURL=.*?(?:\n|$)/g, "\n")
            .replaceAll(context.repoRoot, "/__myoxus_bundle__"),
        );
      }
    }
  }
  await writeRendererAssetInventory(source, target);
}

async function materializeThirdPartyNotices(stageRoot: string): Promise<void> {
  const packageRoot = path.join(context.repoRoot, "node_modules", "mediabunny");
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
    license?: string;
    repository?: { url?: string };
  };
  if (
    manifest.name !== "mediabunny" ||
    manifest.version !== "1.50.9" ||
    manifest.license !== "MPL-2.0"
  ) {
    throw new Error(
      "Resolved Mediabunny provenance differs from the release contract",
    );
  }

  const source = manifest.repository?.url?.replace(/^git\+/, "");
  if (!source) throw new Error("Resolved Mediabunny source URL is missing");
  const licenseDirectory = path.join(stageRoot, "THIRD_PARTY_LICENSES");
  await fs.mkdir(licenseDirectory, { recursive: true });
  await fs.copyFile(
    path.join(packageRoot, "LICENSE"),
    path.join(licenseDirectory, "mediabunny-MPL-2.0.txt"),
  );
  await fs.writeFile(
    path.join(stageRoot, "THIRD_PARTY_NOTICES.md"),
    `# Third-Party Notices\n\nThe release CycloneDX SBOM inventories the complete resolved dependency graph. Electron and Chromium retain their notices in the Electron distribution.\n\n## Mediabunny\n\n- Version: ${manifest.version}\n- Source: ${source}\n- License: MPL-2.0\n- License text: \`THIRD_PARTY_LICENSES/mediabunny-MPL-2.0.txt\`\n`,
  );
}

async function buildInputs(): Promise<void> {
  if (process.env.SKIP_WEB_BUILD) return;

  // Renderer bundling resolves the workspace NAPI loaders, so the native
  // binaries must exist before either JavaScript bundle is compiled in a clean
  // release checkout.
  const native = yarnInvocation(context.repoRoot, [
    "workspace",
    "@myoxus/electron",
    "native:ensure",
  ]);
  await runProcess({
    ...native,
    cwd: context.repoRoot,
    env: nativeBuildEnvironment(context),
  });

  for (const args of [
    ["run", "-T", "myoxus", "bundle", "-p", "@myoxus/electron-renderer"],
    [
      "workspace",
      "@myoxus/electron",
      "build",
      "--platform",
      context.platform,
      "--arch",
      context.arch,
    ],
  ]) {
    const yarn = yarnInvocation(context.repoRoot, args);
    await runProcess({
      ...yarn,
      cwd: context.repoRoot,
      env: nativeBuildEnvironment(context),
    });
  }
}

async function createStage(): Promise<void> {
  const temporary = `${context.stageAppDir}.tmp-${process.pid}`;
  await fs.rm(temporary, { recursive: true, force: true });
  try {
    await fs.mkdir(path.join(temporary, "dist"), { recursive: true });

    const distDir = path.join(context.electronDir, "dist");
    const distEntries = await fs.readdir(distDir, { withFileTypes: true });
    for (const entry of distEntries) {
      if (!entry.isFile() || entry.name.endsWith(".map")) continue;
      if (!entry.name.endsWith(".js") && !entry.name.endsWith(".node")) {
        throw new Error(`Refusing unexpected dist input ${entry.name}`);
      }
      await fs.copyFile(
        path.join(distDir, entry.name),
        path.join(temporary, "dist", entry.name),
      );
    }

    const rendererOut = path.join(context.rendererDir, "dist");
    await copyRenderer(
      rendererOut,
      path.join(temporary, "resources", "web-static"),
    );
    await runProcess({
      command: process.execPath,
      args: [
        path.join(
          context.repoRoot,
          "client",
          "libs",
          "icons",
          "scripts",
          "build-assets.mjs",
        ),
        "--stage-root",
        temporary,
        "--channel",
        context.buildType,
      ],
      cwd: context.repoRoot,
    });
    await assertStageIconLayout(temporary);
    await fs.copyFile(
      path.join(context.repoRoot, "LICENSE"),
      path.join(temporary, "LICENSE"),
    );
    await materializeThirdPartyNotices(temporary);

    const packageJson = JSON.parse(
      await fs.readFile(path.join(context.electronDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const stageManifest = {
      name: "myoxus-desktop",
      productName: context.productName,
      version: packageJson.version,
      main: "dist/main.js",
      private: true,
      description: packageJson.description,
      author: packageJson.author,
      license: "AGPL-3.0-or-later",
      type: "commonjs",
    };
    await fs.writeFile(
      path.join(temporary, "package.json"),
      `${JSON.stringify(stageManifest, null, 2)}\n`,
    );
    const updateTemplate = (
      await fs.readFile(
        path.join(
          context.electronDir,
          "resources",
          "templates",
          "app-update.yml",
        ),
        "utf8",
      )
    ).replace(
      "__MYOXUS_UPDATER_CACHE_DIR__",
      `${context.productName.toLowerCase()}-updater`,
    );
    const electronE2e = process.env.ELECTRON_E2E === "1";
    const electronE2eUpdateFeed =
      process.env.ELECTRON_E2E_UPDATE_FEED?.trim() || null;
    const electronE2ePackageType =
      process.env.ELECTRON_E2E_PACKAGE_TYPE?.trim().toLowerCase() || null;
    if (electronE2eUpdateFeed && !electronE2e) {
      throw new Error(
        "ELECTRON_E2E_UPDATE_FEED is forbidden outside ELECTRON_E2E=1",
      );
    }
    if (electronE2ePackageType && !electronE2e) {
      throw new Error(
        "ELECTRON_E2E_PACKAGE_TYPE is forbidden outside ELECTRON_E2E=1",
      );
    }
    if (
      electronE2ePackageType &&
      !["deb", "nsis", "rpm"].includes(electronE2ePackageType)
    ) {
      throw new Error(
        `Unsupported ELECTRON_E2E_PACKAGE_TYPE ${electronE2ePackageType}`,
      );
    }
    await fs.writeFile(
      path.join(temporary, "resources", "app-update.yml"),
      electronE2eUpdateFeed
        ? `${updateTemplate.trimEnd()}\nfeedUrl: ${JSON.stringify(electronE2eUpdateFeed)}\nelectronE2e: true\n`
        : updateTemplate,
    );
    if (electronE2ePackageType) {
      await fs.writeFile(
        path.join(temporary, "resources", "package-type"),
        `${electronE2ePackageType}\n`,
      );
    }
    const metainfoTemplate = await fs.readFile(
      path.join(
        context.electronDir,
        "resources",
        "templates",
        "linux.metainfo.xml",
      ),
      "utf8",
    );
    const metainfo = materializeLinuxMetainfo(
      metainfoTemplate,
      createPackagingIdentity(context, String(packageJson.version ?? "")),
    );
    await fs.writeFile(
      path.join(temporary, "resources", "myoxus.metainfo.xml"),
      metainfo,
    );
    if (context.platform === "linux") {
      await fs.writeFile(
        path.join(temporary, "resources", "apparmor-profile"),
        materializeLinuxAppArmor(context),
      );
    }

    const { stdout: commitOutput } = await runProcessCapture({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: context.repoRoot,
      timeoutMs: 10_000,
    });
    const commit = commitOutput.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error(`Git returned an invalid source commit: ${commit}`);
    }
    await fs.writeFile(
      path.join(temporary, "BUILD-PROVENANCE.txt"),
      `buildType=${context.buildType}\nplatform=${context.platform}\narch=${context.arch}\nsource=${commit}\nelectronE2e=${electronE2e}\n`,
    );

    const fontCommand = [
      path.join(
        context.repoRoot,
        "build",
        "scripts",
        "fonts",
        "client-font-assets.mjs",
      ),
      "copy",
      "--target-root",
      path.join(temporary, "resources", "web-static"),
    ];
    await runProcess({
      command: process.execPath,
      args: fontCommand,
      cwd: context.repoRoot,
    });

    await replaceDirectoryAtomically(temporary, context.stageAppDir);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

writePackagingEvent({
  phase: "electron-packager",
  status: "start",
  target: `${context.platform}/${context.arch}`,
});
try {
  await buildInputs();
  await createStage();
  const { digest } = await assertStageLayout(
    context.stageAppDir,
    context.repoRoot,
  );
  await packageElectronApplication({ context });
  writePackagingEvent({
    artifactPath: context.packagedAppDir,
    exitCode: 0,
    phase: "electron-packager",
    status: "complete",
    target: `${context.platform}/${context.arch}`,
  });
  console.log(`Electron stage ${digest} packaged from ${context.stageAppDir}`);
} catch (error) {
  writePackagingEvent({
    exitCode: 1,
    phase: "electron-packager",
    status: "failed",
    target: `${context.platform}/${context.arch}`,
  });
  throw error;
}
