#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "../../..");
const defaultLockfile = "client/apps/android/App/app/gradle.lockfile";
// The security gate follows shipped app closures and excludes Gradle's own
// internal test-platform tooling from the release-runtime decision.
const releaseConfiguration =
  /^(?:beta|internal|stable)ReleaseRuntimeClasspath$/;

function parseReleaseCoordinates(source) {
  const coordinates = new Set();
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("empty=")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const coordinate = line.slice(0, separator);
    const configurations = line.slice(separator + 1).split(",");
    if (
      coordinate.split(":").length === 3 &&
      configurations.some((configuration) =>
        releaseConfiguration.test(configuration),
      )
    ) {
      coordinates.add(coordinate);
    }
  }
  return [...coordinates].sort();
}

function queryFor(coordinate) {
  const [group, artifact, version] = coordinate.split(":");
  return {
    package: { ecosystem: "Maven", name: `${group}:${artifact}` },
    version,
  };
}

async function selfTest() {
  const fixture = [
    "com.example:runtime:1.0.0=stableReleaseRuntimeClasspath,stableDebugRuntimeClasspath",
    "com.example:test-tool:2.0.0=_internal-unified-test-platform-core",
    "com.example:debug-only:3.0.0=stableDebugRuntimeClasspath",
    "empty=unused",
  ].join("\n");
  const actual = parseReleaseCoordinates(fixture);
  if (JSON.stringify(actual) !== '["com.example:runtime:1.0.0"]') {
    throw new Error(
      `release lock selection drifted: ${JSON.stringify(actual)}`,
    );
  }
  const query = queryFor(actual[0]);
  if (
    query.package.ecosystem !== "Maven" ||
    query.package.name !== "com.example:runtime" ||
    query.version !== "1.0.0"
  ) {
    throw new Error(`Maven query mapping drifted: ${JSON.stringify(query)}`);
  }
  console.log("Gradle OSV audit self-test passed.");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }

  const lockfileArgument = process.argv[2] ?? defaultLockfile;
  const lockfile = resolve(repoRoot, lockfileArgument);
  const output = resolve(
    repoRoot,
    process.env.GRADLE_OSV_OUTPUT ??
      "dist/ci/dependency-health/android-gradle-osv.json",
  );
  const coordinates = parseReleaseCoordinates(await readFile(lockfile, "utf8"));
  if (!coordinates.length) {
    throw new Error(
      `No Android release dependencies found in ${lockfileArgument}`,
    );
  }

  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: coordinates.map(queryFor) }),
  });
  if (!response.ok) {
    throw new Error(`OSV query failed with HTTP ${response.status}`);
  }
  const result = await response.json();
  if (
    !Array.isArray(result.results) ||
    result.results.length !== coordinates.length
  ) {
    throw new Error("OSV query returned an incomplete result set");
  }

  const findings = [];
  result.results.forEach((entry, index) => {
    for (const vulnerability of entry.vulns ?? []) {
      findings.push({
        coordinate: coordinates[index],
        id: vulnerability.id,
        modified: vulnerability.modified,
      });
    }
  });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    lockfile: relative(repoRoot, lockfile),
    releaseConfigurations: releaseConfiguration.source,
    packageCount: coordinates.length,
    findingCount: findings.length,
    findings,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);

  if (findings.length) {
    for (const finding of findings) {
      console.error(`${finding.id}: ${finding.coordinate}`);
    }
    throw new Error(
      `${findings.length} OSV finding(s) remain in the Android release runtime`,
    );
  }
  console.log(
    `Android Gradle OSV audit passed (${coordinates.length} locked release packages).`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
