// SPDX-License-Identifier: AGPL-3.0-or-later

import { deepStrictEqual, throws } from "node:assert";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateVirgultumProvenance } from "./generate-virgultum-source-provenance.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const MANIFEST = "virgultum/provenance/licenses.json";

function readSnapshot(repoRoot = REPO_ROOT) {
  return JSON.parse(readFileSync(join(repoRoot, MANIFEST), "utf8"));
}

export function verifyVirgultumProvenance(
  repoRoot = REPO_ROOT,
  { publicExport = false } = {},
) {
  const expected = readSnapshot(repoRoot);
  const actual = generateVirgultumProvenance(repoRoot);
  if (publicExport) {
    expected.generatedFrom.trackedPathCount =
      expected.generatedFrom.publicExport.trackedPathCount;
    expected.generatedFrom.trackedPathSha256 =
      expected.generatedFrom.publicExport.trackedPathSha256;
  }
  deepStrictEqual(
    actual,
    expected,
    `${MANIFEST} is stale; review origin/license changes and regenerate explicitly`,
  );
  if (
    actual.packages.some(
      (entry) =>
        entry.origin.includes("U0") || entry.copyrightNotices.length === 0,
    )
  ) {
    throw new Error("Virgultum contains unresolved provenance evidence");
  }
  return actual;
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "myoxus-editor-provenance-"));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    write("virgultum/scripts/vitest-global.js", "// fixture\n");
    write("virgultum/tsconfig.json", "{}\n");
    write(
      "virgultum/example/package.json",
      JSON.stringify({ name: "@virgultum/example", license: "MIT" }),
    );
    const sourcePath = "virgultum/example/source.ts";
    write(sourcePath, "export {};\n");
    write(
      "virgultum/provenance/LICENSE-MPL-2.0.txt",
      readFileSync(join(REPO_ROOT, "virgultum/provenance/LICENSE-MPL-2.0.txt")),
    );
    const sourcePaths = [
      "virgultum/scripts/vitest-global.js",
      "virgultum/tsconfig.json",
      "virgultum/example/package.json",
      sourcePath,
    ];
    const writeInventory = () =>
      write(
        "virgultum/provenance/sources.json",
        JSON.stringify({
          policy: {
            newMyoxusLicense: "AGPL-3.0-or-later",
            retainedMitFileLicense: "MIT",
          },
          annotations: [
            {
              origin: "M0",
              licenseExpression: "AGPL-3.0-or-later",
              copyrightNotices: [
                "2026-present Daniel Scharf and Myoxus contributors",
              ],
              files: sourcePaths.map((path) => ({
                path,
                sha256: createHash("sha256")
                  .update(readFileSync(join(root, path)))
                  .digest("hex"),
              })),
            },
          ],
        }),
      );
    writeInventory();
    const actual = generateVirgultumProvenance(root);
    deepStrictEqual(actual.packages[0].declaredPackageLicense, "MIT");
    deepStrictEqual(actual.packages[0].licenseExpression, "AGPL-3.0-or-later");
    write(MANIFEST, JSON.stringify(actual));
    verifyVirgultumProvenance(root);
    const tampered = structuredClone(actual);
    tampered.packages[0].licenseExpression = "MIT";
    write(MANIFEST, JSON.stringify(tampered));
    throws(() => verifyVirgultumProvenance(root), /is stale/);
    write(MANIFEST, JSON.stringify(actual));
    write(
      "virgultum/example/package.json",
      JSON.stringify({ name: "@virgultum/example", license: "Apache-2.0" }),
    );
    writeInventory();
    const updated = generateVirgultumProvenance(root);
    deepStrictEqual(
      updated.packages[0].licenseExpression,
      actual.packages[0].licenseExpression,
    );
    write(MANIFEST, JSON.stringify(updated));
    verifyVirgultumProvenance(root);
    write(sourcePath, "// SPDX-License-Identifier: MIT\nexport {};\n");
    throws(() => verifyVirgultumProvenance(root), /source changed/);
    writeInventory();
    throws(() => generateVirgultumProvenance(root), /SPDX header contradicts/);
    const retained = JSON.parse(
      readFileSync(join(root, "virgultum/provenance/sources.json")),
    );
    const own = retained.annotations[0];
    const retainedFiles = own.files.filter((entry) =>
      entry.path.startsWith("virgultum/example/"),
    );
    own.files = own.files.filter((entry) => !retainedFiles.includes(entry));
    retained.annotations.push({
      origin: "F1",
      licenseExpression: "MIT",
      copyrightNotices: [
        "2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.",
        "2026-present Daniel Scharf and Myoxus contributors",
      ],
      files: retainedFiles.map((entry) => ({
        ...entry,
        originalPath: entry.path.replace("virgultum/", "blocksuite/"),
        originalGitBlob: "a".repeat(40),
      })),
    });
    write("virgultum/provenance/sources.json", JSON.stringify(retained));
    deepStrictEqual(
      generateVirgultumProvenance(root).packages[0].licenseExpression,
      "MIT",
    );
    retained.annotations[1].licenseExpression = "MIT AND AGPL-3.0-or-later";
    write("virgultum/provenance/sources.json", JSON.stringify(retained));
    throws(
      () => generateVirgultumProvenance(root),
      /retained source must use MIT for the whole file/,
    );
    write("virgultum/example/LICENSE", "Unknown license fixture\n");
    throws(
      () => generateVirgultumProvenance(root),
      /unclassified embedded license/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("verify-virgultum-source-provenance self-test passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    const evidence = verifyVirgultumProvenance();
    console.log(
      `Virgultum source provenance valid: ${evidence.packages.length} packages, ${evidence.embeddedComponents.length} embedded components, ${evidence.generatedFrom.trackedPathCount} tracked paths.`,
    );
  }
}
