#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { waitForDistributionOverview } from "../ci/publish-distribution-overview.mjs";

const FORGEJO_URL = process.env.MYOXUS_FORGEJO_URL ?? "https://git.blume29.de";
const SOURCE_REPOSITORY = "myoxus/myoxus";
const RELEASE_REPOSITORY = "myoxus/packages";
const WORKFLOW = "release-desktop.yml";
const DEPENDENCY_WORKFLOW = "refresh-desktop-dependencies.yml";
export const PLATFORMS = ["linux", "windows", "macos"];
const PLATFORM_RELEASE_JOBS = new Map([
  ["linux", "Linux x64 package set on Debian CI"],
  ["windows", "Windows x64 package set"],
  ["macos", "macOS x64 and ARM64 client release (ARM64 build-only)"],
]);
const FAILED_RUN_STATES = new Set([
  "cancelled",
  "canceled",
  "completed",
  "failure",
  "failed",
  "skipped",
  "timed_out",
]);
const POLL_SECONDS = positiveInteger(
  process.env.MYOXUS_RELEASE_POLL_SECONDS ?? "20",
  "MYOXUS_RELEASE_POLL_SECONDS",
);
const WAIT_SECONDS = positiveInteger(
  process.env.MYOXUS_DESKTOP_RELEASE_TIMEOUT_SECONDS ?? "14400",
  "MYOXUS_DESKTOP_RELEASE_TIMEOUT_SECONDS",
);

function fail(message) {
  throw new Error(`Client release failed: ${message}`);
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value)) fail(`${name} must be a positive integer`);
  return Number(value);
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`version must be a complete semantic version, got '${version}'`);
  }
}

function validateRevision(revision) {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail(`revision must be a full lowercase Git SHA, got '${revision}'`);
  }
}

function apiUrl(repository, path) {
  return new URL(
    `/api/v1/repos/${repository}/${path}`,
    `${FORGEJO_URL.replace(/\/$/, "")}/`,
  );
}

async function requestJson(url, options = {}, expectedStatuses = [200]) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`request to ${url.origin}${url.pathname} failed: ${error.message}`);
  }
  if (!expectedStatuses.includes(response.status)) {
    fail(
      `request to ${url.origin}${url.pathname} returned HTTP ${response.status}`,
    );
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    fail(`request to ${url.origin}${url.pathname} returned invalid JSON`);
  }
}

function releaseIdentity(scope, version) {
  return {
    tag: `${scope}-client-v${version}`,
    label: { linux: "Linux", windows: "Windows", macos: "macOS" }[scope],
  };
}

function scopeLabel(scope) {
  if (scope === "clients") return "Linux/Windows/macOS clients";
  return releaseIdentity(scope, "").label;
}

export function platformsForScope(scope = "clients") {
  if (scope === "clients") return [...PLATFORMS];
  if (!PLATFORMS.includes(scope)) fail(`unsupported platform scope '${scope}'`);
  return [scope];
}

export function expectedAssets(scope, version) {
  if (!PLATFORMS.includes(scope)) fail(`unsupported asset platform '${scope}'`);
  const packages =
    scope === "linux"
      ? ["deb", "flatpak", "rpm"].map(
          (format) => `myoxus-${version}-stable-linux-x64.${format}`,
        )
      : scope === "macos"
        ? ["x64", "arm64"].flatMap((arch) =>
            ["dmg", "zip"].map(
              (format) => `myoxus-${version}-stable-macos-${arch}.${format}`,
            ),
          )
        : ["exe", "zip"].map(
            (format) => `myoxus-${version}-stable-windows-x64.${format}`,
          );
  return [
    "ARTIFACTS.md",
    "RELEASE.md",
    "SHA256SUMS",
    "desktop-provenance.json",
    "desktop-release.json",
    "latest.yml",
    ...packages,
    `myoxus-desktop-${version}.cdx.json`,
  ].sort();
}

async function verifyRelease(
  scope,
  version,
  allowMissing = false,
  announce = true,
) {
  const { label, tag } = releaseIdentity(scope, version);
  const url = apiUrl(RELEASE_REPOSITORY, `releases/tags/${tag}`);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    fail(`public ${label} release lookup failed: ${error.message}`);
  }
  if (allowMissing && response.status === 404) return false;
  if (response.status !== 200) {
    fail(`public release lookup for ${tag} returned HTTP ${response.status}`);
  }
  const release = await response.json();
  const actualAssets = (release.assets ?? []).map((asset) => asset.name).sort();
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    JSON.stringify(actualAssets) !==
      JSON.stringify(expectedAssets(scope, version))
  ) {
    fail(`public release ${tag} has a conflicting state or asset inventory`);
  }
  if (announce) {
    console.log(`${label} client ready: ${release.html_url ?? tag}`);
    for (const asset of actualAssets) console.log(`  ${asset}`);
  }
  return true;
}

async function missingPlatformReleases(scope, version) {
  const missing = [];
  for (const platform of platformsForScope(scope)) {
    if (!(await verifyRelease(platform, version, true, false))) {
      missing.push(platform);
    }
  }
  return missing;
}

async function activePlatformJobs(authorization, platforms) {
  const url = apiUrl(SOURCE_REPOSITORY, "actions/runners/jobs");
  const jobs = await requestJson(url, {
    headers: { Accept: "application/json", Authorization: authorization },
  });
  const expected = new Set(
    platforms.map((platform) => PLATFORM_RELEASE_JOBS.get(platform)),
  );
  return jobs.filter(
    (job) =>
      expected.has(job.name) &&
      ["waiting", "running"].includes(String(job.status).toLowerCase()),
  );
}

function releaseAuthorization() {
  const token = process.env.MYOXUS_FORGEJO_TOKEN;
  delete process.env.MYOXUS_FORGEJO_TOKEN;
  if (token) return `token ${token}`;

  let output;
  try {
    output = execFileSync("git", ["credential", "fill"], {
      encoding: "utf8",
      input: `url=${FORGEJO_URL}\n\n`,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    fail(
      "Forgejo HTTPS Git credentials are required to dispatch the workflows",
    );
  }
  const credential = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  if (!credential.username || !credential.password) {
    fail("Forgejo HTTPS Git credentials are incomplete");
  }
  return `Basic ${Buffer.from(
    `${credential.username}:${credential.password}`,
  ).toString("base64")}`;
}

function runIdentity(run) {
  return (
    run.head_sha ?? run.head_commit?.id ?? run.commit_sha ?? run.sha ?? null
  );
}

function runState(run) {
  return String(run.conclusion ?? run.status ?? "").toLowerCase();
}

function runPayload(run) {
  if (typeof run.event_payload === "object" && run.event_payload) {
    return run.event_payload;
  }
  if (typeof run.event_payload === "string") {
    try {
      return JSON.parse(run.event_payload);
    } catch {
      return null;
    }
  }
  return null;
}

function matchesReleaseRun(run, scope, version, ref, revision, notBefore = 0) {
  const payload = runPayload(run);
  const trigger = run.trigger_event || run.event;
  const created = Date.parse(run.created ?? run.created_at ?? "");
  return (
    run.workflow_id === WORKFLOW &&
    runIdentity(run) === revision &&
    (!run.prettyref || run.prettyref === ref) &&
    (!trigger || trigger === "workflow_dispatch") &&
    payload?.ref === `refs/tags/${ref}` &&
    payload?.inputs?.version === version &&
    payload?.inputs?.channel === "stable" &&
    payload?.inputs?.scope === scope &&
    (!notBefore || (Number.isFinite(created) && created >= notBefore))
  );
}

function matchesDependencyRefreshRun(run, ref, revision, notBefore = 0) {
  const payload = runPayload(run);
  const trigger = run.trigger_event || run.event;
  const created = Date.parse(run.created ?? run.created_at ?? "");
  return (
    run.workflow_id === DEPENDENCY_WORKFLOW &&
    runIdentity(run) === revision &&
    (!run.prettyref || run.prettyref === ref) &&
    (!trigger || trigger === "workflow_dispatch") &&
    payload?.ref === `refs/heads/${ref}` &&
    (!notBefore || (Number.isFinite(created) && created >= notBefore))
  );
}

async function findWorkflowRun(
  authorization,
  workflow,
  matches,
  notBefore = 0,
) {
  const url = apiUrl(SOURCE_REPOSITORY, "actions/runs");
  url.searchParams.set("workflow_id", workflow);
  url.searchParams.set("limit", "30");
  const data = await requestJson(url, {
    headers: { Accept: "application/json", Authorization: authorization },
  });
  const runs = data.workflow_runs ?? data.runs ?? [];
  return runs
    .filter((run) => matches(run, notBefore))
    .sort((left, right) => Number(right.id) - Number(left.id))[0];
}

function reusableRun(run) {
  return !FAILED_RUN_STATES.has(runState(run));
}

async function dispatchWorkflow(
  authorization,
  { workflow, ref, inputs, matches, label },
) {
  let existing = await findWorkflowRun(authorization, workflow, matches);
  if (existing && !reusableRun(existing)) existing = null;
  if (existing) return Number(existing.id);

  const dispatchedAt = Date.now() - 5_000;
  const dispatchUrl = apiUrl(
    SOURCE_REPOSITORY,
    `actions/workflows/${workflow}/dispatches`,
  );
  dispatchUrl.searchParams.set("return_run_info", "true");
  const dispatch = await requestJson(
    dispatchUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref,
        inputs,
      }),
    },
    [200, 201, 204],
  );
  let runId = dispatch?.id ?? dispatch?.run_id ?? dispatch?.workflow_run?.id;
  for (let attempt = 0; !runId && attempt < 15; attempt += 1) {
    const run = await findWorkflowRun(
      authorization,
      workflow,
      matches,
      dispatchedAt,
    );
    runId = run?.id;
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!Number.isInteger(Number(runId)) || Number(runId) <= 0) {
    fail(`Forgejo ${label} dispatch returned no valid run id`);
  }
  return Number(runId);
}

async function dispatchScope(authorization, scope, version, ref, revision) {
  return dispatchWorkflow(authorization, {
    workflow: WORKFLOW,
    ref,
    inputs: { channel: "stable", scope, version },
    matches: (run, notBefore) =>
      matchesReleaseRun(run, scope, version, ref, revision, notBefore),
    label: scope,
  });
}

async function dispatchDependencyRefresh(authorization, ref, revision) {
  return dispatchWorkflow(authorization, {
    workflow: DEPENDENCY_WORKFLOW,
    ref,
    inputs: {},
    matches: (run, notBefore) =>
      matchesDependencyRefreshRun(run, ref, revision, notBefore),
    label: "dependency refresh",
  });
}

async function waitForWorkflow(
  authorization,
  runId,
  label,
  matches,
  terminalOutcome = async () => "failure",
) {
  const runUrl = apiUrl(SOURCE_REPOSITORY, `actions/runs/${runId}`);
  const started = Date.now();
  let lastState = "";
  let reportedRunUrl = false;
  while (true) {
    const run = await requestJson(runUrl, {
      headers: { Accept: "application/json", Authorization: authorization },
    });
    if (!reportedRunUrl) {
      console.log(
        `Forgejo ${label} run: ${run.html_url ?? `${FORGEJO_URL}/${SOURCE_REPOSITORY}/actions/runs/${runId}`}`,
      );
      reportedRunUrl = true;
    }
    if (!matches(run)) {
      fail(`Forgejo run ${runId} differs from the requested ${label}`);
    }
    const state = runState(run);
    if (state !== lastState) {
      console.log(`  ${label}: ${state || "unknown"}`);
      lastState = state;
    }
    if (state === "success") return;
    if (FAILED_RUN_STATES.has(state)) {
      const outcome = await terminalOutcome();
      if (outcome === "success") return;
      if (outcome !== "wait") {
        fail(`Forgejo ${label} run ${runId} finished with ${state}`);
      }
    }
    if (Date.now() - started >= WAIT_SECONDS * 1000) {
      fail(`Forgejo ${label} run ${runId} timed out after ${WAIT_SECONDS}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
  }
}

async function refreshDependencies(ref, revision) {
  validateRevision(revision);
  const authorization = releaseAuthorization();
  const runId = await dispatchDependencyRefresh(authorization, ref, revision);
  await waitForWorkflow(authorization, runId, "dependency refresh", (run) =>
    matchesDependencyRefreshRun(run, ref, revision),
  );
}

async function waitForScope(
  authorization,
  scope,
  runId,
  version,
  ref,
  revision,
) {
  const label = scopeLabel(scope);
  await waitForWorkflow(
    authorization,
    runId,
    `${label} release`,
    (run) => matchesReleaseRun(run, scope, version, ref, revision),
    async () => {
      const missing = await missingPlatformReleases(scope, version);
      if (!missing.length) return "success";
      const active = await activePlatformJobs(authorization, missing);
      return active.length ? "wait" : "failure";
    },
  );
}

async function releaseClients(version, ref, revision, selectedScope) {
  const selectedPlatforms = platformsForScope(selectedScope);
  const missing = [];
  for (const scope of selectedPlatforms) {
    if (!(await verifyRelease(scope, version, true))) missing.push(scope);
  }
  if (!missing.length) {
    await waitForDistributionOverview({
      clients: selectedPlatforms,
      pollSeconds: POLL_SECONDS,
      sourceCommit: revision,
      version,
      waitSeconds: WAIT_SECONDS,
    });
    return;
  }

  const authorization = releaseAuthorization();
  const scopes = missing.length === PLATFORMS.length ? ["clients"] : missing;
  const runs = [];
  for (const scope of scopes) {
    runs.push({
      scope,
      runId: await dispatchScope(authorization, scope, version, ref, revision),
    });
  }
  await Promise.all(
    runs.map(({ scope, runId }) =>
      waitForScope(authorization, scope, runId, version, ref, revision),
    ),
  );
  await Promise.all(missing.map((scope) => verifyRelease(scope, version)));
  await waitForDistributionOverview({
    clients: selectedPlatforms,
    pollSeconds: POLL_SECONDS,
    sourceCommit: revision,
    version,
    waitSeconds: WAIT_SECONDS,
  });
}

function usage() {
  console.error(`Usage:
  node build/scripts/release/forgejo-client-release.mjs refresh <branch> <full-sha>
  node build/scripts/release/forgejo-client-release.mjs release <version> <tag> <full-sha>
    [clients|linux|windows|macos]
  node build/scripts/release/forgejo-client-release.mjs verify <version> [clients|linux|windows|macos]`);
  process.exit(2);
}

async function main(args) {
  const [command, version, ...rest] = args;
  if (!command || !version) usage();
  if (command === "refresh") {
    const [revision, extra] = rest;
    if (!revision || extra) usage();
    await refreshDependencies(version, revision);
  } else if (command === "release") {
    validateVersion(version);
    const [ref, revision, scope = "clients", extra] = rest;
    if (!ref || !revision || extra) usage();
    platformsForScope(scope);
    if (ref !== `clients-v${version}`)
      fail(`desktop workflow ref must be clients-v${version}`);
    validateRevision(revision);
    await releaseClients(version, ref, revision, scope);
  } else if (command === "verify") {
    validateVersion(version);
    const [scope = "clients", extra] = rest;
    if (extra) usage();
    const selectedPlatforms = platformsForScope(scope);
    await Promise.all(
      selectedPlatforms.map((platform) => verifyRelease(platform, version)),
    );
    await waitForDistributionOverview({
      clients: selectedPlatforms,
      version,
    });
  } else usage();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
