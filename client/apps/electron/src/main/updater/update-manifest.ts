// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from "node:buffer";

import type { UpdateInfo } from "builder-util-runtime";
import { compare, parse as parseSemVer, rcompare } from "semver";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const FORGEJO_RELEASE_FEED =
  "https://git.blume29.de/api/v1/repos/myoxus/packages/releases?page=1&limit=50";

export type DesktopReleaseChannel = "beta" | "internal" | "stable";
export type DesktopUpdateTarget =
  | { platform: "darwin"; arch: "arm64" | "x64"; backend: "macos" }
  | { platform: "win32"; arch: "arm64" | "x64"; backend: "nsis" }
  | {
      platform: "linux";
      arch: "arm64" | "x64";
      backend: "deb" | "rpm";
    };

const releaseAssetSchema = z.object({
  name: z.string().min(1),
  browser_download_url: z.string().url(),
  size: z.number().int().nonnegative(),
});

const forgejoReleaseSchema = z.object({
  tag_name: z.string().min(1),
  name: z.string(),
  body: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().datetime(),
  assets: z.array(releaseAssetSchema),
});

const releaseListSchema = z.array(forgejoReleaseSchema);

const updateFileSchema = z.object({
  url: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().positive().optional(),
});

const updateManifestSchema = z.object({
  version: z.string().min(1),
  files: z.array(updateFileSchema).min(1),
  path: z.string().min(1).optional(),
  sha512: z.string().min(1).optional(),
  releaseDate: z.string().datetime().optional(),
});

export type ForgejoRelease = z.infer<typeof forgejoReleaseSchema>;
type UpdateManifest = z.infer<typeof updateManifestSchema>;

export class UpdateContractError extends Error {
  constructor(
    readonly code:
      | "ERR_UPDATE_ASSET_CONTRACT"
      | "ERR_UPDATE_FEED_CONTRACT"
      | "ERR_UPDATE_MANIFEST_CONTRACT"
      | "ERR_UPDATE_RELEASE_AMBIGUOUS"
      | "ERR_UPDATE_RELEASE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "UpdateContractError";
  }
}

function fail(code: UpdateContractError["code"], message: string): never {
  throw new UpdateContractError(code, message);
}

function channelOf(version: string): DesktopReleaseChannel | null {
  const parsed = parseSemVer(version);
  if (!parsed) return null;
  if (parsed.prerelease.length === 0) return "stable";

  const channel = parsed.prerelease[0];
  return channel === "beta" || channel === "internal" ? channel : null;
}

function versionFromReleaseTag(
  tag: string,
  target?: DesktopUpdateTarget,
): { priority: number; version: string } | null {
  const prefix = tag.startsWith("desktop-v")
    ? "desktop-v"
    : target?.platform === "linux" && tag.startsWith("linux-client-v")
      ? "linux-client-v"
      : target?.platform === "win32" && tag.startsWith("windows-client-v")
        ? "windows-client-v"
        : target?.platform === "darwin" && tag.startsWith("macos-client-v")
          ? "macos-client-v"
          : null;
  if (!prefix) return null;
  const version = tag.slice(prefix.length);
  const parsed = parseSemVer(version);
  return parsed && parsed.version === version
    ? { priority: prefix === "desktop-v" ? 0 : 1, version }
    : null;
}

function parseFeedRepository(feedUrl: URL) {
  const match = feedUrl.pathname.match(
    /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/releases$/,
  );
  if (!match || match[1] !== "myoxus" || match[2] !== "packages") {
    fail(
      "ERR_UPDATE_FEED_CONTRACT",
      `Update feed must target /api/v1/repos/myoxus/packages/releases, received ${feedUrl.pathname}`,
    );
  }
  if (feedUrl.protocol !== "https:") {
    fail(
      "ERR_UPDATE_FEED_CONTRACT",
      `Update feed must use HTTPS, received ${feedUrl.protocol}`,
    );
  }
  for (const key of feedUrl.searchParams.keys()) {
    if (key !== "page" && key !== "limit") {
      fail(
        "ERR_UPDATE_FEED_CONTRACT",
        `Unsupported Forgejo release-feed parameter: ${key}`,
      );
    }
  }
  return { origin: feedUrl.origin, owner: match[1], repo: match[2] };
}

export function parseReleasePayload(payload: string): ForgejoRelease[] {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (error) {
    fail(
      "ERR_UPDATE_FEED_CONTRACT",
      `Forgejo release feed is not valid JSON: ${String(error)}`,
    );
  }

  const result = releaseListSchema.safeParse(raw);
  if (!result.success) {
    fail(
      "ERR_UPDATE_FEED_CONTRACT",
      `Forgejo release feed does not match its public schema: ${result.error.message}`,
    );
  }
  return result.data;
}

function validateReleaseAssets(release: ForgejoRelease, feedUrl: URL): void {
  const repository = parseFeedRepository(feedUrl);
  const names = new Set<string>();

  for (const asset of release.assets) {
    if (names.has(asset.name)) {
      fail(
        "ERR_UPDATE_ASSET_CONTRACT",
        `Release ${release.tag_name} contains duplicate asset ${asset.name}`,
      );
    }
    names.add(asset.name);

    if (
      /^(?:RELEASES|Update\.exe)$/i.test(asset.name) ||
      /squirrel|\.nupkg$/i.test(asset.name)
    ) {
      fail(
        "ERR_UPDATE_ASSET_CONTRACT",
        `Release ${release.tag_name} contains forbidden Squirrel asset ${asset.name}`,
      );
    }

    const url = new URL(asset.browser_download_url);
    const expectedPath = `/${repository.owner}/${repository.repo}/releases/download/${release.tag_name}/${encodeURIComponent(asset.name)}`;
    if (
      url.protocol !== "https:" ||
      url.origin !== repository.origin ||
      url.pathname !== expectedPath ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      fail(
        "ERR_UPDATE_ASSET_CONTRACT",
        `Asset ${asset.name} is outside the canonical Forgejo release path`,
      );
    }
  }
}

export function selectForgejoRelease(
  payload: string,
  channel: DesktopReleaseChannel,
  feedUrl = new URL(FORGEJO_RELEASE_FEED),
  target?: DesktopUpdateTarget,
): ForgejoRelease {
  parseFeedRepository(feedUrl);
  const candidates = parseReleasePayload(payload)
    .flatMap((release) => {
      if (release.draft) return [];
      const identity = versionFromReleaseTag(release.tag_name, target);
      if (!identity || channelOf(identity.version) !== channel) return [];
      if (release.prerelease !== (channel !== "stable")) return [];
      return [{ release, ...identity }];
    })
    .sort(
      (left, right) =>
        rcompare(left.version, right.version) || right.priority - left.priority,
    );

  if (candidates.length === 0) {
    fail(
      "ERR_UPDATE_RELEASE_NOT_FOUND",
      `No valid ${channel} release exists in the Forgejo feed`,
    );
  }

  if (
    candidates.length > 1 &&
    compare(candidates[0].version, candidates[1].version) === 0 &&
    candidates[0].priority === candidates[1].priority
  ) {
    fail(
      "ERR_UPDATE_RELEASE_AMBIGUOUS",
      `Multiple Forgejo releases claim update version ${candidates[0].version}`,
    );
  }

  validateReleaseAssets(candidates[0].release, feedUrl);
  return candidates[0].release;
}

export function findUpdateManifestAsset(
  release: ForgejoRelease,
): ForgejoRelease["assets"][number] {
  const matches = release.assets.filter((asset) => asset.name === "latest.yml");
  if (matches.length !== 1) {
    fail(
      "ERR_UPDATE_ASSET_CONTRACT",
      `Release ${release.tag_name} must contain exactly one latest.yml asset`,
    );
  }
  return matches[0];
}

function parseManifest(payload: string): UpdateManifest {
  let raw: unknown;
  try {
    raw = parseYaml(payload);
  } catch (error) {
    fail(
      "ERR_UPDATE_MANIFEST_CONTRACT",
      `latest.yml is not valid YAML: ${String(error)}`,
    );
  }
  const result = updateManifestSchema.safeParse(raw);
  if (!result.success) {
    fail(
      "ERR_UPDATE_MANIFEST_CONTRACT",
      `latest.yml does not match the update schema: ${result.error.message}`,
    );
  }
  return result.data;
}

function validSha512(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  return Buffer.from(value, "base64").byteLength === 64;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ParsedArtifactName = {
  arch: "arm64" | "x64";
  format: "deb" | "dmg" | "exe" | "flatpak" | "rpm" | "zip";
  platform: "darwin" | "linux" | "win32";
};

function parseArtifactName(
  name: string,
  version: string,
  channel: DesktopReleaseChannel,
): ParsedArtifactName | null {
  const match = name.match(
    new RegExp(
      `^myoxus-${escapeRegExp(version)}-${channel}-(windows|macos|linux)-(x64|arm64)\\.(exe|dmg|zip|deb|rpm|flatpak)$`,
    ),
  );
  if (!match) return null;
  return {
    platform:
      match[1] === "windows"
        ? "win32"
        : match[1] === "macos"
          ? "darwin"
          : "linux",
    arch: match[2] as ParsedArtifactName["arch"],
    format: match[3] as ParsedArtifactName["format"],
  };
}

function targetMatches(
  artifact: ParsedArtifactName,
  target: DesktopUpdateTarget,
): boolean {
  if (artifact.platform !== target.platform || artifact.arch !== target.arch) {
    return false;
  }
  if (target.backend === "macos") return artifact.format === "zip";
  if (target.backend === "nsis") return artifact.format === "exe";
  return artifact.format === target.backend;
}

export type MyoxusUpdateInfo = UpdateInfo & { tag: string };

export function parseUpdateManifest(
  payload: string,
  release: ForgejoRelease,
  channel: DesktopReleaseChannel,
  target: DesktopUpdateTarget,
  feedUrl = new URL(FORGEJO_RELEASE_FEED),
): MyoxusUpdateInfo {
  validateReleaseAssets(release, feedUrl);
  const version = versionFromReleaseTag(release.tag_name, target)?.version;
  const manifest = parseManifest(payload);
  if (
    !version ||
    manifest.version !== version ||
    channelOf(version) !== channel
  ) {
    fail(
      "ERR_UPDATE_MANIFEST_CONTRACT",
      `Release tag ${release.tag_name} and latest.yml version ${manifest.version} disagree`,
    );
  }

  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const names = new Set<string>();
  const files = manifest.files.flatMap((file) => {
    if (names.has(file.url)) {
      fail(
        "ERR_UPDATE_MANIFEST_CONTRACT",
        `latest.yml contains duplicate file ${file.url}`,
      );
    }
    names.add(file.url);
    if (
      file.url !== encodeURI(file.url) ||
      file.url.includes("/") ||
      file.url.includes("\\")
    ) {
      fail(
        "ERR_UPDATE_MANIFEST_CONTRACT",
        `latest.yml file must be a plain release-asset name: ${file.url}`,
      );
    }
    if (!validSha512(file.sha512)) {
      fail(
        "ERR_UPDATE_MANIFEST_CONTRACT",
        `latest.yml file ${file.url} has an invalid SHA-512 digest`,
      );
    }
    const artifact = parseArtifactName(file.url, version, channel);
    if (!artifact) {
      fail(
        "ERR_UPDATE_MANIFEST_CONTRACT",
        `latest.yml file ${file.url} violates the desktop artifact naming contract`,
      );
    }
    const asset = assets.get(file.url);
    if (!asset) {
      fail(
        "ERR_UPDATE_ASSET_CONTRACT",
        `latest.yml references missing Forgejo asset ${file.url}`,
      );
    }
    if (file.size !== undefined && file.size !== asset.size) {
      fail(
        "ERR_UPDATE_ASSET_CONTRACT",
        `Size mismatch for Forgejo asset ${file.url}`,
      );
    }
    return targetMatches(artifact, target)
      ? [{ ...file, url: asset.browser_download_url }]
      : [];
  });

  if (files.length !== 1) {
    fail(
      "ERR_UPDATE_MANIFEST_CONTRACT",
      `latest.yml must resolve exactly one ${target.platform}/${target.arch}/${target.backend} update file`,
    );
  }

  return {
    tag: release.tag_name,
    version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: manifest.releaseDate ?? release.published_at,
    releaseName: release.name || version,
    releaseNotes: release.body,
  };
}
