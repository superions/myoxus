// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
test("incoming root policy rejects unrelated roots, hidden merge parents and replace refs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "myoxus-roots-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim();
  try {
    git("init", "-q");
    const tree = git("mktree");
    const good = git("commit-tree", tree, "-m", "allowed");
    const bad = git("commit-tree", tree, "-m", "unapproved");
    const merged = git(
      "commit-tree",
      tree,
      "-p",
      good,
      "-p",
      bad,
      "-m",
      "hidden parent",
    );
    const allowed = join(cwd, "roots");
    writeFileSync(allowed, good + "\n");
    const check = (oid, ref = "refs/heads/wip") =>
      spawnSync("sh", [resolve("build/scripts/git/check-clean-roots.sh")], {
        cwd,
        input: `${"0".repeat(40)} ${oid} ${ref}\n`,
        env: { ...process.env, MYOXUS_ALLOWED_ROOTS_FILE: allowed },
      }).status;
    assert.equal(check(good), 0);
    assert.notEqual(check(bad), 0);
    assert.notEqual(check(merged), 0);
    assert.notEqual(check(good, "refs/replace/example"), 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
