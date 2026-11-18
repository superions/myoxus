// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncGithubPrs } from "./sync-github-prs.mjs";

test("curated PR intake preserves private ancestry, binary changes, idempotency and maintainer work", async () => {
  const root = mkdtempSync(join(tmpdir(), "github-pr-contract-"));
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Contributor",
        GIT_AUTHOR_EMAIL: "contributor@example.org",
        GIT_COMMITTER_NAME: "Contributor",
        GIT_COMMITTER_EMAIL: "contributor@example.org",
      },
    }).trim();
  const sourceGit = join(root, "public"),
    targetGit = join(root, "private");
  try {
    for (const path of [sourceGit, targetGit]) {
      mkdirSync(path);
      git(path, "init", "-q", "-b", path === sourceGit ? "main" : "wip");
      writeFileSync(join(path, "requirements.txt"), "pillow==12.3.0\n");
      if (path === targetGit)
        writeFileSync(join(path, "private.txt"), "private\n");
      git(path, "add", ".");
      git(
        path,
        "commit",
        "-qm",
        path === sourceGit ? "Public export" : "Private development",
      );
    }
    const base = git(sourceGit, "rev-parse", "HEAD");
    const privateBase = git(targetGit, "rev-parse", "HEAD");
    git(sourceGit, "checkout", "-qb", "proposal");
    writeFileSync(join(sourceGit, "requirements.txt"), "pillow==13.0.0\n");
    writeFileSync(join(sourceGit, "binary.dat"), Buffer.from([0, 255, 42]));
    git(sourceGit, "add", ".");
    git(
      sourceGit,
      "commit",
      "-qm",
      "Update Pillow\n\nSigned-off-by: Contributor <contributor@example.org>",
    );
    const pr = {
      number: 1,
      title: "Update Pillow",
      state: "open",
      user: { login: "dependabot[bot]" },
      body: "Public proposal",
      base: { sha: base },
      head: { sha: git(sourceGit, "rev-parse", "HEAD") },
    };
    git(sourceGit, "update-ref", "refs/pull/1/head", pr.head.sha);
    const copies = [];
    let closeAttempts = 0;
    let failClose = false;
    const fetchImpl = async (url, options) => {
      const route = new URL(url).pathname;
      const body = options.body && JSON.parse(options.body);
      let data;
      if (url.startsWith("https://api.github.com")) {
        if (options.method === "PATCH") {
          closeAttempts++;
          assert.equal(route, "/repos/superions/myoxus/pulls/1");
          assert.deepEqual(body, { state: "closed" });
          if (failClose) return { ok: false, status: 503 };
          pr.state = "closed";
        }
        data = route.endsWith("/pulls/1")
          ? pr
          : pr.state === "open"
            ? [pr]
            : [];
      } else if (options.method === "POST") {
        data = {
          ...body,
          number: 9,
          state: "open",
          base: { ref: body.base },
          head: { ref: body.head },
        };
        copies.push(data);
      } else if (options.method === "PATCH") {
        Object.assign(copies[0], body);
        data = copies[0];
      } else data = copies;
      return { ok: true, status: 200, json: async () => structuredClone(data) };
    };
    const run = () =>
      syncGithubPrs({
        sourceGit,
        targetGit,
        token: "fixture-token",
        githubToken: "fixture-github-token",
        fetchImpl,
      });
    assert.equal((await run()).created, 1);
    const branch = "refs/heads/dev/github/superions/myoxus/1";
    const first = git(targetGit, "rev-parse", branch);
    assert.equal(git(targetGit, "rev-parse", `${first}^`), privateBase);
    assert.equal(git(targetGit, "show", `${branch}:private.txt`), "private");
    assert.equal(
      git(targetGit, "show", `${branch}:requirements.txt`),
      "pillow==13.0.0",
    );
    assert.deepEqual(
      execFileSync("git", ["show", `${branch}:binary.dat`], { cwd: targetGit }),
      Buffer.from([0, 255, 42]),
    );
    assert.match(
      git(targetGit, "show", "-s", "--format=%B", branch),
      /Signed-off-by: Contributor/,
    );
    assert.equal((await run()).unchanged, 1);
    assert.equal(copies.length, 1);
    writeFileSync(join(sourceGit, "requirements.txt"), "pillow==13.1.0\n");
    git(sourceGit, "commit", "-qam", "Update proposal");
    pr.head.sha = git(sourceGit, "rev-parse", "HEAD");
    git(sourceGit, "update-ref", "refs/pull/1/head", pr.head.sha);
    assert.equal((await run()).updated, 1);
    assert.equal(git(targetGit, "rev-parse", `${branch}^1`), first);
    assert.equal(
      git(targetGit, "show", `${branch}:requirements.txt`),
      "pillow==13.1.0",
    );
    const managed = git(targetGit, "rev-parse", branch);
    git(targetGit, "update-ref", branch, privateBase);
    assert.equal((await run()).failed, 1);
    assert.equal(git(targetGit, "rev-parse", branch), privateBase);
    git(targetGit, "update-ref", branch, managed);
    // A private conflicting edit must stop the update without publishing a branch.
    writeFileSync(join(targetGit, "requirements.txt"), "pillow==14.0.0\n");
    git(targetGit, "commit", "-qam", "Private conflicting change");
    writeFileSync(join(sourceGit, "requirements.txt"), "pillow==13.2.0\n");
    git(sourceGit, "commit", "-qam", "Next proposal");
    pr.head.sha = git(sourceGit, "rev-parse", "HEAD");
    git(sourceGit, "update-ref", "refs/pull/1/head", pr.head.sha);
    assert.equal((await run()).failed, 1);
    assert.equal(git(targetGit, "rev-parse", branch), managed);
    copies[0].state = "closed";
    assert.equal((await run()).skipped, 1);
    assert.equal(closeAttempts, 0);

    // A real maintainer update retains the recorded import in its ancestry.
    git(targetGit, "checkout", "-q", "--detach", managed);
    git(targetGit, "commit", "--allow-empty", "-qm", "Maintainer update");
    const maintainerHead = git(targetGit, "rev-parse", "HEAD");
    Object.assign(copies[0], {
      merged: true,
      merge_commit_sha: maintainerHead,
      user: { login: "myoxus-renovate" },
      base: { ref: "wip", repo_id: 190 },
      head: {
        ref: "refs/pull/9/head",
        label: branch.slice("refs/heads/".length),
        sha: maintainerHead,
        repo_id: 190,
      },
    });
    assert.equal((await run()).skipped, 1, "Newer GitHub changes stay open");
    assert.equal(closeAttempts, 0);

    pr.head.sha = git(sourceGit, "rev-parse", "HEAD^");
    copies[0].user.login = "unrelated-user";
    assert.equal(
      (await run()).skipped,
      1,
      "Only importer-owned merges close originals",
    );
    assert.equal(closeAttempts, 0);
    copies[0].user.login = "myoxus-renovate";
    failClose = true;
    assert.equal((await run()).failed, 1);
    assert.equal(pr.state, "open");
    failClose = false;
    assert.equal((await run()).closed, 1);
    assert.equal(pr.state, "closed");
    assert.equal((await run()).closed, 0);
    assert.equal(closeAttempts, 2, "Retry failure but do not repeat success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
