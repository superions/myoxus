#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  BUILD_ONLY_SCHEMA,
  validateBuildOnlyEvidence,
} from "./macos-build-only-evidence.mjs";

const cell = {
  platform: "macos",
  arch: "arm64",
  version: "1.2.3",
  channel: "stable",
  sourceCommit: "a".repeat(40),
  formats: ["dmg", "zip"],
};

function fixture(t, format = "dmg") {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "myoxus-arm-evidence-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const name = `myoxus-1.2.3-stable-macos-arm64.${format}`;
  fs.writeFileSync(path.join(directory, name), "fixture-package");
  return {
    directory,
    evidence: {
      schema: BUILD_ONLY_SCHEMA,
      ...Object.fromEntries(
        Object.entries(cell).filter(([key]) => key !== "formats"),
      ),
      format,
      buildHost: { platform: "darwin", arch: "x64" },
      runtime: { status: "not_run", reason: "cross_compiled_arm64_on_x64" },
      package: {
        name,
        sha256: createHash("sha256").update("fixture-package").digest("hex"),
      },
    },
  };
}

test("both ARM64 formats have explicit build-only evidence", (t) => {
  for (const format of cell.formats) {
    const f = fixture(t, format);
    validateBuildOnlyEvidence(f.evidence, cell, f.directory);
  }
});

test("build-only cannot stand in for native test success or another release", (t) => {
  const f = fixture(t);
  for (const mutation of [
    (e) => {
      e.runtime.status = "passed";
    },
    (e) => {
      e.runtime.reason = "skipped";
    },
    (e) => {
      e.buildHost.arch = "arm64";
    },
    (e) => {
      e.arch = "x64";
    },
    (e) => {
      e.platform = "linux";
    },
    (e) => {
      e.sourceCommit = "b".repeat(40);
    },
    (e) => {
      e.version = "1.2.4";
    },
    (e) => {
      e.channel = "beta";
    },
    (e) => {
      e.format = "exe";
    },
    (e) => {
      e.flowId = "fabricated-flow";
    },
    (e) => {
      e.package.name = "../package.dmg";
    },
    (e) => {
      e.package.sha256 = "0".repeat(64);
    },
  ]) {
    const evidence = structuredClone(f.evidence);
    mutation(evidence);
    assert.throws(() => validateBuildOnlyEvidence(evidence, cell, f.directory));
  }
  for (const override of [
    { arch: "x64" },
    { platform: "linux" },
    { formats: ["zip"] },
  ]) {
    assert.throws(() =>
      validateBuildOnlyEvidence(
        f.evidence,
        { ...cell, ...override },
        f.directory,
      ),
    );
  }
});

test("changed, missing and symlinked packages are rejected", (t) => {
  const f = fixture(t);
  const file = path.join(f.directory, f.evidence.package.name);
  fs.writeFileSync(file, "different-package");
  assert.throws(() => validateBuildOnlyEvidence(f.evidence, cell, f.directory));
  fs.unlinkSync(file);
  assert.throws(() => validateBuildOnlyEvidence(f.evidence, cell, f.directory));
  fs.writeFileSync(path.join(f.directory, "other"), "fixture-package");
  fs.symlinkSync("other", file);
  assert.throws(() => validateBuildOnlyEvidence(f.evidence, cell, f.directory));
});

test("Mach-O guard checks every binding and propagates architecture failure", (t) => {
  const { directory } = fixture(t);
  const bin = path.join(directory, "bin");
  const app = path.join(directory, "Myoxus.app");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  for (const name of ["crypto.node", "media.node", "storage.node", "Myoxus"]) {
    fs.writeFileSync(
      path.join(app, "Contents", "MacOS", name),
      Buffer.from("cffaedfe", "hex"),
    );
  }
  fs.writeFileSync(path.join(bin, "file"), "#!/bin/sh\necho Mach-O\n", {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(bin, "otool"),
    "#!/bin/sh\n[ \"$1\" = -m ] || exit 7\nprintf 'Load command 0\\n cmd LC_LOAD_DYLIB\\n name /usr/lib/libSystem.B.dylib (offset 24)\\n'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "plutil"), "#!/bin/sh\nprintf Myoxus\n", {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(bin, "lipo"),
    '#!/bin/sh\n[ "$2" = -verify_arch ] && [ "$3" = arm64 ] || exit 5\ncase "$1" in *"${FAIL_FILE:-no-match}"*) exit 6;; esac\n',
    { mode: 0o755 },
  );
  const run = (extra) =>
    spawnSync(
      "bash",
      ["build/scripts/ci/verify-macos-bundle-architecture.sh", app, "arm64"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra },
      },
    );
  assert.equal(run({}).status, 0);
  assert.notEqual(run({ FAIL_FILE: "crypto.node" }).status, 0);
  fs.unlinkSync(path.join(app, "Contents", "MacOS", "crypto.node"));
  assert.notEqual(run({}).status, 0);
});

test("ad-hoc signature guard drains metadata and preserves codesign failures", (t) => {
  const { directory } = fixture(t);
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "codesign"),
    `#!/bin/bash
set -euo pipefail
if [ "$1" = --verify ]; then
  exit "\${VERIFY_EXIT:-0}"
fi
test "$1" = -dv
printf 'Signature=%s\\n' "\${SIGNATURE:-adhoc}" >&2
if [ "\${AUTHORITY:-}" = yes ]; then
  printf 'Authority=Fixture distribution identity\\n' >&2
fi
# More than a pipe buffer after the match reliably reproduces early-reader exit.
for ((i=0; i<8192; i++)); do
  printf 'Metadata padding %s: 0123456789012345678901234567890123456789\\n' "$i" >&2
done
exit "\${DISPLAY_EXIT:-0}"
`,
    { mode: 0o755 },
  );
  const run = (extra) =>
    spawnSync(
      "bash",
      ["build/scripts/ci/verify-macos-adhoc-signature.sh", "Myoxus.app"],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra },
      },
    );
  assert.equal(run({}).status, 0);
  assert.equal(run({ VERIFY_EXIT: "7" }).status, 7);
  assert.equal(run({ DISPLAY_EXIT: "8" }).status, 8);
  assert.equal(run({ SIGNATURE: "invalid" }).status, 1);
  assert.equal(run({ AUTHORITY: "yes" }).status, 1);
});
