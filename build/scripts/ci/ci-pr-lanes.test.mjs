// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { prChecks } from "./ci-lane-plan.mjs";
import { verifyWorkflowLanes } from "./verify-workflow-lanes.mjs";
import { runWithProcessTreeTimeout } from "../test/process-tree-runner.mjs";

const { parse } = createRequire(import.meta.url)("yaml");
const root = new URL("../../../", import.meta.url);
const sources = Object.fromEntries(
  readdirSync(new URL(".forgejo/workflows", root))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [
      name,
      readFileSync(new URL(`.forgejo/workflows/${name}`, root), "utf8"),
    ]),
);
const workflows = Object.fromEntries(
  Object.entries(sources).map(([name, source]) => [name, parse(source)]),
);

test("one PR source lane and no automatic branch-push verification", () => {
  assert.deepEqual(verifyWorkflowLanes(sources), []);
  assert.deepEqual(
    Object.entries(workflows)
      .filter(
        ([, workflow]) =>
          workflow.on?.pull_request || workflow.on?.pull_request_target,
      )
      .map(([name]) => name),
    ["pr-check.yml"],
  );
  const pr = workflows["pr-check.yml"];
  assert.deepEqual(pr.on.pull_request.branches, ["wip"]);
  assert.equal(pr.jobs.source.steps.length, 1);
  assert.equal(pr.permissions.contents, "read");
  assert.equal(pr.concurrency["cancel-in-progress"], true);
  assert.match(pr.jobs.source.steps[0].run, /deadline = started \+ 59_000/);
  assert.match(
    pr.jobs.source.steps[0].run,
    /process\.kill\(-child\.pid, "SIGKILL"\)/,
  );
  assert.doesNotMatch(
    pr.jobs.source.steps[0].run,
    /yarn|cargo|docker|playwright|vitest/,
  );
  assert.match(pr.jobs.source.steps[0].run, /delete cleanEnv\.CHECKOUT_TOKEN/);
  assert.match(pr.jobs.source.steps[0].run, /--filter=blob:none/);
  assert.match(pr.jobs.source.steps[0].run, /"--no-pager", "diff", "--check"/);
  assert.match(
    pr.jobs.source.steps[0].run,
    /"sparse-checkout", "set", "--no-cone", "--stdin"/,
  );
  assert.deepEqual(Object.keys(workflows["electron-packaging.yml"].on), [
    "workflow_dispatch",
  ]);
  assert.deepEqual(Object.keys(workflows["frontend-quality.yml"].on), [
    "workflow_dispatch",
  ]);
  for (const name of [
    "merge-check",
    "server-fast",
    "server-integration",
    "graphql-codegen",
    "policy-docs",
    "windows-release-contract",
    "runner-smoke",
    "repository-preflight",
    "dependency-health",
  ]) {
    assert.deepEqual(Object.keys(workflows[`${name}.yml`].on), [
      "workflow_dispatch",
    ]);
  }
  assert.deepEqual(
    Object.entries(workflows)
      .filter(([, workflow]) => workflow.on?.push)
      .map(([name]) => name),
    ["release-linux.yml", "server-build.yml"],
  );
  for (const name of ["release-linux.yml", "server-build.yml"]) {
    assert.equal(workflows[name].on.push.branches, undefined);
    assert.ok(workflows[name].on.push.tags.length > 0);
  }
  assert.equal(workflows["live-ci.yml"], undefined);
  for (const source of [
    "on:\n  pull_request:\n",
    'on: { "pull_request_target": {} }',
    "on: pull_request",
    "on: [push, pull_request]",
    "on:\n  - pull_request_target\n",
  ]) {
    assert.ok(
      verifyWorkflowLanes({ ...sources, "server-fast.yml": source }).some(
        (finding) => finding.includes("only pr-check.yml"),
      ),
    );
  }
  for (const source of [
    "on:\n  push:\n    branches: [wip]\n",
    'on: { "push": {} }',
    "on: push",
    "on: [workflow_dispatch, push]",
    "on:\n  - push\n",
  ]) {
    assert.ok(
      verifyWorkflowLanes({ ...sources, "live-ci.yml": source }).some(
        (finding) => finding.includes("must not repeat"),
      ),
    );
  }
  assert.ok(
    verifyWorkflowLanes({
      ...sources,
      "release-linux.yml": "on:\n  push:\n    branches: [wip]\n",
    }).some((finding) => finding.includes("tag-only")),
  );
});

test("actual merge bootstrap checks a source combination using trusted helpers and rejects stale target evidence", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "myoxus-merge-bootstrap-"));
  const statuses = [];
  const git = (args) =>
    execFileSync("git", args, {
      cwd: fixture,
      encoding: "utf8",
      timeout: 5_000,
    });
  const commit = () => {
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@myoxus.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      let body = "";
      for await (const data of request) body += data;
      statuses.push(JSON.parse(body));
      response.writeHead(201).end("{}");
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url.endsWith("/pulls/1")
            ? { state: "open", base: { ref: "wip" }, head: { sha: head } }
            : {
                commit: {
                  id: stale && statuses.length ? "a".repeat(40) : base,
                },
              },
        ),
      );
    }
  });
  let base,
    head,
    stale = false;
  try {
    git(["init", "--quiet"]);
    for (const path of [
      "package.json",
      "yarn.lock",
      ...[
        "source-tools.mjs",
        "source-imports.mjs",
        "verify-workspace-dependency-boundaries.mjs",
        "verify-merge-source-contracts.mjs",
      ].map((name) => `build/scripts/ci/${name}`),
    ]) {
      const destination = join(fixture, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(new URL(path, root), destination);
    }
    writeFileSync(join(fixture, "value.ts"), "export const value = 1;\n");
    base = commit();
    git(["branch", "wip"]);
    writeFileSync(join(fixture, "value.ts"), "export const value = 2;\n");
    // If the bootstrap executed candidate scripts, this would fail the run.
    writeFileSync(
      join(fixture, "build/scripts/ci/verify-merge-source-contracts.mjs"),
      'throw Error("UNTRUSTED_CANDIDATE_EXECUTED");\n',
    );
    head = commit();
    git(["update-ref", "refs/pull/1/head", head]);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const source = workflows["merge-check.yml"].jobs.source.steps[0].run;
    const script = source.slice(
      source.indexOf("\n") + 1,
      source.lastIndexOf("\nNODE"),
    );
    const run = async () =>
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-"], {
          env: {
            ...process.env,
            PR_NUMBER: "1",
            API_URL: `http://127.0.0.1:${server.address().port}`,
            REPOSITORY_URL: fixture,
            CHECKOUT_TOKEN: "fixture",
            MYOXUS_CI_SOURCE_TOOLS:
              process.env.MYOXUS_CI_SOURCE_TOOLS ??
              new URL("../../../", import.meta.url).pathname,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.stderr.on("data", (data) => {
          output += data;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, output }));
        child.stdin.end(script);
      });
    const valid = await run();
    assert.equal(valid.code, 0, valid.output);
    assert.deepEqual(
      statuses.map((item) => item.state),
      ["pending", "success"],
    );
    assert.doesNotMatch(
      valid.output,
      /UNTRUSTED_CANDIDATE_EXECUTED|AUTHORIZATION: basic/,
    );
    statuses.length = 0;
    stale = true;
    const moved = await run();
    assert.notEqual(moved.code, 0);
    assert.match(moved.output, /Head or target moved/);
    assert.deepEqual(
      statuses.map((item) => item.state),
      ["pending", "failure"],
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("source checks retain Facade and test-quality boundaries without product suites", () => {
  assert.deepEqual(prChecks([], "base")[0].args, [
    "--no-pager",
    "diff",
    "--check",
    "base",
    "HEAD",
  ]);
  for (const file of [
    "client/admin/example.tsx",
    "docs/dev/CI_STRATEGY.md",
    "server/crates/worker/src/queue.rs",
  ]) {
    const checks = prChecks([file], "base");
    assert.equal(
      checks.some((check) => check.id === "ui-facade-boundary"),
      file.startsWith("client/"),
    );
    assert.equal(
      checks.some((check) => check.id === "test-quality"),
      false,
    );
    assert.ok(checks.every((check) => ["node", "git"].includes(check.command)));
    assert.equal(
      checks.some((check) => check.id === "lint.oxlint.changed"),
      file.endsWith(".tsx"),
    );
  }
  assert.equal(
    prChecks(["client/admin/example.spec.tsx"], "base").some(
      (check) => check.id === "test-quality",
    ),
    true,
  );
});

test("existing changed-source Oxlint rejects broken TSX and skips tools for documentation-only changes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "myoxus-changed-lint-"));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: fixture,
      encoding: "utf8",
      timeout: 5_000,
    });
  const commit = () => {
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@myoxus.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  try {
    git(["init", "--quiet"]);
    for (const path of [".oxlintrc.json", "package.json", "yarn.lock"])
      cpSync(new URL(path, root), join(fixture, path));
    const base = commit();
    writeFileSync(join(fixture, "example.tsx"), "export const value = 1;\n");
    commit();
    const run = (
      runtime = process.env.MYOXUS_CI_SOURCE_TOOLS ?? root.pathname,
    ) =>
      spawnSync(
        process.execPath,
        [
          new URL("build/scripts/ci/lint-changed-sources.mjs", root).pathname,
          base,
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            MYOXUS_CI_SOURCE_TOOLS: runtime,
            MYOXUS_CI_SOURCE_GROUP: "1",
          },
        },
      );
    const valid = run();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    writeFileSync(join(fixture, "example.tsx"), "export const = < ;\n");
    commit();
    const broken = run();
    assert.notEqual(broken.status, 0);
    assert.match(broken.stdout + broken.stderr, /example.tsx/);
    rmSync(join(fixture, "example.tsx"));
    writeFileSync(join(fixture, "notes.md"), "Documentation only\n");
    commit();
    const docs = run("/missing-tool-runtime");
    assert.equal(docs.status, 0, docs.stdout + docs.stderr);
    assert.match(docs.stdout, /No changed JavaScript\/TypeScript/);
    assert.equal(
      readdirSync(fixture).some((name) =>
        name.startsWith(".myoxus-ci-oxlint-"),
      ),
      false,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("changed-source Oxlint descendants stay inside the CI-owned process group", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "myoxus-lint-group-"));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: fixture,
      encoding: "utf8",
      timeout: 5_000,
    });
  const tools = process.env.MYOXUS_CI_SOURCE_TOOLS ?? root.pathname;
  assert.ok(
    tools,
    "Set MYOXUS_CI_SOURCE_TOOLS to the installed source-tool runtime",
  );
  try {
    git(["init", "--quiet"]);
    for (const path of [".oxlintrc.json", "package.json", "yarn.lock"])
      cpSync(new URL(path, root), join(fixture, path));
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@myoxus.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(fixture, "example.tsx"), "export const value = 1;\n");
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@myoxus.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const runtime = join(fixture, "runtime");
    mkdirSync(join(runtime, "node_modules/.bin"), { recursive: true });
    cpSync(
      join(tools, "node_modules/oxlint/package.json"),
      join(runtime, "node_modules/oxlint.json"),
    );
    mkdirSync(join(runtime, "node_modules/oxlint"));
    cpSync(
      join(runtime, "node_modules/oxlint.json"),
      join(runtime, "node_modules/oxlint/package.json"),
    );
    for (const name of ["yaml", "eslint-plugin-react-hooks", "@swc/core"]) {
      const destination = join(runtime, "node_modules", name);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(join(tools, "node_modules", name), destination, "dir");
    }
    const pidFile = join(fixture, "child.pid");
    const binary = join(runtime, "node_modules/.bin/oxlint");
    writeFileSync(
      binary,
      `#!/bin/sh\nsleep 60 & echo $! > "${pidFile}"\nwait\n`,
    );
    chmodSync(binary, 0o755);
    const result = await runWithProcessTreeTimeout(
      process.execPath,
      [
        new URL("build/scripts/ci/lint-changed-sources.mjs", root).pathname,
        base,
      ],
      {
        cwd: fixture,
        env: {
          ...process.env,
          MYOXUS_CI_SOURCE_TOOLS: runtime,
          MYOXUS_CI_SOURCE_GROUP: "1",
        },
        timeoutMs: 700,
        killGraceMs: 200,
        stdio: "pipe",
      },
    );
    assert.equal(result.timedOut, true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const alive = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
    });
    assert.equal(
      alive.status !== 0 || alive.stdout.trim().startsWith("Z"),
      true,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the actual PR bootstrap kills a timed-out checkout process tree and cleans its temporary checkout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "myoxus-pr-budget-test-"));
  try {
    const pidFile = join(fixture, "child.pid");
    const git = join(fixture, "git");
    writeFileSync(
      git,
      `#!/bin/sh\nif [ "$1" = fetch ]; then sleep 60 & echo $! > "${pidFile}"; wait; fi\n`,
    );
    chmodSync(git, 0o755);
    const source = workflows["pr-check.yml"].jobs.source.steps[0].run;
    const script = source
      .slice(source.indexOf("\n") + 1, source.lastIndexOf("\nNODE"))
      .replace("started + 59_000", "started + 500");
    const before = readdirSync(tmpdir()).filter((name) =>
      name.startsWith("myoxus-pr-"),
    );
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: script,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${fixture}:${process.env.PATH}`,
        PR_BASE: "a".repeat(40),
        PR_HEAD: "b".repeat(40),
        REPOSITORY_URL: "https://fixture.invalid/repo.git",
        CHECKOUT_TOKEN: "fixture",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /incomplete after 60 seconds; process group killed/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /AUTHORIZATION: basic/);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    // Linux may briefly retain a dead child as a zombie; neither state can run.
    const alive = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
    });
    assert.equal(
      alive.status !== 0 || alive.stdout.trim().startsWith("Z"),
      true,
    );
    assert.deepEqual(
      readdirSync(tmpdir()).filter((name) => name.startsWith("myoxus-pr-")),
      before,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
