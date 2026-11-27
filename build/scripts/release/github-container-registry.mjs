// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const images = {
  server: "myoxus",
  web: "myoxus-web-frontend",
  admin: "myoxus-admin-frontend",
};
const forgejo = "git.blume29.de/myoxus";
const github = "ghcr.io/superions";
const githubRepository = "superions/myoxus";
const digestPattern = "sha256:[0-9a-f]{64}";
const sha256Pattern = /^[0-9a-f]{64}$/;
const assetIdPattern = /^[1-9]\d*$/;

export function githubContainers(containers) {
  if (!containers.length) return [];
  if (containers.length !== Object.keys(images).length)
    throw new Error("Expected the complete Server, Web and Admin image set");
  return Object.entries(images).map(([role, image]) => {
    const source = containers.find((entry) => entry.role === role)?.coordinate;
    const digest = source?.split("@").at(-1);
    if (
      !new RegExp(`^${digestPattern}$`).test(digest) ||
      source !== `${forgejo}/${image}@${digest}`
    )
      throw new Error(`Expected the exact accepted Forgejo digest for ${role}`);
    return { role, image, source, digest, target: `${github}/${image}` };
  });
}

export function githubContainerLine({ role, image, target, digest }) {
  return `- ${role}: \`${target}@${digest}\` ([Package](https://github.com/users/superions/packages/container/package/${image}))`;
}

export function containersFromRelease(body) {
  return Object.entries(images).map(([role, image]) => {
    const lines = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`- ${role}: `));
    const match = lines[0]?.match(
      new RegExp(`^- ${role}: \`([^\`]+)@(${digestPattern})\``),
    );
    const source = match && `${forgejo}/${image}@${match[2]}`;
    const published =
      match &&
      githubContainerLine({
        role,
        image,
        target: `${github}/${image}`,
        digest: match[2],
      });
    if (
      lines.length !== 1 ||
      (lines[0] !== `- ${role}: \`${source}\`` && lines[0] !== published)
    )
      throw new Error(
        `Release must contain exactly one recognized ${role} image reference`,
      );
    return { role, coordinate: source, line: lines[0] };
  });
}

function releaseVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
    throw new Error("GHCR publication requires a complete release version");
}

function craneRunner(directory) {
  return (args) =>
    execFileSync("crane", args, {
      env: {
        ...process.env,
        GHCR_TOKEN: "",
        GITHUB_RELEASE_TOKEN: "",
        DOCKER_CONFIG: directory,
      },
      encoding: "utf8",
      timeout: 1_200_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
}

function withCrane(auth, work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-ghcr-"));
  try {
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify(auth ? { auths: { "ghcr.io": { auth } } } : {}),
      { mode: 0o600 },
    );
    return work(craneRunner(directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function withCraneAsync(auth, work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-ghcr-"));
  try {
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify(auth ? { auths: { "ghcr.io": { auth } } } : {}),
      { mode: 0o600 },
    );
    return await work(craneRunner(directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function hashFile(filePath) {
  const sha = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) sha.update(chunk);
  return sha.digest("hex");
}

function assertSingleOciManifest(ociDir, expectedDigest) {
  const index = JSON.parse(
    fs.readFileSync(path.join(ociDir, "index.json"), "utf8"),
  );
  if (
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1 ||
    index.manifests[0]?.digest !== expectedDigest
  )
    throw new Error(
      `OCI layout manifest differs from accepted digest ${expectedDigest}`,
    );
}

export function missingGithubContainers(containers, version) {
  releaseVersion(version);
  return withCrane(undefined, (run) =>
    containers.filter((entry) => {
      try {
        return run(["digest", `${entry.target}:${version}`]) !== entry.digest;
      } catch {
        return true;
      }
    }),
  );
}

export async function exportContainerOciTar(container, tarPath) {
  const ociDir = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-oci-export-"));
  try {
    withCrane(undefined, (run) => {
      run(["pull", "--format=oci", container.source, ociDir]);
    });
    assertSingleOciManifest(ociDir, container.digest);
    execFileSync("tar", ["-cf", tarPath, "-C", ociDir, "."], {
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      size: fs.statSync(tarPath).size,
      sha256: await hashFile(tarPath),
    };
  } finally {
    fs.rmSync(ociDir, { recursive: true, force: true });
  }
}

export function verifyGithubContainers(containers, version) {
  releaseVersion(version);
  withCrane(undefined, (run) => {
    for (const { target, digest } of containers) {
      const tag = `${target}:${version}`;
      try {
        if (run(["digest", tag]) !== digest)
          throw new Error("Tag digest mismatch");
        run(["manifest", `${target}@${digest}`]);
      } catch (error) {
        throw new Error(
          `GHCR package ${tag} must resolve publicly to ${digest}`,
          { cause: error },
        );
      }
    }
  });
}

function downloadStagedOciAsset(assetId, token, tarPath) {
  if (!assetIdPattern.test(assetId))
    throw new Error(`Invalid staged OCI asset ID: ${assetId}`);
  if (!/^[\w.-]+$/.test(token))
    throw new Error("Invalid GitHub Actions token format");
  const url = `https://api.github.com/repos/${githubRepository}/releases/assets/${assetId}`;
  const curlConfig = [
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/octet-stream"',
    'header = "X-GitHub-Api-Version: 2022-11-28"',
    "",
  ].join("\n");
  execFileSync(
    "curl",
    [
      "--config",
      "-",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      "900",
      "-o",
      tarPath,
      url,
    ],
    {
      input: curlConfig,
      encoding: "utf8",
      timeout: 960_000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

async function pushFromStagedAsset(
  run,
  { role, digest, assetId, assetSha256 },
  tag,
  token,
) {
  if (!sha256Pattern.test(assetSha256 ?? ""))
    throw new Error(`Invalid staged OCI SHA-256 for ${role}`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-oci-stage-"));
  const tarPath = path.join(workDir, `${role}.tar`);
  const ociDir = path.join(workDir, "oci");
  fs.mkdirSync(ociDir, { recursive: true });
  try {
    downloadStagedOciAsset(assetId, token, tarPath);
    const actualSha256 = await hashFile(tarPath);
    if (actualSha256 !== assetSha256)
      throw new Error(`Staged OCI archive checksum differs for ${role}`);
    execFileSync(
      "tar",
      [
        "-xf",
        tarPath,
        "-C",
        ociDir,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      { timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    fs.rmSync(tarPath, { force: true });
    assertSingleOciManifest(ociDir, digest);
    run(["push", ociDir, tag]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function copyGithubContainers(containers, version, token) {
  releaseVersion(version);
  if (!token) throw new Error("The GitHub Actions package token is required");
  await withCraneAsync(
    Buffer.from(`superions:${token}`).toString("base64"),
    async (run) => {
      for (const entry of containers) {
        const { source, target, digest, assetId, assetSha256 } = entry;
        const tag = `${target}:${version}`;
        // Keep the complete manifest graph and refuse to replace a release tag.
        let current;
        try {
          current = run(["digest", tag]);
        } catch {
          if (assetId || assetSha256) {
            await pushFromStagedAsset(run, entry, tag, token);
          } else {
            run(["copy", "--no-clobber", "--jobs=4", source, tag]);
          }
          current = run(["digest", tag]);
        }
        if (current !== digest)
          throw new Error(
            `GHCR tag ${tag} differs from accepted digest ${digest}`,
          );
        // Check that the Actions job can authenticate for package writes on a
        // same-version retry, when no image needs to be uploaded.
        run(["auth", "token", "--push", target]);
      }
    },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const containers = githubContainers(
    Object.entries(images).map(([role, image]) => ({
      role,
      coordinate: `${forgejo}/${image}@${process.env[`${role.toUpperCase()}_DIGEST`]}`,
    })),
  ).map((entry) => ({
    ...entry,
    assetId: process.env[`${entry.role.toUpperCase()}_ASSET_ID`] || undefined,
    assetSha256:
      process.env[`${entry.role.toUpperCase()}_ASSET_SHA256`] || undefined,
  }));
  await copyGithubContainers(
    containers,
    process.env.RELEASE_VERSION,
    process.env.GHCR_TOKEN,
  );
}
