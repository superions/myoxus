// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { prepare } from "../prepare-development-checkout.mjs";
test("additive checkout preserves dirty source, rejects occupied target and moved ref, safely repeats", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "myoxus-checkout-")));
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const source = join(root, "source");
    mkdirSync(source);
    git(source, "init", "-b", "wip");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.test");
    writeFileSync(join(source, "AGENTS.md"), "instructions");
    git(source, "add", ".");
    git(source, "commit", "-m", "independent root");
    const revision = git(source, "rev-parse", "HEAD");
    mkdirSync(join(root, "myoxus"));
    const remote = join(root, "myoxus/myoxus.git");
    git(root, "clone", "--bare", source, remote);
    writeFileSync(join(source, "AGENTS.md"), "dirty preserved");
    const destination = join(root, "checkout");
    const options = { remote, revision, destination, ref: "refs/heads/wip" };
    assert.equal(prepare(options).applied, false);
    assert.equal(prepare({ ...options, apply: true }).applied, true);
    assert.equal(prepare({ ...options, apply: true }).applied, true);
    assert.equal(
      readFileSync(join(source, "AGENTS.md"), "utf8"),
      "dirty preserved",
    );
    const consumer = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: destination, stdio: "ignore" },
    );
    try {
      assert.throws(
        () => prepare({ ...options, apply: true }),
        /Active destination consumer/,
      );
    } finally {
      consumer.kill("SIGTERM");
    }
    writeFileSync(join(destination, "user-work"), "untracked");
    assert.throws(() => prepare({ ...options, apply: true }), /uncommitted/);
    const occupied = join(root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep"), "keep");
    assert.throws(() =>
      prepare({ ...options, destination: occupied, apply: true }),
    );
    assert.equal(readFileSync(join(occupied, "keep"), "utf8"), "keep");
    assert.throws(
      () => prepare({ ...options, revision: "1".repeat(40), apply: true }),
      /moved/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
