#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * High-confidence secret-content scan for a public-source export tree.
 *
 * This complements verify-public-source-export.mjs, which only checks that
 * forbidden internal *paths* are absent. It does not prove that no secret
 * material is embedded inside an otherwise allow-listed file. This scanner
 * greps extracted file contents for high-confidence credential patterns
 * (private key blocks, cloud/provider token prefixes, URL-embedded
 * credentials). Patterns are intentionally conservative to avoid false
 * positives on ordinary test fixtures and documentation prose.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const BINARY_EXTENSION_RE =
  /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|eot|pdf|zip|tar|gz|xz|zst|wasm|node|so|dylib|dll|exe|bin|db|sqlite3?)$/i;

const SECRET_PATTERNS = [
  {
    name: "private-key-block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  {
    // Requires a domain-shaped host (e.g. "db.example.com") after the
    // credential so local dev defaults such as "postgres://postgres:postgres
    // @postgres:5432" (bare service name, no dot) do not match. Real secrets
    // pointing at an actual external host still trigger a manual review.
    name: "url-embedded-credential",
    re: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^\s"'/:@]+):([^\s"'/@]+)@([a-zA-Z0-9.-]*\.[a-zA-Z]{2,})(?::\d+)?\b/,
  },
];

// RFC 2606 reserved documentation domains and common obviously-fake
// credential words used in tests/fixtures for URL-credential handling.
// These never indicate a real leaked secret.
const PLACEHOLDER_HOSTS =
  /^(?:[a-z0-9.-]+\.)?(?:example\.(?:com|org|net)|test|invalid|localhost)$/i;
const PLACEHOLDER_CREDENTIAL_WORDS = new Set([
  "user",
  "username",
  "pass",
  "password",
  "secret",
  "admin",
  "root",
  "test",
  "changeme",
  "dummy",
  "fake",
  "example",
  "foo",
  "bar",
  "hunter2",
]);

function isPlaceholderCredential(username, password, host) {
  if (PLACEHOLDER_HOSTS.test(host)) return true;
  return (
    PLACEHOLDER_CREDENTIAL_WORDS.has(username.toLowerCase()) ||
    PLACEHOLDER_CREDENTIAL_WORDS.has(password.toLowerCase())
  );
}

function isProbablyBinary(path) {
  return BINARY_EXTENSION_RE.test(path);
}

// Manually reviewed, path-and-pattern-exact suppressions for synthetic
// test/doc fixtures that legitimately contain key-shaped or credential-shaped
// placeholder text (e.g. "test", "abc", "do-not-expose"). Adding an entry
// here requires a human to have read the actual match and confirmed it is not
// a real secret; it does not suppress any other finding in the same file.
const REVIEWED_FIXTURE_ALLOWLIST = new Set([
  "private-key-block:server/crates/infrastructure/src/git_sync/git2_adapter.rs",
  "url-embedded-credential:server/crates/cli/src/backup.rs",
  "private-key-block:server/crates/api/tests/contract/graphql/graphql_git_sync_profile_test.rs",
  "private-key-block:server/crates/api/tests/auth/auth_oidc_ou_sync_test.rs",
  "private-key-block:server/crates/api/src/git_sync_engine/credential.rs",
]);

function isReviewedFixture(patternName, relativePath) {
  return REVIEWED_FIXTURE_ALLOWLIST.has(`${patternName}:${relativePath}`);
}

// History reconstruction must inspect every admitted blob, including versions
// that no longer occur at the tip, without materializing an old working tree.
export function scanSecretContent(relativePath, content) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.re.exec(content);
    if (!match) continue;
    if (
      pattern.name === "url-embedded-credential" &&
      isPlaceholderCredential(match[1], match[2], match[3])
    )
      continue;
    if (isReviewedFixture(pattern.name, relativePath)) continue;
    findings.push(`possible ${pattern.name} in ${relativePath}`);
  }
  return findings;
}

function listFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  return files;
}

/**
 * Scans every non-binary file under `extractDir` for high-confidence secret
 * patterns. Returns an array of human-readable finding strings; an empty
 * array means the scan found nothing.
 */
export function scanForSecrets(extractDir) {
  const findings = [];
  for (const absolute of listFiles(extractDir)) {
    const relativePath = relative(extractDir, absolute);
    if (isProbablyBinary(relativePath)) continue;
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    // Skip large files; genuine credential lines are always short.
    if (stat.size > 5 * 1024 * 1024) continue;

    let content;
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }

    findings.push(...scanSecretContent(relativePath, content));
  }
  return findings;
}

function parseArgs(argv) {
  const args = { dir: null, selfTest: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--self-test") {
      args.selfTest = true;
    } else if (flag === "--dir" && i + 1 < argv.length) {
      args.dir = argv[++i];
    }
  }
  return args;
}

function assertSelfTest() {
  const dir = mkdtempSync(join(tmpdir(), "myoxus-secret-scan-"));
  try {
    // Positive: clean tree with no secrets.
    writeFileSync(join(dir, "README.md"), "# Myoxus\nNo secrets here.\n");
    const clean = scanForSecrets(dir);
    if (clean.length !== 0) {
      throw new Error(`clean fixture reported findings: ${clean.join("; ")}`);
    }

    // Negative: private key block must be caught. Split so this file's own
    // fixture text does not match its own pattern when this script itself
    // is scanned as part of a real export.
    writeFileSync(
      join(dir, "leaked-key.pem"),
      "-----BEGIN " +
        "RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----\n",
    );
    const keyFindings = scanForSecrets(dir);
    if (!keyFindings.some((f) => f.includes("private-key-block"))) {
      throw new Error(
        `private key fixture did not fail: ${keyFindings.join("; ")}`,
      );
    }
    rmSync(join(dir, "leaked-key.pem"));

    // Positive: an allowlisted path+pattern pair must stay suppressed.
    mkdirSync(join(dir, "server/crates/infrastructure/src/git_sync"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "server/crates/infrastructure/src/git_sync/git2_adapter.rs"),
      "-----BEGIN " + "OPENSSH PRIVATE KEY-----\ntest\n-----END KEY-----\n",
    );
    const allowlistedFindings = scanForSecrets(dir);
    if (allowlistedFindings.some((f) => f.includes("git2_adapter.rs"))) {
      throw new Error(
        `allowlisted fixture incorrectly flagged: ${allowlistedFindings.join("; ")}`,
      );
    }
    rmSync(join(dir, "server"), { recursive: true, force: true });

    // Negative: the same pattern at a non-allowlisted path must still fail.
    mkdirSync(join(dir, "server/crates/other"), { recursive: true });
    writeFileSync(
      join(dir, "server/crates/other/leaked.rs"),
      "-----BEGIN " + "OPENSSH PRIVATE KEY-----\ntest\n-----END KEY-----\n",
    );
    const nonAllowlistedFindings = scanForSecrets(dir);
    if (!nonAllowlistedFindings.some((f) => f.includes("leaked.rs"))) {
      throw new Error(
        `non-allowlisted fixture did not fail: ${nonAllowlistedFindings.join("; ")}`,
      );
    }
    rmSync(join(dir, "server"), { recursive: true, force: true });

    // Negative: GitHub token must be caught.
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(
      join(dir, "sub", "config.env"),
      `GITHUB_TOKEN=ghp_${"a".repeat(36)}\n`,
    );
    const tokenFindings = scanForSecrets(dir);
    if (!tokenFindings.some((f) => f.includes("github-token"))) {
      throw new Error(
        `github token fixture did not fail: ${tokenFindings.join("; ")}`,
      );
    }
    rmSync(join(dir, "sub", "config.env"));

    // Negative: URL-embedded credential must be caught. Split for the same
    // self-detection reason as the private-key fixture above.
    writeFileSync(
      join(dir, "notes.md"),
      "connect to postgres://svc_deploy:Xk29fQzL8m" + "@db.internal:5432/app\n",
    );
    const urlFindings = scanForSecrets(dir);
    if (!urlFindings.some((f) => f.includes("url-embedded-credential"))) {
      throw new Error(
        `url-credential fixture did not fail: ${urlFindings.join("; ")}`,
      );
    }
    rmSync(join(dir, "notes.md"));

    // Positive: placeholder test-fixture credentials must not be flagged.
    writeFileSync(
      join(dir, "fixture.spec.ts"),
      'normalizeClientUpdateEndpoint("https://user:secret@example.com")\n',
    );
    const placeholderFindings = scanForSecrets(dir);
    if (
      placeholderFindings.some((f) => f.includes("url-embedded-credential"))
    ) {
      throw new Error(
        `placeholder credential fixture incorrectly flagged: ${placeholderFindings.join("; ")}`,
      );
    }
    rmSync(join(dir, "fixture.spec.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("scan-public-source-secrets self-test passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  if (args.selfTest) {
    assertSelfTest();
  } else if (args.dir) {
    const findings = scanForSecrets(args.dir);
    if (findings.length > 0) {
      console.error("scan-public-source-secrets findings:");
      for (const finding of findings) console.error(`  - ${finding}`);
      process.exit(1);
    }
    console.log("scan-public-source-secrets: no findings.");
  } else {
    console.error(
      "Usage: scan-public-source-secrets.mjs --dir <path> | --self-test",
    );
    process.exit(2);
  }
}
