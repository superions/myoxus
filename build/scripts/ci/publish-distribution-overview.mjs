#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const FORGEJO_ORIGIN = "https://git.blume29.de";
const SOURCE_REPOSITORY = "myoxus/myoxus";
const archivedReservations = JSON.parse(
  fs.readFileSync(
    new URL("../release/archived-release-reservations.json", import.meta.url),
    "utf8",
  ),
);
const archivedCommits = new Set(
  Object.values(archivedReservations.components).flatMap((component) =>
    Object.values(component),
  ),
);
const TARGET_OWNER = "myoxus";
const TARGET_REPOSITORY = "packages";
const TARGET_BRANCH = "main";
const TARGET_PATH = "DISTRIBUTION.md";
const CONTENTS_API = `/api/v1/repos/${TARGET_OWNER}/${TARGET_REPOSITORY}/contents/${TARGET_PATH}`;
const SCHEMA = "myoxus.distribution-overview.v1";
const STATE_MARKER = "myoxus-distribution-state";
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CONTAINER_IMAGES = {
  server: ["myoxus"],
  frontends: ["myoxus-admin-frontend", "myoxus-web-frontend"],
};
const CLIENT_SCOPES = new Set(["linux", "windows", "macos", "full"]);

function emptyState() {
  return {
    schema: SCHEMA,
    updatedAt: null,
    containers: { server: null, frontends: null },
    clients: { linux: null, windows: null, macos: null, full: null },
  };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || args.has(key)) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    args.set(key, value);
  }
  return args;
}

function required(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function stableParts(version) {
  if (typeof version !== "string") return null;
  const match = version.match(STABLE_VERSION);
  return match ? match.slice(1).map(BigInt) : null;
}

function compareStableVersions(left, right) {
  const a = stableParts(left);
  const b = stableParts(right);
  if (!a || !b)
    throw new Error("Distribution overview accepts stable versions only");
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function canonicalEntry(entry) {
  if (!entry) return entry;
  const copy = structuredClone(entry);
  delete copy.updatedAt;
  return copy;
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function assertContainerEntry(component, entry) {
  if (entry === null) return;
  const expectedImages = CONTAINER_IMAGES[component];
  if (
    !stableParts(entry?.version ?? "") ||
    !SHA.test(entry?.sourceCommit ?? "") ||
    !isTimestamp(entry?.updatedAt) ||
    !Array.isArray(entry?.artifacts)
  ) {
    throw new Error(
      `Public distribution overview has invalid containers.${component}`,
    );
  }
  const actualImages = entry.artifacts.map(({ image }) => image).sort();
  if (
    JSON.stringify(actualImages) !== JSON.stringify(expectedImages) ||
    entry.artifacts.some(
      ({ image, digest }) =>
        typeof image !== "string" || !DIGEST.test(digest ?? ""),
    )
  ) {
    throw new Error(
      `Public distribution overview has invalid containers.${component}`,
    );
  }
}

function assertClientEntry(scope, entry) {
  if (entry === null) return;
  const expectedTag = desktopReleaseIdentity(scope, entry?.version);
  const expectedUrl = `${FORGEJO_ORIGIN}/${TARGET_OWNER}/${TARGET_REPOSITORY}/releases/tag/${expectedTag}`;
  if (
    !stableParts(entry?.version ?? "") ||
    !SHA.test(entry?.sourceCommit ?? "") ||
    !isTimestamp(entry?.updatedAt) ||
    entry?.releaseTag !== expectedTag ||
    entry?.releaseUrl !== expectedUrl ||
    !Array.isArray(entry?.artifacts) ||
    entry.artifacts.length === 0 ||
    entry.artifacts.some(
      ({ name, sha256, signature }) =>
        typeof name !== "string" ||
        name !== name.split(/[\\/]/).at(-1) ||
        !/^[a-f0-9]{64}$/.test(sha256 ?? "") ||
        !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(signature ?? ""),
    )
  ) {
    throw new Error(
      `Public distribution overview has invalid clients.${scope}`,
    );
  }
}

function assertState(state) {
  if (
    !state ||
    state.schema !== SCHEMA ||
    !state.containers ||
    typeof state.containers !== "object" ||
    !state.clients ||
    typeof state.clients !== "object" ||
    (state.updatedAt !== null && !isTimestamp(state.updatedAt))
  ) {
    throw new Error("Public distribution overview has an unsupported schema");
  }
  for (const key of Object.keys(CONTAINER_IMAGES)) {
    if (!(key in state.containers)) {
      throw new Error(
        `Public distribution overview is missing containers.${key}`,
      );
    }
    assertContainerEntry(key, state.containers[key]);
  }
  for (const key of CLIENT_SCOPES) {
    if (!(key in state.clients)) {
      throw new Error(`Public distribution overview is missing clients.${key}`);
    }
    assertClientEntry(key, state.clients[key]);
  }
  return state;
}

export function parseDistributionOverview(source) {
  const expression = new RegExp(
    `<!-- ${STATE_MARKER}\\n([\\s\\S]*?)\\n-->`,
    "g",
  );
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    throw new Error("Public distribution overview has no unique state marker");
  }
  return assertState(JSON.parse(matches[0][1]));
}

function markdownLink(label, url) {
  return `[${label}](${url})`;
}

function sourceLink(commit) {
  const repository = archivedCommits.has(commit)
    ? archivedReservations.sourceRepository
    : SOURCE_REPOSITORY;
  return markdownLink(
    commit.slice(0, 12),
    `${FORGEJO_ORIGIN}/${repository}/commit/${commit}`,
  );
}

function renderContainerRows(state) {
  const rows = [];
  for (const [component, label] of [
    ["server", "Server"],
    ["frontends", "Web/Admin"],
  ]) {
    const entry = state.containers[component];
    if (!entry) continue;
    const coordinates = entry.artifacts
      .map(
        ({ image, digest }) =>
          `\`${FORGEJO_ORIGIN.replace("https://", "")}/${TARGET_OWNER}/${image}:${entry.version}\`<br>\`${digest}\``,
      )
      .join("<br>");
    rows.push(
      `| ${label} OCI | \`${entry.version}\` | ${sourceLink(entry.sourceCommit)} | ${coordinates} |`,
    );
  }
  return rows;
}

function renderClientRows(state) {
  const labels = {
    linux: "Linux client",
    windows: "Windows client",
    macos: "macOS client",
    full: "Signed desktop bundle",
  };
  const rows = [];
  for (const scope of CLIENT_SCOPES) {
    const entry = state.clients[scope];
    if (!entry) continue;
    const signatures = [
      ...new Set(entry.artifacts.map((artifact) => artifact.signature)),
    ]
      .sort()
      .join(", ");
    rows.push(
      `| ${labels[scope]} | \`${entry.version}\` | ${sourceLink(entry.sourceCommit)} | ${markdownLink(entry.releaseTag, entry.releaseUrl)} (${entry.artifacts.length} packages; ${signatures}) |`,
    );
  }
  return rows;
}

export function renderDistributionOverview(state) {
  assertState(state);
  const rows = [...renderContainerRows(state), ...renderClientRows(state)];
  return [
    "# Myoxus Distribution Overview",
    "",
    "This file is updated automatically after a successful stable publication.",
    "Container images remain in the OCI registry and desktop binaries remain in",
    "Forgejo Releases; this overview links both without copying or rebuilding them.",
    "",
    "Server/frontends and desktop clients are independent release trains. The table",
    "shows the newest successfully published stable entry for each owning component;",
    "it does not invent a cross-version compatibility guarantee.",
    "",
    "| Component | Version | Source | Published artifact |",
    "| --- | --- | --- | --- |",
    ...(rows.length
      ? rows
      : ["| _No stable artifacts recorded_ | - | - | - |"]),
    "",
    "## Machine-readable state",
    "",
    "The embedded state is the canonical input for the next atomic update.",
    "",
    `<!-- ${STATE_MARKER}`,
    JSON.stringify(state, null, 2),
    "-->",
    "",
  ].join("\n");
}

function mergeEntry(state, group, key, incoming, now) {
  const current = state[group][key];
  if (current) {
    const comparison = compareStableVersions(incoming.version, current.version);
    if (comparison < 0)
      return { changed: false, reason: "newer entry already published" };
    if (comparison === 0) {
      if (
        JSON.stringify(canonicalEntry(current)) !==
        JSON.stringify(canonicalEntry(incoming))
      ) {
        throw new Error(
          `Public distribution overview conflicts at ${group}.${key} ${incoming.version}`,
        );
      }
      return { changed: false, reason: "identical entry already published" };
    }
  }
  state[group][key] = { ...incoming, updatedAt: now };
  state.updatedAt = now;
  return { changed: true, reason: "updated" };
}

function validateContainerEvidence({
  component,
  evidence,
  sourceCommit,
  version,
}) {
  const expectedImages = CONTAINER_IMAGES[component];
  if (!expectedImages)
    throw new Error("--component must be server or frontends");
  if (!stableParts(version)) return null;
  if (!SHA.test(sourceCommit))
    throw new Error("Container source commit is invalid");
  if (
    evidence?.schemaVersion !== 1 ||
    evidence.registryHost !== "git.blume29.de" ||
    evidence.owner !== TARGET_OWNER ||
    evidence.stage !== "promoted" ||
    !Array.isArray(evidence.packages)
  ) {
    throw new Error("Container promotion evidence is invalid");
  }
  const packages = [...evidence.packages].sort((left, right) =>
    left.image.localeCompare(right.image),
  );
  if (
    JSON.stringify(packages.map(({ image }) => image)) !==
    JSON.stringify(expectedImages)
  ) {
    throw new Error(`Container promotion evidence differs for ${component}`);
  }
  for (const pkg of packages) {
    if (
      pkg.commitTag !== sourceCommit ||
      pkg.promotionTag !== version ||
      !DIGEST.test(pkg.commitDigest) ||
      pkg.commitDigest !== pkg.promotionDigest
    ) {
      throw new Error(
        `Container promotion evidence is inconsistent for ${pkg.image}`,
      );
    }
  }
  return {
    version,
    sourceCommit,
    artifacts: packages.map((pkg) => ({
      image: pkg.image,
      digest: pkg.promotionDigest,
    })),
  };
}

function desktopReleaseIdentity(scope, version) {
  return scope === "full"
    ? `desktop-v${version}`
    : `${scope}-client-v${version}`;
}

function validateDesktopManifest(manifest) {
  if (manifest?.channel !== "stable" || !stableParts(manifest?.version ?? "")) {
    return null;
  }
  if (
    manifest.schema !== "myoxus.desktop-release.v1" ||
    !CLIENT_SCOPES.has(manifest.scope) ||
    !SHA.test(manifest.sourceCommit ?? "") ||
    manifest.publishable !== true ||
    manifest.target?.owner !== TARGET_OWNER ||
    manifest.target?.repository !== TARGET_REPOSITORY ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0
  ) {
    throw new Error(
      "Desktop release manifest is invalid for the public overview",
    );
  }
  const releaseTag = desktopReleaseIdentity(manifest.scope, manifest.version);
  return {
    scope: manifest.scope,
    entry: {
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
      releaseTag,
      releaseUrl: `${FORGEJO_ORIGIN}/${TARGET_OWNER}/${TARGET_REPOSITORY}/releases/tag/${releaseTag}`,
      artifacts: manifest.artifacts
        .map((artifact) => {
          if (
            typeof artifact.name !== "string" ||
            !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") ||
            typeof artifact.signature?.status !== "string" ||
            typeof artifact.signature?.verifier !== "string"
          ) {
            throw new Error(
              "Desktop release manifest contains invalid artifact evidence",
            );
          }
          return {
            name: artifact.name,
            sha256: artifact.sha256,
            signature: `${artifact.signature.status}/${artifact.signature.verifier}`,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    },
  };
}

function authHeaders(token, json = false) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function readRemoteOverview({ fetchImpl, token = null }) {
  const response = await fetchImpl(
    `${FORGEJO_ORIGIN}${CONTENTS_API}?ref=${TARGET_BRANCH}`,
    {
      headers: token ? authHeaders(token) : { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return { sha: null, state: emptyState() };
  if (response.status !== 200) {
    throw new Error(
      `Public distribution overview lookup failed with HTTP ${response.status}`,
    );
  }
  const document = await response.json();
  if (
    typeof document?.sha !== "string" ||
    document.encoding !== "base64" ||
    typeof document.content !== "string"
  ) {
    throw new Error("Forgejo returned malformed distribution overview content");
  }
  return {
    sha: document.sha,
    state: parseDistributionOverview(
      Buffer.from(document.content.replaceAll("\n", ""), "base64").toString(
        "utf8",
      ),
    ),
  };
}

async function writeRemoteOverview({ fetchImpl, sha, source, token }) {
  const response = await fetchImpl(`${FORGEJO_ORIGIN}${CONTENTS_API}`, {
    method: "PUT",
    headers: authHeaders(token, true),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      branch: TARGET_BRANCH,
      content: Buffer.from(source).toString("base64"),
      message: "chore(release): update distribution overview",
      ...(sha ? { sha } : {}),
    }),
  });
  if ([200, 201].includes(response.status)) return "written";
  if (response.status === 409) return "retry";
  const detail = (await response.text()).slice(0, 300);
  if (response.status === 422 && /sha|conflict|match/i.test(detail))
    return "retry";
  throw new Error(
    `Public distribution overview update failed with HTTP ${response.status}: ${detail}`,
  );
}

async function publishUpdate({
  fetchImpl = fetch,
  token,
  update,
  now = () => new Date(),
}) {
  if (typeof token !== "string" || token.length < 16 || /\s/.test(token)) {
    throw new Error(
      "MYOXUS_RELEASE_TOKEN is required for distribution publication",
    );
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const remote = await readRemoteOverview({ fetchImpl, token });
    const state = structuredClone(remote.state);
    const timestamp = now().toISOString();
    const result = update(state, timestamp);
    if (!result.changed) return result;
    const outcome = await writeRemoteOverview({
      fetchImpl,
      sha: remote.sha,
      source: renderDistributionOverview(state),
      token,
    });
    if (outcome === "written") return result;
  }
  throw new Error(
    "Public distribution overview changed concurrently too often",
  );
}

export async function publishContainerDistributionOverview({
  component,
  evidence,
  fetchImpl = fetch,
  now,
  sourceCommit,
  token,
  version,
}) {
  const entry = validateContainerEvidence({
    component,
    evidence,
    sourceCommit,
    version,
  });
  if (!entry) return { changed: false, reason: "prerelease overview skipped" };
  return publishUpdate({
    fetchImpl,
    token,
    now,
    update: (state, timestamp) =>
      mergeEntry(state, "containers", component, entry, timestamp),
  });
}

export async function publishDesktopDistributionOverview({
  fetchImpl = fetch,
  manifest,
  now,
  token,
}) {
  const release = validateDesktopManifest(manifest);
  if (!release)
    return { changed: false, reason: "non-stable overview skipped" };
  return publishUpdate({
    fetchImpl,
    token,
    now,
    update: (state, timestamp) =>
      mergeEntry(state, "clients", release.scope, release.entry, timestamp),
  });
}

function overviewEntryAtLeast(entry, version, sourceCommit = null) {
  if (!entry || compareStableVersions(entry.version, version) < 0) return false;
  if (entry.version !== version || !sourceCommit) return true;
  return entry.sourceCommit === sourceCommit;
}

export async function waitForDistributionOverview({
  clients = [],
  containers = null,
  fetchImpl = fetch,
  pollSeconds = 5,
  sourceCommit = null,
  version,
  waitSeconds = 0,
}) {
  if (!stableParts(version)) return;
  const started = Date.now();
  while (true) {
    const { state } = await readRemoteOverview({ fetchImpl });
    let matches = clients.every((scope) =>
      overviewEntryAtLeast(state.clients[scope], version, sourceCommit),
    );
    if (containers) {
      const { serverCommit, frontendCommit, digests } = containers;
      const server = state.containers.server;
      const frontends = state.containers.frontends;
      matches =
        matches &&
        overviewEntryAtLeast(server, version, serverCommit) &&
        overviewEntryAtLeast(frontends, version, frontendCommit);
      if (matches && server?.version === version) {
        matches = server.artifacts[0]?.digest === digests.server;
      }
      if (matches && frontends?.version === version) {
        const actual = Object.fromEntries(
          frontends.artifacts.map(({ image, digest }) => [image, digest]),
        );
        matches =
          actual["myoxus-web-frontend"] === digests.web &&
          actual["myoxus-admin-frontend"] === digests.admin;
      }
    }
    if (matches) return;
    if (Date.now() - started >= waitSeconds * 1000) {
      throw new Error(
        "Public distribution overview has not reached the verified release",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "publish-containers") {
    const token = process.env.MYOXUS_RELEASE_TOKEN;
    delete process.env.MYOXUS_RELEASE_TOKEN;
    const result = await publishContainerDistributionOverview({
      component: required(args, "--component"),
      evidence: JSON.parse(
        fs.readFileSync(required(args, "--evidence"), "utf8"),
      ),
      sourceCommit: required(args, "--source-commit"),
      token,
      version: required(args, "--version"),
    });
    console.log(`[PASS] distribution overview: ${result.reason}`);
    return;
  }
  if (command === "verify-containers") {
    const waitSeconds = Number(args.get("--wait-seconds") ?? "0");
    const pollSeconds = Number(args.get("--poll-seconds") ?? "5");
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0) {
      throw new Error("--wait-seconds must be a non-negative integer");
    }
    if (!Number.isInteger(pollSeconds) || pollSeconds <= 0) {
      throw new Error("--poll-seconds must be a positive integer");
    }
    await waitForDistributionOverview({
      version: required(args, "--version"),
      waitSeconds,
      pollSeconds,
      containers: {
        serverCommit: required(args, "--server-commit"),
        frontendCommit: required(args, "--frontend-commit"),
        digests: {
          server: required(args, "--server-digest"),
          web: required(args, "--web-digest"),
          admin: required(args, "--admin-digest"),
        },
      },
    });
    console.log(
      "[PASS] public distribution overview contains the container release",
    );
    return;
  }
  throw new Error(
    "Usage: publish-distribution-overview.mjs publish-containers|verify-containers [options]",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[FAIL] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
