// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from "node:buffer";

import type { AppUpdater } from "electron-updater";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { resolveDesktopUpdater } from "../../src/main/updater/desktop-updater-port";
import {
  findUpdateManifestAsset,
  FORGEJO_RELEASE_FEED,
  parseUpdateManifest,
  selectForgejoRelease,
  UpdateContractError,
} from "../../src/main/updater/update-manifest";

const sha512 = Buffer.alloc(64, 23).toString("base64");

function assetUrl(tag: string, name: string): string {
  return `https://git.blume29.de/myoxus/packages/releases/download/${tag}/${encodeURIComponent(name)}`;
}

function release(
  version: string,
  options: {
    draft?: boolean;
    prerelease?: boolean;
    files?: Array<{ name: string; size?: number }>;
    tag?: string;
  } = {},
) {
  const tag = options.tag ?? `desktop-v${version}`;
  const files = options.files ?? [
    { name: `myoxus-${version}-stable-windows-x64.exe` },
    { name: "latest.yml" },
  ];
  return {
    tag_name: tag,
    name: `Myoxus Desktop ${version}`,
    body: `Release ${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? version.includes("-"),
    published_at: "2026-07-22T00:00:00.000Z",
    assets: files.map(({ name, size = 1024 }) => ({
      name,
      size,
      browser_download_url: assetUrl(tag, name),
    })),
  };
}

function manifest(
  version: string,
  files: Array<{ name: string; size?: number; digest?: string }>,
): string {
  return stringify({
    version,
    files: files.map(({ name, size = 1024, digest = sha512 }) => ({
      url: name,
      sha512: digest,
      size,
    })),
    releaseDate: "2026-07-22T00:00:00.000Z",
  });
}

function expectContractError(
  action: () => unknown,
  code: UpdateContractError["code"],
): void {
  try {
    action();
    throw new Error("Expected update contract validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateContractError);
    expect((error as UpdateContractError).code).toBe(code);
  }
}

describe("Forgejo desktop release selection", () => {
  it("selects the highest matching version independently of API order", () => {
    const candidates = [
      release("0.42.0"),
      release("0.43.0-beta.1", { prerelease: true }),
      release("0.41.9"),
      release("0.44.0", { draft: true }),
      release("0.45.0-alpha.1", { prerelease: true }),
    ];

    for (const ordered of [
      candidates,
      [...candidates].reverse(),
      [
        candidates[2],
        candidates[0],
        candidates[4],
        candidates[1],
        candidates[3],
      ],
    ]) {
      expect(
        selectForgejoRelease(JSON.stringify(ordered), "stable").tag_name,
      ).toBe("desktop-v0.42.0");
      expect(
        selectForgejoRelease(JSON.stringify(ordered), "beta").tag_name,
      ).toBe("desktop-v0.43.0-beta.1");
    }
  });

  it("selects Linux-client releases only for Linux and prefers them at equal version", () => {
    const desktop = release("0.42.0");
    const linux = release("0.42.0", {
      files: [
        { name: "myoxus-0.42.0-stable-linux-x64.deb" },
        { name: "latest.yml" },
      ],
      tag: "linux-client-v0.42.0",
    });
    const target = {
      platform: "linux",
      arch: "x64",
      backend: "deb",
    } as const;

    expect(
      selectForgejoRelease(
        JSON.stringify([desktop, linux]),
        "stable",
        new URL(FORGEJO_RELEASE_FEED),
        target,
      ).tag_name,
    ).toBe("linux-client-v0.42.0");
    expect(
      selectForgejoRelease(JSON.stringify([linux, desktop]), "stable").tag_name,
    ).toBe("desktop-v0.42.0");
  });

  it("selects Windows-client releases only for Windows and prefers them at equal version", () => {
    const desktop = release("0.42.0");
    const windows = release("0.42.0", {
      files: [
        { name: "myoxus-0.42.0-stable-windows-x64.exe" },
        { name: "latest.yml" },
      ],
      tag: "windows-client-v0.42.0",
    });
    const target = {
      platform: "win32",
      arch: "x64",
      backend: "nsis",
    } as const;

    expect(
      selectForgejoRelease(
        JSON.stringify([desktop, windows]),
        "stable",
        new URL(FORGEJO_RELEASE_FEED),
        target,
      ).tag_name,
    ).toBe("windows-client-v0.42.0");
    expect(
      selectForgejoRelease(JSON.stringify([windows, desktop]), "stable")
        .tag_name,
    ).toBe("desktop-v0.42.0");
  });

  it("selects macOS-client releases for both Mac architectures without affecting other platforms", () => {
    const desktop = release("0.42.0");
    const macos = release("0.42.0", {
      files: [
        { name: "myoxus-0.42.0-stable-macos-x64.zip" },
        { name: "myoxus-0.42.0-stable-macos-arm64.zip" },
        { name: "latest.yml" },
      ],
      tag: "macos-client-v0.42.0",
    });
    for (const arch of ["x64", "arm64"] as const) {
      for (const rows of [
        [desktop, macos],
        [macos, desktop],
      ]) {
        expect(
          selectForgejoRelease(
            JSON.stringify(rows),
            "stable",
            new URL(FORGEJO_RELEASE_FEED),
            { platform: "darwin", arch, backend: "macos" },
          ).tag_name,
        ).toBe("macos-client-v0.42.0");
      }
    }
    for (const target of [
      { platform: "linux", arch: "x64", backend: "deb" },
      { platform: "win32", arch: "x64", backend: "nsis" },
    ] as const) {
      expect(
        selectForgejoRelease(
          JSON.stringify([macos, desktop]),
          "stable",
          new URL(FORGEJO_RELEASE_FEED),
          target,
        ).tag_name,
      ).toBe("desktop-v0.42.0");
    }
  });

  it("rejects ambiguous versions and malformed Forgejo payloads", () => {
    expectContractError(
      () =>
        selectForgejoRelease(
          JSON.stringify([release("0.42.0"), release("0.42.0")]),
          "stable",
        ),
      "ERR_UPDATE_RELEASE_AMBIGUOUS",
    );
    expectContractError(
      () => selectForgejoRelease(JSON.stringify({ releases: [] }), "stable"),
      "ERR_UPDATE_FEED_CONTRACT",
    );
  });

  it("pins the real repository path and Forgejo asset field", () => {
    const candidate = release("0.42.0");
    expect(findUpdateManifestAsset(candidate).browser_download_url).toBe(
      "https://git.blume29.de/myoxus/packages/releases/download/desktop-v0.42.0/latest.yml",
    );
    expectContractError(
      () =>
        selectForgejoRelease(
          JSON.stringify([candidate]),
          "stable",
          new URL(
            "https://git.blume29.de/api/v1/repos/Roekvar-Lab/affine-fork/releases",
          ),
        ),
      "ERR_UPDATE_FEED_CONTRACT",
    );
    expectContractError(
      () =>
        selectForgejoRelease(
          JSON.stringify([candidate]),
          "stable",
          new URL(`${FORGEJO_RELEASE_FEED}&channel=stable`),
        ),
      "ERR_UPDATE_FEED_CONTRACT",
    );
  });
});

describe("latest.yml contract", () => {
  const version = "0.42.0";
  const files = [
    { name: `myoxus-${version}-stable-windows-x64.exe` },
    { name: `myoxus-${version}-stable-windows-arm64.exe` },
    { name: `myoxus-${version}-stable-macos-x64.zip` },
    { name: `myoxus-${version}-stable-macos-x64.dmg` },
    { name: `myoxus-${version}-stable-macos-arm64.zip` },
    { name: `myoxus-${version}-stable-macos-arm64.dmg` },
    { name: `myoxus-${version}-stable-linux-x64.deb` },
    { name: `myoxus-${version}-stable-linux-x64.rpm` },
  ];
  const candidate = release(version, {
    files: [...files, { name: "latest.yml" }],
  });
  const payload = manifest(version, files);

  it.each([
    [{ platform: "win32", arch: "x64", backend: "nsis" }, ".exe"],
    [{ platform: "darwin", arch: "arm64", backend: "macos" }, ".zip"],
    [{ platform: "linux", arch: "x64", backend: "deb" }, ".deb"],
    [{ platform: "linux", arch: "x64", backend: "rpm" }, ".rpm"],
  ] as const)("resolves exactly one %o update asset", (target, extension) => {
    const parsed = parseUpdateManifest(payload, candidate, "stable", target);
    expect(parsed.version).toBe(version);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].url).toMatch(
      new RegExp(`${extension.replace(".", "\\.")}$`),
    );
    expect(parsed.files[0].sha512).toBe(sha512);
  });

  it("accepts the Linux-client tag for a matching Linux target", () => {
    const linuxCandidate = release(version, {
      files: [
        { name: `myoxus-${version}-stable-linux-x64.deb` },
        { name: `myoxus-${version}-stable-linux-x64.rpm` },
        { name: "latest.yml" },
      ],
      tag: `linux-client-v${version}`,
    });
    const linuxPayload = manifest(version, [
      { name: `myoxus-${version}-stable-linux-x64.deb` },
      { name: `myoxus-${version}-stable-linux-x64.rpm` },
    ]);

    expect(
      parseUpdateManifest(linuxPayload, linuxCandidate, "stable", {
        platform: "linux",
        arch: "x64",
        backend: "deb",
      }).tag,
    ).toBe(`linux-client-v${version}`);
  });

  it("accepts the Windows-client tag for a matching Windows target", () => {
    const windowsCandidate = release(version, {
      files: [
        { name: `myoxus-${version}-stable-windows-x64.exe` },
        { name: "latest.yml" },
      ],
      tag: `windows-client-v${version}`,
    });

    expect(
      parseUpdateManifest(
        manifest(version, [
          { name: `myoxus-${version}-stable-windows-x64.exe` },
        ]),
        windowsCandidate,
        "stable",
        { platform: "win32", arch: "x64", backend: "nsis" },
      ).tag,
    ).toBe(`windows-client-v${version}`);
  });

  it("rejects tag divergence, bad integrity, missing assets and duplicate files", () => {
    expectContractError(
      () =>
        parseUpdateManifest(manifest("0.42.1", files), candidate, "stable", {
          platform: "win32",
          arch: "x64",
          backend: "nsis",
        }),
      "ERR_UPDATE_MANIFEST_CONTRACT",
    );
    expectContractError(
      () =>
        parseUpdateManifest(
          manifest(version, [{ ...files[0], digest: "not-a-digest" }]),
          candidate,
          "stable",
          { platform: "win32", arch: "x64", backend: "nsis" },
        ),
      "ERR_UPDATE_MANIFEST_CONTRACT",
    );
    expectContractError(
      () =>
        parseUpdateManifest(
          manifest(version, [
            { name: `myoxus-${version}-stable-windows-x64.exe` },
            { name: `myoxus-${version}-stable-windows-x64.exe` },
          ]),
          candidate,
          "stable",
          { platform: "win32", arch: "x64", backend: "nsis" },
        ),
      "ERR_UPDATE_MANIFEST_CONTRACT",
    );
    expectContractError(
      () =>
        parseUpdateManifest(
          manifest(version, [
            { name: `myoxus-${version}-stable-linux-arm64.deb` },
          ]),
          candidate,
          "stable",
          { platform: "linux", arch: "arm64", backend: "deb" },
        ),
      "ERR_UPDATE_ASSET_CONTRACT",
    );
  });

  it("rejects every Squirrel release marker before selecting an installer", () => {
    for (const name of [
      "RELEASES",
      "Update.exe",
      "myoxus-0.42.0-full.nupkg",
      "squirrel.exe",
    ]) {
      const poisoned = release(version, {
        files: [...files, { name: "latest.yml" }, { name }],
      });
      expectContractError(
        () => selectForgejoRelease(JSON.stringify([poisoned]), "stable"),
        "ERR_UPDATE_ASSET_CONTRACT",
      );
    }
  });
});

describe("public updater backend selection", () => {
  const updater = {} as AppUpdater;
  const factories = {
    deb: vi.fn(() => updater),
    macos: vi.fn(() => updater),
    nsis: vi.fn(() => updater),
    rpm: vi.fn(() => updater),
  };

  it.each([
    ["darwin", null, {}, false, "macos"],
    ["win32", "nsis", {}, false, "nsis"],
    ["linux", "deb", {}, false, "deb"],
    ["linux", "rpm", {}, false, "rpm"],
  ] as const)(
    "selects the public %s backend without private updater classes",
    (platform, packageMarker, environment, flatpakInfoExists, backend) => {
      const result = resolveDesktopUpdater(
        {
          platform,
          arch: "x64",
          packageMarker,
          environment,
          flatpakInfoExists,
        },
        factories,
      );
      expect(result.state).toBe("enabled");
      if (result.state === "enabled") {
        expect(result.target.backend).toBe(backend);
      }
    },
  );

  it.each([
    ["win32", null, {}, false, "portable"],
    ["linux", null, {}, false, "missing-package-marker"],
    [
      "linux",
      "flatpak",
      { FLATPAK_ID: "org.myoxus.Myoxus" },
      false,
      "externally-managed",
    ],
    ["linux", "deb", {}, true, "externally-managed"],
    ["linux", "appimage", {}, false, "unsupported-package-marker"],
  ] as const)(
    "fails closed for %s/%s as %s",
    (platform, packageMarker, environment, flatpakInfoExists, reason) => {
      const result = resolveDesktopUpdater(
        {
          platform,
          arch: "x64",
          packageMarker,
          environment,
          flatpakInfoExists,
        },
        factories,
      );
      expect(result).toEqual({ state: "disabled", reason });
    },
  );
});

describe("complete paginated Forgejo inventory", () => {
  it("selects the highest release on a later page before requesting its manifest", async () => {
    const { MyoxusUpdateProvider } =
      await import("../../src/main/updater/myoxus-update-provider");
    const provider = new MyoxusUpdateProvider(
      MyoxusUpdateProvider.configFeed({
        channel: "stable",
        target: { platform: "win32", arch: "x64", backend: "nsis" },
      }),
      {} as never,
      { executor: {} } as never,
    );
    const request = vi
      .spyOn(provider as any, "httpRequest")
      .mockImplementation(async (url: any) => {
        if (url.pathname.endsWith("latest.yml"))
          return manifest("0.99.0", [
            { name: "myoxus-0.99.0-stable-windows-x64.exe" },
          ]);
        if (url.searchParams.get("page") === "1")
          return JSON.stringify(
            Array.from({ length: 50 }, () => release("0.42.0")),
          );
        return JSON.stringify([release("0.99.0")]);
      });
    await expect(provider.getLatestVersion()).resolves.toMatchObject({
      version: "0.99.0",
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("fails a broken later page rather than accepting the first page", async () => {
    const { MyoxusUpdateProvider } =
      await import("../../src/main/updater/myoxus-update-provider");
    const provider = new MyoxusUpdateProvider(
      MyoxusUpdateProvider.configFeed({
        channel: "stable",
        target: { platform: "win32", arch: "x64", backend: "nsis" },
      }),
      {} as never,
      { executor: {} } as never,
    );
    const request = vi
      .spyOn(provider as any, "httpRequest")
      .mockResolvedValueOnce(
        JSON.stringify(Array.from({ length: 50 }, () => release("0.42.0"))),
      )
      .mockResolvedValueOnce("invalid");
    await expect(provider.getLatestVersion()).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
