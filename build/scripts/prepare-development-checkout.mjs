#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  readlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function assertNoConsumers(target) {
  // Ignore this command and its invoking shells, but never another process
  // whose cwd is in the checkout. A clean Git status does not imply inactivity.
  const ancestors = new Set([process.pid]);
  let pid = process.ppid;
  while (pid > 1 && !ancestors.has(pid)) {
    ancestors.add(pid);
    pid = Number(
      execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
    );
  }
  const check = (pid, cwd) => {
    if (
      !ancestors.has(Number(pid)) &&
      (cwd === target || cwd.startsWith(`${target}/`))
    ) {
      throw new Error(
        `Active destination consumer PID ${pid}; checkout update refused`,
      );
    }
  };
  if (process.platform === "linux") {
    for (const pid of readdirSync("/proc").filter((name) =>
      /^\d+$/.test(name),
    )) {
      let cwd;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch (error) {
        if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) continue;
        throw error;
      }
      check(pid, cwd);
    }
  } else if (process.platform === "darwin") {
    const output = execFileSync(
      "lsof",
      ["-a", "-u", String(process.getuid()), "-d", "cwd", "-Fpn"],
      { encoding: "utf8", timeout: 30000 },
    );
    let current;
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) current = line.slice(1);
      else if (line.startsWith("n")) check(current, line.slice(1));
    }
  } else throw new Error("Consumer inspection is unsupported on this host");
}

export function prepare({ remote, revision, destination, ref, apply = false }) {
  if (
    !remote ||
    !/^[0-9a-f]{40}$/.test(revision ?? "") ||
    !ref?.startsWith("refs/heads/")
  )
    throw new Error(
      "Explicit remote, full revision, branch ref and destination are required",
    );
  if (
    !destination ||
    (!remote.endsWith("/myoxus/myoxus.git") &&
      !remote.endsWith(":myoxus/myoxus.git"))
  )
    throw new Error("Only the canonical private Myoxus remote is admitted");
  const target = resolve(destination);
  for (let p = target; ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error("Symlink destination is forbidden");
    if (p === dirname(p)) break;
  }
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
    }).trim();
  const actual = git(
    dirname(target),
    "ls-remote",
    "--exit-code",
    remote,
    ref,
  ).split(/\s+/)[0];
  if (actual !== revision)
    throw new Error("Remote branch moved from the reviewed revision");
  const occupied = existsSync(target) && readdirSync(target).length > 0;
  if (occupied) {
    if (realpathSync(git(target, "rev-parse", "--show-toplevel")) !== target)
      throw new Error("Destination is not an independent checkout");
    if (git(target, "remote", "get-url", "origin") !== remote)
      throw new Error("Destination origin differs");
    if (git(target, "status", "--porcelain", "--untracked-files=all"))
      throw new Error("Destination has uncommitted work");
    if (
      existsSync(resolve(target, ".git/objects/info/alternates")) ||
      existsSync(resolve(target, ".git/shallow")) ||
      !lstatSync(resolve(target, ".git")).isDirectory()
    )
      throw new Error("Shared or shallow checkout forbidden");
    if (process.getuid && lstatSync(target).uid !== process.getuid())
      throw new Error("Destination owner differs");
  }
  if (occupied) assertNoConsumers(target);
  if (!apply)
    return {
      target,
      revision,
      action: occupied
        ? "verify or fast-forward clean target"
        : "independent clone",
      applied: false,
    };
  if (!occupied)
    git(
      dirname(target),
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-tags",
      "--single-branch",
      "--branch",
      ref.slice(11),
      remote,
      target,
    );
  else {
    git(target, "fetch", "--no-tags", "origin", ref);
    if (git(target, "rev-parse", "FETCH_HEAD") !== revision)
      throw new Error("Remote moved during fetch");
    git(target, "merge-base", "--is-ancestor", "HEAD", revision);
    // Keep the existing branch intact while preparing a distinct reviewed candidate.
    const head = git(target, "rev-parse", "HEAD");
    if (head !== revision) git(target, "switch", "--detach", revision);
  }
  if (
    git(target, "rev-parse", "HEAD") !== revision ||
    git(target, "status", "--porcelain")
  )
    throw new Error("Checkout does not match reviewed revision");
  return { target, revision, applied: true };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    while (args.length) {
      const key = args.shift();
      if (key === "--apply") options.apply = true;
      else if (
        ["--remote", "--revision", "--destination", "--ref"].includes(key)
      )
        options[key.slice(2)] = args.shift();
      else throw new Error(`Unknown argument ${key}`);
    }
    console.log(JSON.stringify(prepare(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
