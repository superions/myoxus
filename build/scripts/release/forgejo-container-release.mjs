#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";

const origin = process.env.MYOXUS_FORGEJO_URL ?? "https://git.blume29.de";
const repository = "/api/v1/repos/myoxus/myoxus";
const failed = new Set(["failure", "cancelled"]);

// Rerunning a prerequisite also reruns its dependants. Select only the earliest
// failed tier; never rerun successful sibling images or separately queue the
// acceptance job that Forgejo will already restart as a dependant.
export function selectRetryJobs(jobs) {
  const candidates = jobs.filter((job) => failed.has(job.status));
  const preflight = candidates.filter(
    (job) => job.name === "Container preflight",
  );
  if (preflight.length) return preflight;
  const images = candidates.filter((job) =>
    /^(Server image|Frontend images)(?:$|[- (])/.test(job.name),
  );
  if (images.length) return images;
  return candidates.filter(
    (job) => job.name === "Accept and promote container images",
  );
}

export async function runContainerOperation(args, request) {
  const [operation, component, version, revision, ref = "wip"] = args;
  if (
    !["status", "retry", "publish"].includes(operation) ||
    !["server", "frontends"].includes(component) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "") ||
    !/^[0-9a-f]{40}$/.test(revision ?? "")
  ) {
    throw new Error(
      "Expected status|retry|publish server|frontends <version> <full-release-sha> [workflow-ref]",
    );
  }
  if (operation === "publish") {
    // The workflow code comes from the maintained branch; it resolves product
    // source independently from the existing immutable component release tag.
    const result = await request(
      `${repository}/actions/workflows/recover-container-release.yml/dispatches`,
      {
        ref,
        inputs: { component, version, source_revision: revision },
      },
    );
    console.log(
      `Publish-only ${component} ${version} requested (source ${revision}). No build permitted.`,
    );
    if (result?.html_url) console.log(result.html_url);
    return;
  }
  const tag = `${component}-v${version}`;
  const query = new URLSearchParams({
    workflow_id: "release-linux.yml",
    head_sha: revision,
    ref: `refs/tags/${tag}`,
    limit: "50",
  });
  const data = await request(`${repository}/actions/runs?${query}`);
  const runs = (data.workflow_runs ?? [])
    .filter(
      (run) =>
        run.workflow_id === "release-linux.yml" &&
        run.commit_sha === revision &&
        [tag, `refs/tags/${tag}`].includes(run.prettyref),
    )
    .sort((left, right) => Number(right.id) - Number(left.id));
  const run = runs[0];
  async function showRun(value) {
    const data = await request(`${repository}/actions/runs/${value.id}/jobs`);
    const jobs = Array.isArray(data) ? data : (data.jobs ?? []);
    console.log(
      `${component} ${version} (${value.workflow_id}): ${value.status} — ${value.html_url}`,
    );
    for (const job of jobs)
      console.log(
        `  ${job.status.padEnd(10)} ${job.name} (job ${job.id}, attempt ${job.attempt})`,
      );
    return jobs;
  }
  if (operation === "status") {
    if (run) await showRun(run);
    const query = new URLSearchParams({
      workflow_id: "recover-container-release.yml",
      ref: `refs/heads/${ref}`,
      limit: "50",
    });
    const data = await request(`${repository}/actions/runs?${query}`);
    const recovery = (data.workflow_runs ?? [])
      .filter((value) => {
        let payload = value.event_payload;
        try {
          if (typeof payload === "string") payload = JSON.parse(payload);
        } catch {
          return false;
        }
        return (
          value.workflow_id === "recover-container-release.yml" &&
          payload?.inputs?.component === component &&
          payload?.inputs?.version === version &&
          payload?.inputs?.source_revision === revision
        );
      })
      .sort((left, right) => Number(right.id) - Number(left.id))[0];
    if (recovery) await showRun(recovery);
    if (!run && !recovery)
      throw new Error(
        `No matching release or recovery run for ${tag} at ${revision}.`,
      );
    return;
  }
  if (!run)
    throw new Error(
      `No matching OCI run for ${tag} at ${revision}; no tags changed.`,
    );
  const jobs = await showRun(run);
  const selected = selectRetryJobs(jobs);
  if (!selected.length)
    throw new Error(
      "No failed release job to resume; use verify for published images or publish-only for upload recovery.",
    );
  for (const job of selected) {
    await request(`${repository}/actions/jobs/${job.id}/rerun`, {});
    console.log(
      `Native job retry requested: ${job.name} (${job.id}); dependent jobs are resumed by Forgejo.`,
    );
  }
}

async function main() {
  const token = process.env.MYOXUS_FORGEJO_TOKEN;
  delete process.env.MYOXUS_FORGEJO_TOKEN;
  if (!token)
    throw new Error(
      "MYOXUS_FORGEJO_TOKEN is required; use the repository temporary-token wrapper.",
    );
  await runContainerOperation(process.argv.slice(2), async (path, body) => {
    const url = new URL(path, origin);
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `Forgejo ${url.pathname} returned HTTP ${response.status}; read back status before retrying an uncertain mutation.`,
      );
    return response.status === 204 ? null : response.json();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
