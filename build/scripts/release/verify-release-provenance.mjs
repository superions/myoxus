#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { validatePublicSource } from "./source-correspondence.mjs";

const BOUNDARY_MANIFEST = "build/scripts/release/release-boundary.json";
const SUPPORTED_SCHEMA = 1;
const VALID_KINDS = new Set([
  "sourceArchive",
  "manifest",
  "lockfile",
  "sbom",
  "legalBundle",
  "notice",
  "digest",
]);
const KNOWN_BOUNDARY_IDS = new Set([
  "server",
  "frontends",
  "electron-linux",
  "electron-macos",
  "electron-windows",
  "android",
  "ios",
]);
const SUPPORTED_SBOM_SPECS = new Set(["1.5", "1.6"]);
const GATE_TIMEOUT_MS = 5 * 60 * 1000;

function sha256OfFile(path) {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

function loadBoundaryManifest(repoRoot) {
  const absolute = join(repoRoot, BOUNDARY_MANIFEST);
  if (!existsSync(absolute)) {
    throw new Error(
      `${BOUNDARY_MANIFEST} is required; the release boundary schema must exist before any release gate runs.`,
    );
  }
  const parsed = JSON.parse(readFileSync(absolute, "utf8"));
  if (parsed.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(
      `${BOUNDARY_MANIFEST} schemaVersion must be ${SUPPORTED_SCHEMA}; got ${String(parsed.schemaVersion)}.`,
    );
  }
  if (!Array.isArray(parsed.boundaries) || parsed.boundaries.length === 0) {
    throw new Error(
      `${BOUNDARY_MANIFEST} must declare a non-empty boundaries array.`,
    );
  }
  const seen = new Set();
  for (const boundary of parsed.boundaries) {
    if (!boundary.id || seen.has(boundary.id)) {
      throw new Error(
        `${BOUNDARY_MANIFEST} has duplicate or missing boundary id: ${boundary.id}`,
      );
    }
    seen.add(boundary.id);
    if (!KNOWN_BOUNDARY_IDS.has(boundary.id)) {
      throw new Error(
        `${BOUNDARY_MANIFEST} boundary '${boundary.id}' is not a known channel id; allowed: ${[...KNOWN_BOUNDARY_IDS].sort().join(", ")}. To add a new channel, extend KNOWN_BOUNDARY_IDS in verify-release-provenance.mjs explicitly.`,
      );
    }
    if (typeof boundary.inRelease !== "boolean") {
      throw new Error(
        `${BOUNDARY_MANIFEST} boundary ${boundary.id} must declare inRelease as a boolean.`,
      );
    }
    if (!boundary.owner) {
      throw new Error(
        `${BOUNDARY_MANIFEST} boundary ${boundary.id} must declare owner.`,
      );
    }
    if (boundary.inRelease && !Array.isArray(boundary.requiredEvidence)) {
      throw new Error(
        `${BOUNDARY_MANIFEST} boundary ${boundary.id} is inRelease=true; requiredEvidence must be an array.`,
      );
    }
    for (const evidence of boundary.requiredEvidence ?? []) {
      if (!VALID_KINDS.has(evidence.kind)) {
        throw new Error(
          `${BOUNDARY_MANIFEST} boundary ${boundary.id} evidence kind '${evidence.kind}' is not recognised.`,
        );
      }
      if (!evidence.ref) {
        throw new Error(
          `${BOUNDARY_MANIFEST} boundary ${boundary.id} evidence must declare a ref.`,
        );
      }
    }
  }
  return parsed;
}

function resolveRevision(repoRoot, ref) {
  const result = spawnSync("git", ["rev-parse", "--verify", ref], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `could not resolve revision '${ref}': ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function validateEvidence(repoRoot, evidence) {
  const absolute = join(repoRoot, evidence.ref);
  if (!existsSync(absolute)) {
    return {
      ok: false,
      reason: `evidence missing on disk: ${evidence.ref}`,
    };
  }
  if (evidence.kind === "sourceArchive") {
    // A source archive is valid only when (a) the sidecars are present and
    // the SHA matches, and (b) the dedicated source-export verifier accepts
    // the archive end-to-end (tar layout, per-entry hashes, forbidden
    // prefixes, required top-level artefacts). We delegate the full check
    // to verify-public-source-export.mjs so this aggregator stays in sync
    // with the dedicated contract.
    const shaSidecar = `${evidence.ref}.sha256`;
    const manifest = `${evidence.ref}.manifest`;
    if (!existsSync(join(repoRoot, shaSidecar))) {
      return {
        ok: false,
        reason: `source archive sidecar missing: ${shaSidecar}`,
      };
    }
    if (!existsSync(join(repoRoot, manifest))) {
      return {
        ok: false,
        reason: `source archive manifest missing: ${manifest}`,
      };
    }
    const actual = sha256OfFile(absolute);
    const recorded = readFileSync(join(repoRoot, shaSidecar), "utf8").trim();
    if (recorded !== actual) {
      return {
        ok: false,
        reason: `source archive sha256 mismatch: file ${actual}, sidecar ${recorded}`,
      };
    }
    const validator = join(
      repoRoot,
      "build/scripts/ci/verify-public-source-export.mjs",
    );
    if (!existsSync(validator)) {
      return {
        ok: false,
        reason: `source archive validator missing: build/scripts/ci/verify-public-source-export.mjs`,
      };
    }
    const result = spawnSync("node", [validator, "--archive", evidence.ref], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: GATE_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      const findings = (result.stderr || result.stdout || "")
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .slice(0, 3)
        .join("; ");
      return {
        ok: false,
        reason: `source archive failed dedicated validator: ${findings || `exit ${result.status}`}`,
      };
    }
  }
  if (evidence.kind === "sbom") {
    // SBOM must be valid CycloneDX JSON. The current schema allows
    // specVersion 1.5 (the production target) and 1.6 (the latest stable
    // series); a bomFormat field is required by CycloneDX but does not by
    // itself prove the file is a CycloneDX document, so we also require
    // specVersion to be set and to match a supported series.
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(absolute, "utf8"));
    } catch {
      return { ok: false, reason: `sbom is not valid JSON: ${evidence.ref}` };
    }
    if (parsed.bomFormat !== "CycloneDX") {
      return {
        ok: false,
        reason: `sbom bomFormat must be 'CycloneDX' (got ${JSON.stringify(parsed.bomFormat)}): ${evidence.ref}`,
      };
    }
    if (
      typeof parsed.specVersion !== "string" ||
      !SUPPORTED_SBOM_SPECS.has(parsed.specVersion)
    ) {
      return {
        ok: false,
        reason: `sbom specVersion must be one of ${[...SUPPORTED_SBOM_SPECS].join(", ")} (got ${JSON.stringify(parsed.specVersion)}): ${evidence.ref}`,
      };
    }
  }
  if (evidence.kind === "legalBundle" || evidence.kind === "notice") {
    const body = readFileSync(absolute, "utf8");
    if (body.trim().length === 0) {
      return {
        ok: false,
        reason: `notice/legal bundle is empty: ${evidence.ref}`,
      };
    }
  }
  return { ok: true, sha256: sha256OfFile(absolute) };
}

function runOwningGate(repoRoot, gate) {
  if (!gate) return { ok: true, reason: null, skipped: true };
  // The owning gate is the canonical provenance guard for the boundary
  // (e.g. verify-server-source-provenance.mjs for `server`,
  // verify-client-source-provenance.mjs for `frontends`). A release
  // boundary cannot be `ready` if its owning gate is not green.
  // Gates may be repository-relative ("build/scripts/ci/...") or absolute
  // (self-test tempdirs use absolute paths to a stub script).
  const absoluteGate = isAbsolute(gate) ? gate : join(repoRoot, gate);
  if (!existsSync(absoluteGate)) {
    return {
      ok: false,
      reason: `owning gate command not found: ${gate}`,
      skipped: false,
    };
  }
  const result = spawnSync("node", [absoluteGate], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: GATE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "")
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .slice(0, 3)
      .join("; ");
    return {
      ok: false,
      reason: `owning gate exited ${result.status}: ${tail || gate}`,
      skipped: false,
    };
  }
  return { ok: true, reason: null, skipped: false };
}

function classifyBoundary(repoRoot, boundary) {
  if (!boundary.inRelease) {
    return {
      id: boundary.id,
      kind: boundary.kind,
      status: "not-in-release",
      owner: boundary.owner,
      exclusionReason:
        boundary.exclusionReason ?? "boundary excluded by manifest",
      requiredEvidence: boundary.requiredEvidence ?? [],
      resolvedEvidence: [],
    };
  }
  if (
    !Array.isArray(boundary.requiredEvidence) ||
    boundary.requiredEvidence.length === 0
  ) {
    return {
      id: boundary.id,
      kind: boundary.kind,
      status: "blocked",
      owner: boundary.owner,
      owningGate: boundary.owningGate ?? null,
      requiredEvidence: boundary.requiredEvidence ?? [],
      resolvedEvidence: [],
      findings: [
        `${boundary.id}: inRelease=true but requiredEvidence is empty; an included boundary without backing evidence cannot be marked ready.`,
      ],
    };
  }
  const resolved = [];
  const findings = [];
  for (const evidence of boundary.requiredEvidence) {
    const result = validateEvidence(repoRoot, evidence);
    if (!result.ok) {
      findings.push(`${boundary.id}: ${result.reason}`);
    }
    resolved.push({
      kind: evidence.kind,
      ref: evidence.ref,
      ok: result.ok,
      sha256: result.sha256 ?? null,
      reason: result.reason ?? null,
    });
  }
  const gate = runOwningGate(repoRoot, boundary.owningGate);
  if (!gate.ok) {
    findings.push(`${boundary.id}: ${gate.reason}`);
  }
  return {
    id: boundary.id,
    kind: boundary.kind,
    status: findings.length === 0 ? "ready" : "blocked",
    owner: boundary.owner,
    owningGate: boundary.owningGate ?? null,
    owningGateResult: gate,
    requiredEvidence: boundary.requiredEvidence,
    resolvedEvidence: resolved,
    findings,
  };
}

function aggregateCopyrightEvidence(repoRoot) {
  // Copyright evidence is the set of provenance manifests the release
  // boundary pulls from. The aggregated list is the canonical pointer for
  // downstream review; per-component evidence stays in the manifest itself.
  const refs = [
    "server/provenance/components.json",
    "client/provenance/components.json",
    "client/REUSE.toml",
    "client/provenance/LICENSE-UPSTREAM-MIT.txt",
  ];
  return refs
    .filter((ref) => existsSync(join(repoRoot, ref)))
    .map((ref) => ({
      ref,
      sha256: sha256OfFile(join(repoRoot, ref)),
    }));
}

function buildReport(repoRoot, publication = {}) {
  const manifest = loadBoundaryManifest(repoRoot);
  const revision = resolveRevision(
    repoRoot,
    manifest.revisionRef?.ref ?? "HEAD",
  );
  const hasPublication = Object.values(publication).some(Boolean);
  let publicSource;
  let sourceArchive = manifest.sourceArchive ?? null;
  if (hasPublication) {
    if (publication.expectedRevision !== revision)
      throw new Error(
        "Public source mapping does not match the build revision",
      );
    publicSource = validatePublicSource(revision, {
      repository: "https://github.com/superions/myoxus",
      commit: publication.publicCommit,
      ...(publication.publicTree ? { tree: publication.publicTree } : {}),
      ...(publication.archiveUrl || publication.archiveSha256 ? { archive: {
        url: publication.archiveUrl,
        sha256: publication.archiveSha256,
      } } : {}),
    });
    const archivePath = join(repoRoot, sourceArchive?.path ?? "");
    if (publicSource.archive && (
      !sourceArchive?.path ||
      sha256OfFile(archivePath) !== publicSource.archive.sha256
    )) {
      throw new Error(
        "Public source mapping does not match the actual source archive",
      );
    }
    if (publicSource.archive) sourceArchive = { ...sourceArchive, sha256: publicSource.archive.sha256 };
  }
  const boundaries = manifest.boundaries.map((b) =>
    classifyBoundary(repoRoot, b),
  );
  const allFindings = [];
  for (const boundary of boundaries) {
    for (const finding of boundary.findings ?? []) {
      allFindings.push(finding);
    }
  }
  const inReleaseReady = boundaries
    .filter((b) => b.status === "ready")
    .map((b) => b.id);
  const inReleaseBlocked = boundaries
    .filter((b) => b.status === "blocked")
    .map((b) => b.id);
  const notInRelease = boundaries
    .filter((b) => b.status === "not-in-release")
    .map((b) => b.id);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    revision,
    revisionRef: manifest.revisionRef ?? { kind: "git", ref: "HEAD" },
    sourceArchive,
    ...(publicSource ? { publicSource } : {}),
    evidenceRepositories: manifest.evidenceRepositories ?? [],
    copyrightEvidence: aggregateCopyrightEvidence(repoRoot),
    boundaries,
    summary: {
      inReleaseReady,
      inReleaseBlocked,
      notInRelease,
      findings: allFindings,
    },
  };
}

function writeReport(repoRoot, outputDir, publication) {
  mkdirSync(outputDir, { recursive: true });
  const report = buildReport(repoRoot, publication);
  const reportPath = join(outputDir, "release-provenance.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const reportSha = sha256OfFile(reportPath);
  writeFileSync(`${reportPath}.sha256`, `${reportSha}\n`);
  return { reportPath, reportSha, report };
}

function parseArgs(argv) {
  const args = {
    selfTest: false,
    outputDir: "build/dist/release-provenance",
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--self-test") {
      args.selfTest = true;
    } else if (flag === "--output-dir" && i + 1 < argv.length) {
      args.outputDir = argv[++i];
    } else if (
      [
        "--expected-revision",
        "--public-source-commit",
        "--public-source-tree",
        "--source-archive-url",
        "--source-archive-sha256",
      ].includes(flag) &&
      i + 1 < argv.length
    ) {
      const keys = {
        "--expected-revision": "expectedRevision",
        "--public-source-commit": "publicCommit",
        "--public-source-tree": "publicTree",
        "--source-archive-url": "archiveUrl",
        "--source-archive-sha256": "archiveSha256",
      };
      args.publication ??= {};
      args.publication[keys[flag]] = argv[++i];
    } else if (flag === "--root" && i + 1 < argv.length) {
      args.root = argv[++i];
    }
  }
  return args;
}

function minimalBoundary() {
  return {
    schemaVersion: 1,
    revisionRef: { kind: "git", ref: "HEAD" },
    sourceArchive: {
      path: "export.tar",
      manifest: "export.tar.manifest",
      sha256Sidecar: "export.tar.sha256",
    },
    evidenceRepositories: [],
    boundaries: [
      {
        id: "server",
        kind: "server",
        inRelease: true,
        owner: "test-owner",
        requiredEvidence: [
          { kind: "sourceArchive", ref: "export.tar" },
          { kind: "manifest", ref: "server-provenance.json" },
          { kind: "lockfile", ref: "server.lock" },
        ],
        owningGate: "echo",
      },
      {
        id: "android",
        kind: "mobile",
        inRelease: false,
        owner: "mobile-owner",
        requiredEvidence: [],
        owningGate: "echo",
        exclusionReason: "mobile not in release",
      },
    ],
  };
}

function buildArchiveFixture(extractDir) {
  writeFileSync(join(extractDir, "LICENSE"), "AGPL-3.0-or-later\n");
  writeFileSync(join(extractDir, "yarn.lock"), "# lock\n");
  const archive = join(extractDir, "export.tar");
  const result = spawnSync("tar", ["-cf", archive, "-C", extractDir, "."], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
  writeFileSync(`${archive}.sha256`, `${sha256OfFile(archive)}\n`);
  // Manifest with one entry covering the LICENSE.
  const licenseHash = sha256OfFile(join(extractDir, "LICENSE"));
  writeFileSync(
    `${archive}.manifest`,
    `# myoxus public-source export manifest\n# revision: self-test\n#\n${licenseHash}  LICENSE\n`,
  );
  return archive;
}

function initTempRepo(root) {
  // The verifier resolves the configured revision via `git rev-parse`, so
  // the tempdir used in self-test must be a working git repo.
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "self-test",
    GIT_AUTHOR_EMAIL: "self@test",
    GIT_COMMITTER_NAME: "self-test",
    GIT_COMMITTER_EMAIL: "self@test",
  };
  spawnSync("git", ["init", "-q", "--initial-branch=main", root], {
    env: gitEnv,
  });
  spawnSync("git", ["-C", root, "config", "user.email", "self@test"], {
    env: gitEnv,
  });
  spawnSync("git", ["-C", root, "config", "user.name", "self-test"], {
    env: gitEnv,
  });
  spawnSync("git", ["-C", root, "add", "-A"], { env: gitEnv });
  spawnSync("git", ["-C", root, "commit", "-q", "-m", "self-test"], {
    env: gitEnv,
  });
}

function buildOwningGateStub(root) {
  // The real owning gates (verify-server-source-provenance.mjs,
  // verify-client-source-provenance.mjs, ...) live next to this verifier
  // in production. In the self-test tempdir we drop a tiny no-op script
  // that always exits 0, so the positive fixture's gate check passes.
  const gate = join(root, "gate-stub.mjs");
  writeFileSync(gate, "process.exit(0);\n");
  return gate;
}

function buildFailingGateStub(root) {
  const gate = join(root, "gate-fail.mjs");
  writeFileSync(
    gate,
    "process.stderr.write('- simulated gate failure\\n'); process.exit(1);\n",
  );
  return gate;
}

function buildSourceArchiveValidatorStub(root) {
  // The real source-archive validator is build/scripts/ci/verify-public-source-export.mjs;
  // the tempdir self-test creates a sibling stub that always exits 0.
  const dir = join(root, "build", "scripts", "ci");
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, "verify-public-source-export.mjs");
  writeFileSync(stub, "process.exit(0);\n");
  return stub;
}

function makeSourceArchiveValidatorFail(root, message) {
  const stub = join(
    root,
    "build",
    "scripts",
    "ci",
    "verify-public-source-export.mjs",
  );
  writeFileSync(
    stub,
    `process.stderr.write(${JSON.stringify(`- ${message}\n`)}); process.exit(1);\n`,
  );
}

function assertSelfTest() {
  const root = mkdtempSync(join(tmpdir(), "myoxus-release-"));
  // Mirror the production layout under <root> so the verifier looks at
  // build/scripts/release/release-boundary.json the same way it does in CI.
  const manifestDir = join(root, "build", "scripts", "release");
  mkdirSync(manifestDir, { recursive: true });
  buildSourceArchiveValidatorStub(root);
  const passingGate = buildOwningGateStub(root);
  try {
    // --- Positive: all inRelease boundaries are ready ---
    writeFileSync(join(root, "server-provenance.json"), "{}\n");
    writeFileSync(join(root, "server.lock"), "# lock\n");
    writeFileSync(join(root, "client-provenance.json"), "{}\n");
    const archive = buildArchiveFixture(root);
    const manifest = minimalBoundary();
    manifest.sourceArchive.path = "export.tar";
    manifest.boundaries[0].owningGate = passingGate;
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    initTempRepo(root);

    const repoRoot = root;
    process.chdir(repoRoot);
    const positive = buildReport(repoRoot);
    if (
      positive.summary.inReleaseReady.length !== 1 ||
      positive.summary.inReleaseReady[0] !== "server"
    ) {
      throw new Error(
        `positive fixture did not yield exactly one ready boundary: ${JSON.stringify(positive.summary)}`,
      );
    }
    if (positive.summary.inReleaseBlocked.length !== 0) {
      throw new Error(
        `positive fixture reported blocked boundaries: ${positive.summary.inReleaseBlocked.join(", ")}`,
      );
    }
    if (positive.summary.notInRelease.length !== 1) {
      throw new Error(
        `positive fixture did not exclude android: ${JSON.stringify(positive.summary.notInRelease)}`,
      );
    }

    // --- Negative: missing inRelease evidence makes boundary blocked ---
    rmSync(join(root, "server.lock"));
    const blocked = buildReport(repoRoot);
    if (!blocked.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `missing-evidence did not block: ${JSON.stringify(blocked.summary.inReleaseBlocked)}`,
      );
    }
    if (blocked.summary.findings.length === 0) {
      throw new Error(
        `missing-evidence fixture did not surface any findings: ${JSON.stringify(blocked.summary.findings)}`,
      );
    }

    // --- Negative: tampered archive sha256 is blocked ---
    writeFileSync(join(root, "server.lock"), "# lock\n");
    writeFileSync(`${archive}.sha256`, "0".repeat(64));
    const tampered = buildReport(repoRoot);
    if (!tampered.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `tampered-sha fixture did not block: ${JSON.stringify(tampered.summary.inReleaseBlocked)}`,
      );
    }
    writeFileSync(`${archive}.sha256`, `${sha256OfFile(archive)}\n`);

    // --- Negative: copyright failure in the delegated source validator blocks ---
    makeSourceArchiveValidatorFail(
      root,
      "client provenance: F1 removed required upstream attribution",
    );
    const copyrightBlocked = buildReport(repoRoot);
    if (!copyrightBlocked.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `copyright-validator failure did not block: ${JSON.stringify(copyrightBlocked.summary.inReleaseBlocked)}`,
      );
    }
    if (
      !copyrightBlocked.summary.findings.some((finding) =>
        finding.includes("removed required upstream attribution"),
      )
    ) {
      throw new Error(
        `copyright-validator failure was not preserved: ${JSON.stringify(copyrightBlocked.summary.findings)}`,
      );
    }
    buildSourceArchiveValidatorStub(root);

    // --- Negative: empty requiredEvidence for an inRelease boundary is blocked ---
    manifest.boundaries[0].requiredEvidence = [];
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const emptyEvidence = buildReport(repoRoot);
    if (emptyEvidence.summary.inReleaseReady.includes("server")) {
      throw new Error(
        `empty-requiredEvidence did not block: ${JSON.stringify(emptyEvidence.summary.inReleaseReady)}`,
      );
    }

    // --- Negative: missing boundary manifest is rejected loudly ---
    rmSync(join(manifestDir, "release-boundary.json"));
    let manifestMissing = false;
    try {
      buildReport(repoRoot);
    } catch (error) {
      manifestMissing = true;
      if (!String(error).includes("required")) {
        throw new Error(
          `missing-manifest produced wrong error: ${String(error)}`,
        );
      }
    }
    if (!manifestMissing) {
      throw new Error("missing-manifest did not throw");
    }

    // --- Negative: bad schemaVersion is rejected loudly ---
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify({ ...minimalBoundary(), schemaVersion: 2 }, null, 2)}\n`,
    );
    let schemaFailed = false;
    try {
      buildReport(repoRoot);
    } catch (error) {
      schemaFailed = true;
      if (!String(error).includes("schemaVersion")) {
        throw new Error(`bad-schema produced wrong error: ${String(error)}`);
      }
    }
    if (!schemaFailed) {
      throw new Error("bad-schema did not throw");
    }

    // --- Negative: SBOM file is non-JSON ---
    manifest.boundaries[0].requiredEvidence = [
      { kind: "manifest", ref: "server-provenance.json" },
      { kind: "lockfile", ref: "server.lock" },
      { kind: "sbom", ref: "server-sbom.cdx.json" },
    ];
    writeFileSync(join(root, "server-sbom.cdx.json"), "not json");
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const badSbom = buildReport(repoRoot);
    if (!badSbom.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `bad-sbom did not block: ${JSON.stringify(badSbom.summary.inReleaseBlocked)}`,
      );
    }

    // --- Negative: empty notice/legal bundle is blocked ---
    writeFileSync(
      join(root, "server-sbom.cdx.json"),
      JSON.stringify({ bomFormat: "CycloneDX" }),
    );
    manifest.boundaries[0].requiredEvidence = [
      { kind: "manifest", ref: "server-provenance.json" },
      { kind: "lockfile", ref: "server.lock" },
      { kind: "legalBundle", ref: "server-legal/NOTICE.md" },
    ];
    mkdirSync(join(root, "server-legal"), { recursive: true });
    writeFileSync(join(root, "server-legal", "NOTICE.md"), "");
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const emptyNotice = buildReport(repoRoot);
    if (!emptyNotice.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `empty-notice did not block: ${JSON.stringify(emptyNotice.summary.inReleaseBlocked)}`,
      );
    }

    // --- Negative: missing source archive (boundary still has the ref) ---
    writeFileSync(join(root, "server-legal", "NOTICE.md"), "real notice\n");
    manifest.boundaries[0].requiredEvidence = [
      { kind: "sourceArchive", ref: "missing-export.tar" },
      { kind: "manifest", ref: "server-provenance.json" },
      { kind: "lockfile", ref: "server.lock" },
    ];
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const missingArchive = buildReport(repoRoot);
    if (!missingArchive.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `missing-source-archive did not block: ${JSON.stringify(missingArchive.summary.inReleaseBlocked)}`,
      );
    }

    // --- Negative: unresolvable OCI digest ref is blocked ---
    manifest.boundaries[0].requiredEvidence = [
      { kind: "manifest", ref: "server-provenance.json" },
      { kind: "lockfile", ref: "server.lock" },
      { kind: "digest", ref: "build/dist/oci-digest.txt" },
    ];
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const unresolvableDigest = buildReport(repoRoot);
    if (!unresolvableDigest.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `unresolvable-digest did not block: ${JSON.stringify(unresolvableDigest.summary.inReleaseBlocked)}`,
      );
    }

    // --- Negative: wrong revision ref is rejected loudly ---
    manifest.boundaries[0].requiredEvidence = [
      { kind: "sourceArchive", ref: "export.tar" },
      { kind: "manifest", ref: "server-provenance.json" },
      { kind: "lockfile", ref: "server.lock" },
    ];
    manifest.revisionRef = { kind: "git", ref: "this-ref-does-not-exist" };
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    let wrongRevision = false;
    try {
      buildReport(repoRoot);
    } catch (error) {
      wrongRevision = true;
      if (!String(error).includes("could not resolve revision")) {
        throw new Error(
          `wrong-revision produced wrong error: ${String(error)}`,
        );
      }
    }
    if (!wrongRevision) {
      throw new Error("wrong-revision did not throw");
    }

    // --- Negative: unknown boundary id is rejected by the schema validator ---
    manifest.revisionRef = { kind: "git", ref: "HEAD" };
    const rogueManifest = {
      ...manifest,
      boundaries: [
        {
          id: "rogue-channel",
          kind: "experimental",
          inRelease: true,
          owner: "rogue",
          requiredEvidence: [],
        },
      ],
    };
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(rogueManifest, null, 2)}\n`,
    );
    let rogueRejected = false;
    try {
      buildReport(repoRoot);
    } catch (error) {
      rogueRejected = true;
      if (!String(error).includes("not a known channel id")) {
        throw new Error(
          `unknown-boundary produced wrong error: ${String(error)}`,
        );
      }
    }
    if (!rogueRejected) {
      throw new Error("unknown-boundary did not throw");
    }

    // --- Negative: SBOM with wrong specVersion is rejected ---
    writeFileSync(
      join(root, "server-sbom.cdx.json"),
      JSON.stringify({ bomFormat: "CycloneDX", specVersion: "0.1" }),
    );
    manifest.boundaries[0].requiredEvidence = [
      { kind: "sourceArchive", ref: "export.tar" },
      { kind: "manifest", ref: "server-provenance.json" },
      { kind: "lockfile", ref: "server.lock" },
      { kind: "sbom", ref: "server-sbom.cdx.json" },
    ];
    manifest.boundaries[0].owningGate = passingGate;
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const wrongSpec = buildReport(repoRoot);
    if (!wrongSpec.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `wrong-sbom-spec did not block: ${JSON.stringify(wrongSpec.summary.inReleaseBlocked)}`,
      );
    }
    if (!wrongSpec.summary.findings.some((f) => f.includes("specVersion"))) {
      throw new Error(
        `wrong-sbom-spec did not surface specVersion finding: ${JSON.stringify(wrongSpec.summary.findings)}`,
      );
    }

    // --- Negative: SBOM missing bomFormat entirely is rejected ---
    writeFileSync(
      join(root, "server-sbom.cdx.json"),
      JSON.stringify({ specVersion: "1.5" }),
    );
    const missingBomFormat = buildReport(repoRoot);
    if (!missingBomFormat.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `missing-bomformat did not block: ${JSON.stringify(missingBomFormat.summary.inReleaseBlocked)}`,
      );
    }

    // --- Negative: failing owning gate is rejected ---
    const failingGate = buildFailingGateStub(root);
    writeFileSync(
      join(root, "server-sbom.cdx.json"),
      JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5" }),
    );
    manifest.boundaries[0].requiredEvidence = [
      { kind: "sourceArchive", ref: "export.tar" },
      { kind: "manifest", ref: "server-provenance.json" },
      { kind: "lockfile", ref: "server.lock" },
    ];
    manifest.boundaries[0].owningGate = failingGate;
    writeFileSync(
      join(manifestDir, "release-boundary.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const gateFails = buildReport(repoRoot);
    if (!gateFails.summary.inReleaseBlocked.includes("server")) {
      throw new Error(
        `failing-owning-gate did not block: ${JSON.stringify(gateFails.summary.inReleaseBlocked)}`,
      );
    }
    if (!gateFails.summary.findings.some((f) => f.includes("owning gate"))) {
      throw new Error(
        `failing-owning-gate did not surface gate finding: ${JSON.stringify(gateFails.summary.findings)}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv);

if (args.selfTest) {
  assertSelfTest();
  console.log("verify-release-provenance self-test passed.");
  process.exit(0);
}

const root = args.root ?? process.cwd();
const { reportPath, reportSha, report } = writeReport(
  root,
  args.outputDir,
  args.publication,
);
console.log(`Release provenance report: ${reportPath}`);
console.log(`Report sha256: ${reportSha}`);
if (report.summary.inReleaseBlocked.length > 0) {
  console.error("Release boundary blocked:");
  for (const finding of report.summary.findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(
  `Release boundaries ok: ready=${report.summary.inReleaseReady.length}, ` +
    `not-in-release=${report.summary.notInRelease.length}, ` +
    `blocked=${report.summary.inReleaseBlocked.length}`,
);
