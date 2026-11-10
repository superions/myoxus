// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { writeReleaseMetadata } from "./write-desktop-release-metadata.mjs";
import { verifyReleaseMetadata } from "./verify-desktop-release-metadata.mjs";
import { writeHomebrewCask } from "./write-homebrew-cask.mjs";
import {
  expectedAssets,
  platformsForScope,
} from "../release/forgejo-client-release.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-client-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, "release");
  fs.mkdirSync(path.join(releaseDir, "macos"), { recursive: true });
  const evidence = {};
  for (const arch of ["x64", "arm64"]) {
    for (const format of ["dmg", "zip"]) {
      const name = `myoxus-1.2.3-stable-macos-${arch}.${format}`;
      const bytes = Buffer.from(`fixture ${name}`);
      fs.writeFileSync(path.join(releaseDir, "macos", name), bytes);
      evidence[name] = {
        status: "ad-hoc",
        verifier: "codesign",
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    }
  }
  const sbom = path.join(releaseDir, "sbom.cdx.json");
  fs.writeFileSync(
    sbom,
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      metadata: { component: { version: "1.2.3" } },
      components: [{ name: "electron" }, { name: "mediabunny" }],
    }),
  );
  const signatureEvidence = path.join(root, "signatures.json");
  fs.writeFileSync(signatureEvidence, JSON.stringify(evidence));
  process.env.SOURCE_DATE_EPOCH = "0";
  const options = {
    releaseDir,
    sbom,
    signatureEvidence,
    version: "1.2.3",
    channel: "stable",
    sourceCommit: "a".repeat(40),
    scope: "macos",
    sourceRepository: "myoxus/myoxus",
    runId: "42",
    builderId: "https://git.blume29.de/myoxus/myoxus/actions/runs/42",
  };
  return {
    options,
    evidence,
    writeEvidence: () =>
      fs.writeFileSync(signatureEvidence, JSON.stringify(evidence)),
  };
}

test("macOS publication binds four artifacts and two exact updater ZIPs", (t) => {
  const { options } = fixture(t);
  const manifest = writeReleaseMetadata(options);
  assert.equal(manifest.publishable, true);
  assert.equal(manifest.artifacts.length, 4);
  assert.ok(manifest.artifacts.every((a) => a.signature.status === "ad-hoc"));
  const checked = verifyReleaseMetadata(options.releaseDir, true);
  assert.equal(checked.scope, "macos");
  const update = parseYaml(
    fs.readFileSync(path.join(options.releaseDir, "latest.yml"), "utf8"),
  );
  assert.deepEqual(update.files.map((f) => f.url).sort(), [
    "myoxus-1.2.3-stable-macos-arm64.zip",
    "myoxus-1.2.3-stable-macos-x64.zip",
  ]);
  const cask = writeHomebrewCask(
    options.releaseDir,
    path.join(path.dirname(options.releaseDir), "tap-preview"),
  );
  assert.equal(cask.path, "Casks/myoxus.rb");
  for (const artifact of checked.artifacts.filter((a) => a.format === "dmg")) {
    assert.ok(cask.source.includes(artifact.sha256));
  }
  assert.match(
    cask.source,
    /macos-client-v1\.2\.3\/myoxus-1\.2\.3-stable-macos-#\{arch\}\.dmg/,
  );
  assert.match(cask.source, /app "Myoxus\.app"/);
});

test("missing architecture, wrong signatures and changed package bytes cannot publish", (t) => {
  for (const mutation of [
    (f, name) => {
      delete f.evidence[name];
    },
    (f, name) => {
      f.evidence[name].status = "signed";
    },
    (f, name) => {
      f.evidence[name].verifier = "none";
    },
    (f, name) => {
      f.evidence[name].certificateFingerprint = "a".repeat(64);
    },
    (f, name) => {
      f.evidence[name].sha256 = "0".repeat(64);
    },
    (f, name) =>
      fs.appendFileSync(
        path.join(f.options.releaseDir, "macos", name),
        "tamper",
      ),
    (f, name) => fs.unlinkSync(path.join(f.options.releaseDir, "macos", name)),
  ]) {
    const f = fixture(t);
    mutation(f, Object.keys(f.evidence)[0]);
    f.writeEvidence();
    assert.throws(() => writeReleaseMetadata(f.options));
  }
});

test("verifier rejects false signing, unsigned, diagnostic and fabricated certificate claims", (t) => {
  const { options } = fixture(t);
  const original = writeReleaseMetadata(options);
  for (const mutation of [
    (m) => {
      m.artifacts[0].signature.status = "signed";
    },
    (m) => {
      m.artifacts[0].signature.status = "unsigned";
    },
    (m) => {
      m.artifacts[0].signature.status = "unsigned-test";
    },
    (m) => {
      m.artifacts[0].signature.verifier = "none";
    },
    (m) => {
      m.artifacts[0].signature.certificateFingerprint = "a".repeat(64);
    },
    (m) => {
      m.scope = "full";
    },
  ]) {
    const manifest = structuredClone(original);
    mutation(manifest);
    fs.writeFileSync(
      path.join(options.releaseDir, "desktop-release.json"),
      JSON.stringify(manifest),
    );
    assert.throws(() => verifyReleaseMetadata(options.releaseDir, true));
  }
});

test("client orchestration includes macOS by default and supports a bounded platform", () => {
  assert.deepEqual(platformsForScope(), ["linux", "windows", "macos"]);
  assert.deepEqual(platformsForScope("macos"), ["macos"]);
  assert.throws(() => platformsForScope("all"));
  assert.throws(() => expectedAssets("clients", "1.2.3"));
  const assets = expectedAssets("macos", "1.2.3");
  assert.equal(assets.filter((n) => /\.(dmg|zip)$/.test(n)).length, 4);
  assert.ok(assets.includes("latest.yml"));
  assert.ok(!assets.some((n) => n.endsWith(".exe")));
});

test("normal macOS release owns build and publish without full-scope dependencies", () => {
  const workflow = parseYaml(
    fs.readFileSync(".forgejo/workflows/release-desktop.yml", "utf8"),
  );
  assert.ok(
    workflow.on.workflow_dispatch.inputs.scope.options.includes("macos"),
  );
  const job = workflow.jobs["macos-client-packages"];
  assert.equal(
    job.if,
    "${{ inputs.scope == 'clients' || inputs.scope == 'macos' }}",
  );
  assert.equal(job.needs, "contract-preflight");
  assert.deepEqual(job["runs-on"], [
    "self-hosted",
    "macos",
    "x64",
    "electron-macos-x64",
  ]);
  assert.ok(
    job.steps.some((s) => s.run?.includes("run-release-macos-packages.sh")),
  );
  assert.ok(
    job.steps.some((s) => s.run?.includes("publish-electron-release.mjs")),
  );
  const stage = job.steps.find((s) =>
    s.run?.includes("stage-runner-artifacts.sh"),
  );
  assert.ok(
    stage.run.includes("${CI_RUNNER_CACHE:-$HOME/Library/Caches/myoxus-ci}"),
  );
  assert.ok(!JSON.stringify(job).includes("APPLE_"));
  assert.equal(
    workflow.jobs["macos-packages"].if,
    "${{ inputs.scope == 'full' }}",
  );
});
