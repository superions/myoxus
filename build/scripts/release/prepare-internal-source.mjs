#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanSecretContent } from "../ci/scan-public-source-secrets.mjs";

const sha = /^[a-f0-9]{40}$/;
const branch = "refs/heads/codex/internal-source-candidate";
function git(root, args, options = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `git ${args[0]} failed: ${result.stderr ?? result.error ?? ""}`,
  );
  return result.stdout?.trimEnd();
}
function safePath(name) {
  assert(
    name &&
      !name.startsWith("/") &&
      !name.includes("\0") &&
      !/[\r\n\\]/.test(name),
    "unsafe source path",
  );
  assert(
    !name.split("/").some((x) => ["", ".", "..", ".git"].includes(x)),
    "unsafe source path",
  );
  assert(
    !/(^|\/)(node_modules|target|runtime-secrets|runtime-config|runtime-frontends)(\/|$)/.test(
      name,
    ),
    `generated/private path: ${name}`,
  );
  assert(
    !/^(server\/runtime|build\/server\/data|\.private)(\/|$)/.test(name),
    `runtime/private path: ${name}`,
  );
  assert(
    !/(^|\/)\.env(?:\.|$)/.test(name) ||
      /\.(example|sample|template)$/.test(name),
    `environment file: ${name}`,
  );
  return name;
}
function decodePath(value) {
  if (!value.startsWith('"')) return value;
  const bytes = [];
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== "\\") {
      bytes.push(...Buffer.from(value[i]));
      continue;
    }
    const c = value[++i];
    if (/[0-7]/.test(c)) {
      const octal = value.slice(i, i + 3);
      assert(/^[0-7]{3}$/.test(octal));
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else {
      const escapes = {
        n: 10,
        r: 13,
        t: 9,
        b: 8,
        f: 12,
        v: 11,
        a: 7,
        '"': 34,
        "\\": 92,
      };
      assert(c in escapes, "unknown Git path escape");
      bytes.push(escapes[c]);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
// Seekable export data keeps memory bounded even for a month of complete trees.
class Reader {
  constructor(file) {
    this.fd = fs.openSync(file, "r");
    this.offset = 0;
    this.buffer = Buffer.alloc(65536);
    this.start = -1;
    this.length = 0;
  }
  available() {
    if (this.offset < this.start || this.offset >= this.start + this.length) {
      this.start = this.offset;
      this.length = fs.readSync(
        this.fd,
        this.buffer,
        0,
        this.buffer.length,
        this.offset,
      );
    }
    return this.buffer.subarray(this.offset - this.start, this.length);
  }
  line() {
    const chunks = [];
    for (;;) {
      const b = this.available();
      if (!b.length) {
        assert.equal(chunks.length, 0, "truncated export line");
        return null;
      }
      const end = b.indexOf(10);
      if (end >= 0) {
        chunks.push(Buffer.from(b.subarray(0, end)));
        this.offset += end + 1;
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(b));
      this.offset += b.length;
    }
  }
  data(size) {
    const b = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(this.fd, b, read, size - read, this.offset + read);
      assert(n > 0, "truncated data");
      read += n;
    }
    this.offset += size;
    return b;
  }
  close() {
    fs.closeSync(this.fd);
  }
}
function write(fd, value) {
  fs.writeFileSync(fd, value);
}
function requiredOid(value) {
  assert(sha.test(value), "full pinned SHA-1 required");
  return value;
}
function validateOutput(repo, result) {
  assert.equal(
    git(repo, ["rev-parse", branch]),
    result.tip,
    "candidate changed",
  );
  assert.equal(
    git(repo, ["for-each-ref", "--format=%(refname)"]),
    branch,
    "unexpected candidate refs",
  );
  assert.equal(
    git(repo, ["status", "--porcelain"]),
    "",
    "candidate has local edits",
  );
  for (const p of ["objects/info/alternates", "shallow", "info/grafts"])
    assert(
      !fs.existsSync(path.join(repo, ".git", p)),
      `forbidden Git dependency: ${p}`,
    );
}

/** Review is explicit input; this command never chooses the historical window,
 * reads dirty working files, changes the old repository, or pushes anything.
 * Merge results are retained as full content on a new linear history. */
export function prepareInternalSource({
  source,
  target,
  reviewFile,
  output,
  resume = false,
}) {
  source = fs.realpathSync(source);
  target = fs.realpathSync(target);
  output = path.resolve(output);
  let existing = output;
  const tail = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  assert(
    !fs.lstatSync(existing).isSymbolicLink(),
    "symlink output parent refused",
  );
  output = path.join(fs.realpathSync(existing), ...tail);
  assert(
    ![source, target].some(
      (root) => output === root || output.startsWith(root + path.sep),
    ),
    "output must be outside both input checkouts",
  );
  assert(
    !fs.existsSync(output) || !fs.lstatSync(output).isSymbolicLink(),
    "symlink output refused",
  );
  const reviewBytes = fs.readFileSync(reviewFile),
    review = JSON.parse(reviewBytes);
  assert.equal(review.schema, "myoxus.internal-source-review.v1");
  for (const key of ["tip", "baseline", "targetTip"]) requiredOid(review[key]);
  assert(/^refs\/heads\//.test(review.sourceRef));
  assert(/^refs\/heads\//.test(review.targetRef));
  assert.equal(
    git(source, ["rev-parse", review.sourceRef]),
    review.tip,
    "source ref moved",
  );
  assert.equal(
    git(target, ["rev-parse", review.targetRef]),
    review.targetTip,
    "target ref moved",
  );
  const chain = git(source, [
    "rev-list",
    "--first-parent",
    "--reverse",
    review.tip,
    `^${review.baseline}^`,
  ]).split("\n");
  assert.equal(
    chain[0],
    review.baseline,
    "baseline is not on the retained first-parent chain",
  );
  assert.deepEqual(
    review.commits.map((c) => c.oid),
    chain,
    "every retained commit requires review in order",
  );
  const trees = git(source, [
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H %T",
    review.tip,
    `^${review.baseline}^`,
  ]).split("\n");
  assert.deepEqual(
    review.commits.map((c) => `${requiredOid(c.oid)} ${requiredOid(c.tree)}`),
    trees,
    "reviewed trees changed",
  );
  assert(
    review.commits.every(
      (c) => typeof c.reason === "string" && c.reason.trim(),
    ),
    "missing commit review rationale",
  );
  const allowed = new Set(review.paths.map(safePath));
  assert.equal(allowed.size, review.paths.length, "duplicate admitted path");
  const tipPaths = git(source, ["ls-tree", "-r", "--name-only", review.tip])
    .split("\n")
    .map(decodePath);
  assert.deepEqual(
    [...allowed].sort(),
    tipPaths.filter((p) => !review.excludedPaths.includes(p)).sort(),
    "tip path disposition incomplete",
  );
  for (const required of [
    "AGENTS.md",
    "package.json",
    "yarn.lock",
    "server/Cargo.toml",
  ])
    assert(allowed.has(required), `missing private/build input: ${required}`);
  const allCommits = git(source, [
    "rev-list",
    review.tip,
    `^${review.baseline}^`,
  ]).split("\n");
  const absorbed = allCommits.filter((oid) => !chain.includes(oid)).sort();
  assert.deepEqual(
    (review.absorbedCommits ?? []).map((c) => c.oid).sort(),
    absorbed,
    "merged branch commits require explicit review/disposition",
  );
  for (const c of review.absorbedCommits ?? []) {
    assert(
      chain.includes(c.merge) && c.reason?.trim(),
      "missing merge-result disposition",
    );
    assert.equal(
      git(source, ["rev-parse", `${requiredOid(c.oid)}^{tree}`]),
      requiredOid(c.tree),
    );
    git(source, ["merge-base", "--is-ancestor", c.oid, c.merge]);
  }
  const digest = createHash("sha256").update(reviewBytes).digest("hex");
  const marker = path.join(output, "review.sha256");
  if (fs.existsSync(output) && fs.readdirSync(output).length) {
    assert(
      resume && fs.existsSync(marker),
      "nonempty output requires its original review and --resume",
    );
    assert.equal(
      fs.readFileSync(marker, "utf8"),
      digest,
      "different review cannot reuse output",
    );
    if (fs.existsSync(path.join(output, "result.json"))) {
      const result = JSON.parse(
        fs.readFileSync(path.join(output, "result.json")),
      );
      validateOutput(path.join(output, "repository"), result);
      return result;
    }
  } else {
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, digest, { mode: 0o600 });
  }
  // An interrupted attempt stays intact. Re-entry creates a distinct attempt;
  // no reset, clean, deletion, or reuse of possibly contaminated Git objects.
  const attempt = fs.mkdtempSync(path.join(output, "attempt-"));
  const exportFile = path.join(attempt, "source.export");
  const exportFd = fs.openSync(exportFile, "wx", 0o600);
  try {
    git(
      source,
      [
        "fast-export",
        "--first-parent",
        "--full-tree",
        "--show-original-ids",
        "--reference-excluded-parents",
        review.tip,
        `^${review.baseline}^`,
      ],
      { stdio: ["ignore", exportFd, "pipe"] },
    );
  } finally {
    fs.closeSync(exportFd);
  }
  const reader = new Reader(exportFile),
    blobs = new Map(),
    used = new Map(),
    mapping = [];
  const commitFile = path.join(attempt, "commits.import"),
    commitsFd = fs.openSync(commitFile, "wx", 0o600);
  let previous = new Map(),
    previousMark = null,
    count = 0;
  try {
    for (let line; (line = reader.line()) !== null;) {
      if (line === "blob") {
        const mark = reader.line();
        assert(mark.startsWith("mark :"));
        const oid = reader.line();
        assert(oid.startsWith("original-oid "));
        const data = reader.line();
        assert(/^data \d+$/.test(data));
        const length = Number(data.slice(5));
        blobs.set(mark.slice(5), {
          oid: oid.slice(13),
          offset: reader.offset,
          length,
        });
        reader.offset += length;
        assert.equal(reader.line(), "");
      } else if (line.startsWith("commit ")) {
        const metadata = [],
          current = new Map();
        let mark, oid, message;
        while ((line = reader.line()) !== "") {
          assert(line !== null, "truncated commit");
          if (line.startsWith("mark ")) mark = line.slice(5);
          else if (line.startsWith("original-oid ")) oid = line.slice(13);
          else if (line.startsWith("author ") || line.startsWith("committer "))
            metadata.push(line);
          else if (line.startsWith("data ")) {
            message = reader.data(Number(line.slice(5)));
          } else if (line.startsWith("M ")) {
            const m = /^M (\d+) (:\d+) (.+)$/.exec(line);
            assert(m, "unsupported export file entry");
            const name = decodePath(m[3]);
            if (!allowed.has(name)) continue;
            assert(
              ["100644", "100755", "120000"].includes(m[1]),
              `unadmitted gitlink/mode: ${name}`,
            );
            current.set(name, `${m[1]} ${m[2]}`);
            if (!used.has(m[2])) used.set(m[2], new Set());
            used.get(m[2]).add(`${m[1]} ${name}`);
          } else
            assert(
              line === "deleteall" ||
                line.startsWith("from ") ||
                line.startsWith("merge "),
              `unsupported export command: ${line}`,
            );
        }
        assert.equal(
          oid,
          chain[count++],
          "export order differs from reviewed chain",
        );
        assert(
          mark && message && metadata.length === 2,
          "incomplete commit metadata",
        );
        write(
          commitsFd,
          `commit ${branch}\nmark ${mark}\n${metadata.join("\n")}\ndata ${message.length}\n`,
        );
        write(commitsFd, message);
        write(commitsFd, "\n");
        if (previousMark) write(commitsFd, `from ${previousMark}\n`);
        for (const name of previous.keys())
          if (!current.has(name))
            write(commitsFd, `D ${JSON.stringify(name)}\n`);
        for (const [name, value] of current)
          if (previous.get(name) !== value)
            write(commitsFd, `M ${value} ${JSON.stringify(name)}\n`);
        write(commitsFd, "\n");
        mapping.push({ source: oid, mark });
        previous = current;
        previousMark = mark;
      } else
        assert(
          line === "" ||
            line === "done" ||
            line.startsWith("reset ") ||
            line.startsWith("from "),
          `unexpected top-level export command: ${line}`,
        );
    }
    assert.equal(count, chain.length, "incomplete export");
  } finally {
    reader.close();
    fs.closeSync(commitsFd);
  }
  const importFile = path.join(attempt, "candidate.import"),
    importFd = fs.openSync(importFile, "wx", 0o600);
  const sourceFd = fs.openSync(exportFile, "r");
  const findings = [];
  try {
    for (const [mark, names] of used) {
      const blob = blobs.get(mark);
      assert(blob, "missing exported blob");
      const content = Buffer.alloc(blob.length);
      assert.equal(
        fs.readSync(sourceFd, content, 0, content.length, blob.offset),
        content.length,
      );
      assert(
        !content
          .subarray(0, 80)
          .toString()
          .startsWith("version https://git-lfs.github.com/spec/v1"),
        "LFS pointer requires separate verified materialization before admission",
      );
      for (const entry of names) {
        const name = entry.slice(7);
        if (entry.startsWith("120000")) {
          const dest = content.toString();
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(name), dest),
          );
          assert(
            !path.posix.isAbsolute(dest) &&
              resolved !== ".." &&
              !resolved.startsWith("../"),
            `symlink escapes source: ${name}`,
          );
        }
        if (!content.includes(0)) {
          for (const finding of scanSecretContent(
            name,
            content.toString("utf8"),
          )) {
            const admitted = (review.fixtures ?? []).some(
              (f) =>
                f.blob === blob.oid &&
                f.path === name &&
                f.finding === finding &&
                f.reason?.trim(),
            );
            if (!admitted)
              findings.push({ blob: blob.oid, path: name, finding });
          }
        }
      }
      write(importFd, `blob\nmark ${mark}\ndata ${content.length}\n`);
      write(importFd, content);
      write(importFd, "\n");
    }
    fs.writeFileSync(
      path.join(output, "scan-findings.json"),
      JSON.stringify(findings, null, 2),
    );
    assert.equal(
      findings.length,
      0,
      "unreviewed secret-shaped content; inspect scan-findings.json privately",
    );
    const fd = fs.openSync(commitFile, "r"),
      buffer = Buffer.alloc(1024 * 1024);
    try {
      for (let n; (n = fs.readSync(fd, buffer)) > 0;)
        write(importFd, buffer.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(sourceFd);
    fs.closeSync(importFd);
  }
  const repo = path.join(attempt, "repository");
  fs.mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  const input = fs.openSync(importFile, "r"),
    marksFile = path.join(attempt, "marks.txt");
  try {
    git(repo, ["fast-import", "--quiet", `--export-marks=${marksFile}`], {
      stdio: [input, "pipe", "pipe"],
    });
  } finally {
    fs.closeSync(input);
  }
  git(repo, ["symbolic-ref", "HEAD", branch]);
  git(repo, ["checkout", "--quiet"]);
  const marks = new Map(
    fs
      .readFileSync(marksFile, "utf8")
      .trim()
      .split("\n")
      .map((x) => x.split(" ")),
  );
  const newCommits = git(repo, ["rev-list", "--all"]).split("\n");
  assert.equal(newCommits.length, chain.length);
  assert(
    newCommits.every((x) => !chain.includes(x)),
    "old commit identity retained",
  );
  assert.equal(
    git(repo, ["rev-list", "--max-parents=0", "--all"]).split("\n").length,
    1,
  );
  git(repo, ["fsck", "--full", "--no-reflogs"]);
  const sourceEntries = git(source, ["ls-tree", "-r", review.tip])
    .split("\n")
    .filter((line) =>
      allowed.has(decodePath(line.slice(line.indexOf("\t") + 1))),
    );
  assert.deepEqual(
    git(repo, ["ls-tree", "-r", "HEAD"]).split("\n"),
    sourceEntries,
    "candidate differs from approved tip content/modes",
  );
  const result = {
    schema: "myoxus.internal-source-result.v1",
    reviewSha256: digest,
    sourceTip: review.tip,
    targetTip: review.targetTip,
    tip: git(repo, ["rev-parse", "HEAD"]),
    root: git(repo, ["rev-list", "--max-parents=0", "HEAD"]),
    commits: mapping.map((x) => ({
      source: x.source,
      candidate: marks.get(x.mark),
    })),
    absorbedCommits: (review.absorbedCommits ?? []).map((x) => ({
      source: x.oid,
      candidate: marks.get(mapping.find((m) => m.source === x.merge).mark),
    })),
  };
  validateOutput(repo, result);
  assert.equal(
    git(source, ["rev-parse", review.sourceRef]),
    review.tip,
    "source ref moved during preparation",
  );
  assert.equal(
    git(target, ["rev-parse", review.targetRef]),
    review.targetTip,
    "target ref moved during preparation",
  );
  fs.renameSync(repo, path.join(output, "repository"));
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    const options = {};
    const keys = {
      "--source": "source",
      "--target": "target",
      "--review": "reviewFile",
      "--output": "output",
    };
    for (let i = 2; i < process.argv.length; i++) {
      const key = process.argv[i];
      if (key === "--resume") options.resume = true;
      else {
        assert(
          keys[key] && process.argv[i + 1],
          `unknown/missing argument: ${key}`,
        );
        options[keys[key]] = process.argv[++i];
      }
    }
    for (const key of Object.values(keys))
      assert(options[key], `missing ${key}`);
    const result = prepareInternalSource(options);
    console.log(
      JSON.stringify({
        tip: result.tip,
        root: result.root,
        commits: result.commits.length,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
