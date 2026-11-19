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

async function withCrane(auth, work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-ghcr-"));
  const config = path.join(directory, "config.json");
  const auths = auth ? { "ghcr.io": { auth } } : {};
  const writeConfig = () =>
    fs.writeFileSync(config, JSON.stringify({ auths }), { mode: 0o600 });
  try {
    writeConfig();
    return await work(
      (args) =>
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
      (registrytoken) => {
        auths["git.blume29.de"] = { registrytoken };
        writeConfig();
      },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function verifyGithubContainers(containers, version) {
  releaseVersion(version);
  await withCrane(undefined, (run) => {
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

async function forgejoPullToken(image) {
  const url = new URL("https://git.blume29.de/v2/token");
  url.searchParams.set("service", "container_registry");
  url.searchParams.set("scope", `repository:myoxus/${image}:pull`);
  const response = await fetch(url, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Forgejo pull token for ${image}: HTTP ${response.status}`);
  const { token } = await response.json();
  if (typeof token !== "string" || !/^[\w.-]+$/.test(token))
    throw new Error(`Invalid Forgejo pull token response for ${image}`);
  return token;
}

async function copyGithubContainers(containers, version, token) {
  releaseVersion(version);
  if (!token) throw new Error("The GitHub Actions package token is required");
  await withCrane(
    Buffer.from(`superions:${token}`).toString("base64"),
    async (run, setForgejoToken) => {
      for (const { image, source, target, digest } of containers) {
        const tag = `${target}:${version}`;
        // Keep the complete manifest graph and refuse to replace a release tag.
        let current;
        try {
          current = run(["digest", tag]);
        } catch {
          // Use only the public image's scoped pull grant, never a Forgejo PAT
          // or the wildcard scope returned in the authentication challenge.
          setForgejoToken(await forgejoPullToken(image));
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
  );
  await copyGithubContainers(
    containers,
    process.env.RELEASE_VERSION,
    process.env.GHCR_TOKEN,
  );
}
