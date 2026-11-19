// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { execFileSync } from "node:child_process";
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
const digestPattern = "sha256:[0-9a-f]{64}";

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

function withCrane(auth, work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-ghcr-"));
  try {
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify(auth ? { auths: { "ghcr.io": { auth } } } : {}),
      { mode: 0o600 },
    );
    return work((args) =>
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
      }).trim(),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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

function copyGithubContainers(containers, version, token) {
  releaseVersion(version);
  if (!token) throw new Error("The GitHub Actions package token is required");
  withCrane(Buffer.from(`superions:${token}`).toString("base64"), (run) => {
    for (const { source, target, digest } of containers) {
      const tag = `${target}:${version}`;
      // Keep the complete manifest graph and refuse to replace a release tag.
      let current;
      try {
        current = run(["digest", tag]);
      } catch {
        run(["copy", "--no-clobber", "--jobs=4", source, tag]);
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
  });
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
  );
  copyGithubContainers(
    containers,
    process.env.RELEASE_VERSION,
    process.env.GHCR_TOKEN,
  );
}
