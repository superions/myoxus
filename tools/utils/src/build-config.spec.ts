import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { verifyBuiltReleaseIdentity } from "../../../build/scripts/ci/verify-built-release-identity.mjs";
import {
  createReleaseIdentity,
  resolveDeclaredReleaseVersion,
  resolveReleaseIdentity,
  writeReleaseIdentity,
} from "../../../build/scripts/release/write-release-identity.mjs";
import { getBuildConfig } from "./build-config";
import { PUBLIC_PROJECT_URLS } from "./public-urls";
import { Package, Workspace } from "./workspace";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("client build identity", () => {
  test("writes deterministic release identities from authoritative sources", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "myoxus-release-id-"));
    temporaryDirectories.push(repoRoot);
    mkdirSync(join(repoRoot, "server"));
    writeFileSync(
      join(repoRoot, "package.json"),
      JSON.stringify({ version: "0.38.0" }),
    );
    writeFileSync(
      join(repoRoot, "server/Cargo.toml"),
      '[workspace.package]\nversion = "0.39.0"\nedition = "2024"\n',
    );

    expect(resolveDeclaredReleaseVersion({ repoRoot, role: "web" })).toBe(
      "0.38.0",
    );
    expect(resolveDeclaredReleaseVersion({ repoRoot, role: "server" })).toBe(
      "0.39.0",
    );
    expect(() =>
      resolveReleaseIdentity({
        expectedVersion: "0.36.0",
        repoRoot,
        revision: "a".repeat(40),
        role: "web",
      }),
    ).toThrow(/0\.36\.0.*authoritative source 0\.38\.0/);

    const identity = createReleaseIdentity({
      role: "web",
      version: "0.38.0",
      revision: "a".repeat(40),
    });
    const outputPath = join(repoRoot, "release.json");
    writeReleaseIdentity({ identity, outputPath });
    const first = readFileSync(outputPath, "utf8");
    writeReleaseIdentity({ identity, outputPath });

    expect(readFileSync(outputPath, "utf8")).toBe(first);
    expect(JSON.parse(first)).toEqual(identity);
    expect(() =>
      createReleaseIdentity({
        role: "admin",
        version: "0.38.0",
        revision: "branch-name",
      }),
    ).toThrow(/full commit SHA or localdev/);
  });

  test("projects the root product version into Web despite package-local drift", () => {
    const workspace = new Workspace();
    const distributionPackage = workspace.getPackage("@myoxus/web");

    // Model the exact release regression independently of current manifests so
    // future version bumps or package cleanup cannot make the test vacuous.
    Object.defineProperty(workspace.packageJson, "version", {
      configurable: true,
      value: "0.38.0",
    });
    Object.defineProperty(distributionPackage.packageJson, "version", {
      configurable: true,
      value: "0.36.0",
    });

    expect(workspace.version).toBe("0.38.0");
    expect(distributionPackage.packageJson.version).toBe("0.36.0");

    const config = getBuildConfig(distributionPackage, {
      channel: "stable",
      mode: "production",
    });

    expect(config.appVersion).toBe("0.38.0");
    expect(config.editorVersion).toBe("0.38.0");
  });

  test("projects the independent Electron product version into desktop bundles", () => {
    const workspace = new Workspace();
    const electronPackage = workspace.getPackage("@myoxus/electron");

    Object.defineProperty(workspace.packageJson, "version", {
      configurable: true,
      value: "0.41.7",
    });
    Object.defineProperty(electronPackage.packageJson, "version", {
      configurable: true,
      value: "0.42.0",
    });

    const config = getBuildConfig(electronPackage, {
      channel: "stable",
      mode: "production",
    });

    expect(config.appVersion).toBe("0.42.0");
    expect(config.editorVersion).toBe("0.42.0");
  });

  test("projects truthful public navigation from the shared URL owner", () => {
    const workspace = new Workspace();
    const config = getBuildConfig(workspace.getPackage("@myoxus/web"), {
      channel: "stable",
      mode: "production",
    });

    expect(config).toMatchObject({
      changelogUrl: PUBLIC_PROJECT_URLS.releases,
      docsUrl: PUBLIC_PROJECT_URLS.documentation,
      downloadUrl: PUBLIC_PROJECT_URLS.downloads,
      githubUrl: PUBLIC_PROJECT_URLS.repository,
      licenseUrl: PUBLIC_PROJECT_URLS.license,
      releaseNotesUrl: PUBLIC_PROJECT_URLS.releases,
      securityUrl: PUBLIC_PROJECT_URLS.security,
      websiteUrl: PUBLIC_PROJECT_URLS.repository,
    });
  });

  test("rejects packages that are not bound to a workspace", () => {
    expect(() =>
      getBuildConfig(new Package("@myoxus/web"), {
        channel: "stable",
        mode: "production",
      }),
    ).toThrow(/not bound to a Workspace.*Workspace#getPackage/);
  });

  test("accepts only emitted config and workers with the root version", () => {
    const buildDirectory = mkdtempSync(join(tmpdir(), "myoxus-build-id-"));
    temporaryDirectories.push(buildDirectory);
    mkdirSync(join(buildDirectory, "js"));
    writeFileSync(
      join(buildDirectory, "assets-manifest.json"),
      JSON.stringify({ js: ["js/index.js"] }),
    );
    writeFileSync(
      join(buildDirectory, "js/index.js"),
      'const config={appVersion:"0.38.0",editorVersion:"0.38.0"};',
    );
    writeFileSync(join(buildDirectory, "js/storage-0.38.0.worker.js"), "");

    const revision = "a".repeat(40);
    const releaseIdentity = createReleaseIdentity({
      role: "web",
      version: "0.38.0",
      revision,
    });
    const imageLabels = {
      "org.opencontainers.image.title": "Myoxus Web static artifact",
      "org.opencontainers.image.version": "0.38.0",
      "org.opencontainers.image.revision": revision,
      "org.opencontainers.image.source": "https://github.com/superions/myoxus",
    };

    expect(
      verifyBuiltReleaseIdentity({
        buildDirectory,
        distributionVersion: "0.36.0",
        imageLabels,
        releaseIdentity,
        revision,
        rootVersion: "0.38.0",
      }).storageWorker,
    ).toBe("js/storage-0.38.0.worker.js");

    const mismatchedWorker = join(
      buildDirectory,
      "js/storage-0.36.0.worker.js",
    );
    writeFileSync(mismatchedWorker, "");

    expect(() =>
      verifyBuiltReleaseIdentity({
        buildDirectory,
        distributionVersion: "0.36.0",
        rootVersion: "0.38.0",
      }),
    ).toThrow(/worker version mismatch/);

    rmSync(mismatchedWorker);
    writeFileSync(
      join(buildDirectory, "js/index.js"),
      'const config={appVersion:"0.36.0",editorVersion:"0.36.0"};',
    );

    expect(() =>
      verifyBuiltReleaseIdentity({
        buildDirectory,
        distributionVersion: "0.36.0",
        rootVersion: "0.38.0",
      }),
    ).toThrow(/identity mismatch/);
  });

  test("rejects release metadata drift and generic OCI license claims", () => {
    const buildDirectory = mkdtempSync(join(tmpdir(), "myoxus-release-meta-"));
    temporaryDirectories.push(buildDirectory);
    mkdirSync(join(buildDirectory, "js"));
    writeFileSync(
      join(buildDirectory, "assets-manifest.json"),
      JSON.stringify({ js: ["js/index.js"] }),
    );
    writeFileSync(
      join(buildDirectory, "js/index.js"),
      'const config={appVersion:"0.38.0",editorVersion:"0.38.0"};',
    );
    writeFileSync(join(buildDirectory, "js/storage-0.38.0.worker.js"), "");
    const revision = "b".repeat(40);
    const releaseIdentity = createReleaseIdentity({
      role: "web",
      version: "0.38.0",
      revision,
    });

    expect(() =>
      verifyBuiltReleaseIdentity({
        buildDirectory,
        distributionVersion: "0.36.0",
        releaseIdentity: { ...releaseIdentity, revision: "c".repeat(40) },
        revision,
        rootVersion: "0.38.0",
      }),
    ).toThrow(/release\.json revision mismatch/);

    expect(() =>
      verifyBuiltReleaseIdentity({
        buildDirectory,
        distributionVersion: "0.36.0",
        imageLabels: {
          "org.opencontainers.image.title": "Myoxus Web static artifact",
          "org.opencontainers.image.version": "0.38.0",
          "org.opencontainers.image.revision": revision,
          "org.opencontainers.image.source":
            "https://github.com/superions/myoxus",
          "org.opencontainers.image.licenses": "AGPL-3.0-or-later",
        },
        revision,
        rootVersion: "0.38.0",
      }),
    ).toThrow(/must not declare.*licenses/);
  });
});
