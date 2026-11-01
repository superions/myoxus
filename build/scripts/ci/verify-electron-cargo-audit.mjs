// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";

function packageKey(entry) {
  return `${entry.package.name}@${entry.package.version}`;
}

export function classifyElectronAudit(report, reachablePackages) {
  const reachable = new Set(reachablePackages);
  const findings = [
    ...(report.vulnerabilities?.list ?? []).map((entry) => ({
      ...entry,
      category: "vulnerability",
    })),
    ...Object.entries(report.warnings ?? {}).flatMap(([category, entries]) =>
      entries.map((entry) => ({ ...entry, category })),
    ),
  ]
    .filter((entry) => reachable.has(packageKey(entry)))
    .map((entry) => ({
      advisory: entry.advisory?.id ?? null,
      category: entry.category,
      package: entry.package.name,
      version: entry.package.version,
    }));

  return {
    blocked: findings.filter((entry) =>
      ["vulnerability", "unsound"].includes(entry.category),
    ),
    reported: findings.filter(
      (entry) => !["vulnerability", "unsound"].includes(entry.category),
    ),
  };
}

function selfTest() {
  const report = {
    vulnerabilities: {
      list: [
        {
          advisory: { id: "RUSTSEC-TEST-BLOCK" },
          package: { name: "reachable", version: "1.0.0" },
        },
        {
          advisory: { id: "RUSTSEC-TEST-OUTSIDE" },
          package: { name: "outside", version: "2.0.0" },
        },
      ],
    },
    warnings: {
      unmaintained: [
        {
          advisory: { id: "RUSTSEC-TEST-REPORT" },
          package: { name: "reachable", version: "1.0.0" },
        },
      ],
      unsound: [],
      yanked: [],
    },
  };
  const result = classifyElectronAudit(report, ["reachable@1.0.0"]);
  if (
    result.blocked.length !== 1 ||
    result.blocked[0].advisory !== "RUSTSEC-TEST-BLOCK" ||
    result.reported.length !== 1
  ) {
    throw new Error("Electron Cargo audit reachability self-test failed");
  }
  process.stdout.write("Electron Cargo audit reachability self-test passed.\n");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const auditFile = argument("--audit-file");
  const reachableFile = argument("--reachable-file");
  const target = argument("--target");
  const output = argument("--output");
  if (!auditFile || !reachableFile || !target || !output) {
    throw new Error(
      "Usage: verify-electron-cargo-audit.mjs --audit-file FILE --reachable-file FILE --target TRIPLE --output FILE",
    );
  }
  const report = JSON.parse(fs.readFileSync(auditFile, "utf8"));
  const reachablePackages = fs
    .readFileSync(reachableFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const result = {
    target,
    ...classifyElectronAudit(report, reachablePackages),
  };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  if (result.blocked.length > 0) {
    process.stderr.write(
      `Electron Cargo audit blocked ${target}: ${JSON.stringify(result.blocked)}\n`,
    );
    process.exitCode = 1;
  }
}
