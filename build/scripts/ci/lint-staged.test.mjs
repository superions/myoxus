// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { runWithProcessTreeTimeout } from "../test/process-tree-runner.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const hook = join(repo, ".husky/pre-commit");
const cli = join(repo, "node_modules/lint-staged/bin/lint-staged.js");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const base = (first = "OLD") =>
  `staged = ${first}\n${"unchanged\n".repeat(20)}unfinished = OLD\n`;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "myoxus-lint-staged-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout");
  const bin = join(root, "bin");
  mkdirSync(cwd);
  mkdirSync(bin);
  // A hook can itself be tested from a Git hook; never inherit its index or repository.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_LOG: join(root, "calls.jsonl"),
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const tool = join(root, "tool.mjs");
  writeFileSync(
    tool,
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [name, ...args] = process.argv.slice(2);
const log = phase => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({name, args, phase}) + '\\n');
log('start');
for (const file of args.filter(file => file.startsWith('/') && existsSync(file))) {
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('BAD', 'FORMATTED'));
}
if (name === 'oxlint' && process.env.FIXTURE_SIDE_EFFECT) {
  const file = process.env.FIXTURE_SIDE_EFFECT;
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('BAD', 'FORMATTED'));
}
await new Promise(resolve => setTimeout(resolve, 30));
log('end');
if (name === process.env.FIXTURE_FAIL_TOOL) process.exit(2);
`,
  );
  for (const name of ["prettier", "oxlint", "taplo", "cargo"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(tool)} ${quote(name)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  // Only resolve the installed CLI; execute the repository hook and real lint-staged.
  writeFileSync(
    join(bin, "yarn"),
    `#!/bin/sh\n[ "$1" = exec ] && [ "$2" = lint-staged ] || exit 99\nshift 2\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
    { mode: 0o755 },
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 5000 });
  git("init", "--quiet");
  git("config", "user.name", "Hook fixture");
  git("config", "user.email", "hook-fixture@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "core.autocrlf", "false");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "hook-fixture",
      private: true,
      "lint-staged": manifest["lint-staged"],
    }),
  );
  writeFileSync(join(cwd, "partial.ts"), base());
  writeFileSync(join(cwd, "side effect.ts"), base("BAD"));
  writeFileSync(join(cwd, "untouched.txt"), base());
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture baseline");
  async function run(target = cwd, options = {}) {
    const result = await runWithProcessTreeTimeout("sh", [hook], {
      cwd: target,
      env: { ...env, ...options },
      timeoutMs: 20000,
      killGraceMs: 500,
      stdio: ["ignore", "inherit", "inherit"],
    });
    assert.equal(result.timedOut, false, "hook timed out");
    return result.status;
  }
  function dirty() {
    writeFileSync(join(cwd, "partial.ts"), base("BAD"));
    git("add", "partial.ts");
    writeFileSync(
      join(cwd, "partial.ts"),
      base("BAD").replace("unfinished = OLD", "unfinished = SECRET"),
    );
    writeFileSync(
      join(cwd, "side effect.ts"),
      base("BAD").replace("unfinished = OLD", "unfinished = SECRET"),
    );
    writeFileSync(join(cwd, "untouched.txt"), base("UNFINISHED"));
    writeFileSync(join(cwd, "scratch.ts"), "BAD untracked\n");
  }
  return { root, cwd, env, git, run, dirty };
}

test("hook formats staged content while preserving partial, unrelated and untracked edits", async (t) => {
  const f = fixture(t);
  f.dirty();
  assert.equal(
    await f.run(f.cwd, { FIXTURE_SIDE_EFFECT: join(f.cwd, "side effect.ts") }),
    0,
  );
  assert.equal(f.git("show", ":partial.ts"), base("FORMATTED"));
  assert.equal(
    readFileSync(join(f.cwd, "partial.ts"), "utf8"),
    base("FORMATTED").replace("unfinished = OLD", "unfinished = SECRET"),
  );
  assert.equal(f.git("show", ":side effect.ts"), base("FORMATTED"));
  assert.equal(
    readFileSync(join(f.cwd, "side effect.ts"), "utf8"),
    base("FORMATTED").replace("unfinished = OLD", "unfinished = SECRET"),
  );
  assert.equal(f.git("show", ":untouched.txt"), base());
  assert.equal(
    readFileSync(join(f.cwd, "untouched.txt"), "utf8"),
    base("UNFINISHED"),
  );
  assert.equal(
    readFileSync(join(f.cwd, "scratch.ts"), "utf8"),
    "BAD untracked\n",
  );
  assert.equal(f.git("stash", "list"), "");
});

test("a failing task restores index, working files and an existing stash", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "untouched.txt"), base("PRESERVED_STASH"));
  f.git("stash", "push", "--quiet", "-m", "preserve this stash");
  f.dirty();
  const files = ["partial.ts", "side effect.ts", "untouched.txt", "scratch.ts"];
  const before = files.map((file) => readFileSync(join(f.cwd, file), "utf8"));
  const index = f.git("diff", "--cached", "--binary");
  const status = f.git("status", "--porcelain=v1");
  const stash = f.git("stash", "list", "--format=%H %s");
  assert.notEqual(
    await f.run(f.cwd, {
      FIXTURE_FAIL_TOOL: "oxlint",
      FIXTURE_SIDE_EFFECT: join(f.cwd, "side effect.ts"),
    }),
    0,
  );
  const calls = readFileSync(f.env.FIXTURE_LOG, "utf8");
  assert.match(calls, /"name":"oxlint".*"phase":"end"/);
  assert.equal(f.git("diff", "--cached", "--binary"), index);
  assert.equal(f.git("status", "--porcelain=v1"), status);
  assert.equal(f.git("stash", "list", "--format=%H %s"), stash);
  assert.deepEqual(
    files.map((file) => readFileSync(join(f.cwd, file), "utf8")),
    before,
  );
});

test("repository globs retain Unicode/space arguments, vendor exclusions and serial tasks", async (t) => {
  const f = fixture(t);
  const files = [
    "nested/ä file 'one'.tsx",
    "nested/.hidden.js",
    "Cargo.toml",
    "nested/project.toml",
    "vendor/ignored.toml",
    "lib.rs",
    "nested/other.rs",
    "vendor/ignored.rs",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(f.cwd, file)), { recursive: true });
    writeFileSync(join(f.cwd, file), "BAD\n");
  }
  f.git("add", "--", ...files);
  assert.equal(await f.run(), 0);
  const calls = readFileSync(f.env.FIXTURE_LOG, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((call) => `${call.name}:${call.phase}`),
    [
      "prettier:start",
      "prettier:end",
      "oxlint:start",
      "oxlint:end",
      "taplo:start",
      "taplo:end",
      "cargo:start",
      "cargo:end",
    ],
  );
  for (const [name, selected] of [
    ["prettier", files],
    ["oxlint", files.slice(0, 2)],
    ["taplo", ["Cargo.toml", "nested/project.toml"]],
    ["cargo", ["lib.rs", "nested/other.rs"]],
  ]) {
    const args = calls.find((call) => call.name === name).args;
    assert.deepEqual(
      args.filter((arg) => arg.startsWith("/")).sort(),
      selected.map((file) => join(f.cwd, file)).sort(),
    );
  }
  for (const file of files)
    assert.equal(f.git("show", `:${file}`), "FORMATTED\n");
});

test("linked worktree hook leaves the other checkout index, edits and stash intact", async (t) => {
  const f = fixture(t);
  f.dirty();
  const index = f.git("diff", "--cached", "--binary");
  const worktree = join(f.root, "linked worktree");
  f.git("worktree", "add", "--quiet", "--detach", worktree, "HEAD");
  writeFileSync(join(worktree, "partial.ts"), base("BAD"));
  execFileSync("git", ["add", "partial.ts"], {
    cwd: worktree,
    env: f.env,
    timeout: 5000,
  });
  assert.equal(await f.run(worktree), 0);
  assert.equal(f.git("diff", "--cached", "--binary"), index);
  assert.match(
    readFileSync(join(f.cwd, "partial.ts"), "utf8"),
    /unfinished = SECRET/,
  );
  assert.equal(
    execFileSync("git", ["show", ":partial.ts"], {
      cwd: worktree,
      env: f.env,
      encoding: "utf8",
      timeout: 5000,
    }),
    base("FORMATTED"),
  );
  assert.equal(f.git("stash", "list"), "");
});
