// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("early dependency scan propagates High/Critical and scanner failures", () => {
  const root = mkdtempSync(join(tmpdir(), "myoxus-security-gate-"));
  try {
    const lockfile = join(root, "Cargo.lock");
    writeFileSync(
      lockfile,
      'version = 4\n[[package]]\nname = "async-graphql"\nversion = "6.0.11"\n',
    );
    writeFileSync(
      join(root, "docker"),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_LOG"
case "$1" in
  rm) ;;
  image) touch "$4" ;;
  run)
    for arg in "$@"; do
      case "$arg" in *:/scan) output="$(printf '%s' "$arg" | sed 's|:/scan$||')" ;; esac
    done
    printf '%s' "$FIXTURE_REPORT" > "$output/server-vulnerabilities.json"
    exit "$FIXTURE_EXIT"
    ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const script = fileURLToPath(
      new URL("./scan-server-dependencies.sh", import.meta.url),
    );
    const clean = JSON.stringify({
      descriptor: { name: "grype" },
      matches: [],
    });
    for (const [label, exit, report, expected] of [
      ["clean", 0, clean, 0],
      [
        "high",
        2,
        JSON.stringify({
          descriptor: { name: "grype" },
          matches: [
            {
              artifact: { name: "async-graphql", version: "6.0.11" },
              vulnerability: {
                id: "GHSA-5gc2-7c65-8fq8",
                severity: "High",
                fix: { versions: ["7.0.10"] },
              },
            },
          ],
        }),
        2,
      ],
      [
        "critical",
        2,
        JSON.stringify({
          descriptor: { name: "grype" },
          matches: [
            {
              artifact: { name: "fixture", version: "1.0.0" },
              vulnerability: {
                id: "fixture-critical",
                severity: "Critical",
                fix: { versions: [] },
              },
            },
          ],
        }),
        2,
      ],
      ["unavailable-database", 1, "", 1],
      ["malformed-report", 0, "{}", 1],
    ]) {
      const result = spawnSync("bash", [script, lockfile, join(root, label)], {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          SERVER_SECURITY_REF: "",
          CI_RUNNER_CACHE: join(root, "cache"),
          FIXTURE_LOG: join(root, "docker.log"),
          FIXTURE_REPORT: report,
          FIXTURE_EXIT: String(exit),
        },
      });
      assert.equal(
        result.status,
        expected,
        `${label}: ${result.stdout}\n${result.stderr}`,
      );
      if (label === "high") assert.match(result.stdout, /GHSA-5gc2-7c65-8fq8/);
    }
    const calls = readFileSync(join(root, "docker.log"), "utf8");
    assert.match(calls, /--fail-on high/);
    assert.match(calls, /Cargo\.lock:\/source\/Cargo\.lock:ro/);
    assert.match(calls, /dir:\/source/);
    assert.match(calls, /GRYPE_DB_REQUIRE_UPDATE_CHECK=true/);
    assert.match(calls, /GRYPE_DB_MAX_ALLOWED_BUILT_AGE=72h/);
    assert.doesNotMatch(
      calls,
      /docker\.sock|--only-fixed|--ignore|buildx|^pull |^create /m,
    );
    for (const [label, distro, state, expected] of [
      ["fixed-os", { name: "debian" }, "fixed", 1],
      ["unfixed-os", { name: "debian" }, "not-fixed", 0],
      ["missing-os-coverage", {}, "not-fixed", 1],
    ]) {
      const result = spawnSync(
        "bash",
        [script, "runtime:fixture", join(root, label), "--image"],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            CI_RUNNER_CACHE: join(root, "cache"),
            FIXTURE_LOG: join(root, "image.log"),
            FIXTURE_EXIT: "0",
            FIXTURE_REPORT: JSON.stringify({
              descriptor: { name: "grype" },
              distro,
              matches: [
                {
                  artifact: { name: "gzip", version: "1.13-1", type: "deb" },
                  vulnerability: {
                    id: "CVE-2026-41992",
                    severity: "High",
                    fix: {
                      state,
                      versions: state === "fixed" ? ["1.13-1+deb13u1"] : [],
                    },
                  },
                },
              ],
            }),
          },
        },
      );
      assert.equal(
        result.status,
        expected,
        `${label}: ${result.stdout}\n${result.stderr}`,
      );
      assert.match(result.stdout, /CVE-2026-41992/, result.stderr);
    }
    assert.match(
      readFileSync(join(root, "image.log"), "utf8"),
      /docker-archive:\/source\/image.tar/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
