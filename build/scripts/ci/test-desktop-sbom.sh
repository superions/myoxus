#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

snapshot_release_inputs() {
  {
    sha256sum \
      "$REPO_ROOT/package.json" \
      "$REPO_ROOT/yarn.lock" \
      "$REPO_ROOT/.yarnrc.yml"
    if [ -d "$REPO_ROOT/.yarn/plugins" ]; then
      find "$REPO_ROOT/.yarn/plugins" -type f -print0 |
        sort -z |
        xargs -0 -r sha256sum
    fi
  } | sed "s#$REPO_ROOT/##g"
}

snapshot_repository_sboms() {
  for root in "$REPO_ROOT/docs/sbom" "$REPO_ROOT/server/crates"; do
    if [ -d "$root" ]; then
      find "$root" -type f -name '*.cdx.json' -print0
    fi
  done |
    sort -z |
    xargs -0 -r sha256sum |
    sed "s#$REPO_ROOT/##g"
}

verify_content() {
  node - "$1" "$REPO_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [reportPath, repoRoot] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const electronManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "client/apps/electron/package.json"), "utf8"),
);
const coreManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "client/libs/core/package.json"), "utf8"),
);
const expected = new Map([
  ["electron", electronManifest.devDependencies.electron],
  ["mediabunny", coreManifest.dependencies.mediabunny],
]);

function fail(message) {
  throw new Error(message);
}

if (report.bomFormat !== "CycloneDX" || report.specVersion !== "1.5") {
  fail("desktop SBOM must be CycloneDX JSON 1.5");
}
if (report.metadata?.component?.purl !==
    `pkg:npm/%40myoxus/electron@${electronManifest.version}`) {
  fail("desktop SBOM root is not the Electron application");
}
if (!report.metadata?.properties?.some(
  ({ name, value }) =>
    name === "myoxus:sbom-scope" && value === "desktop-typescript",
)) {
  fail("desktop SBOM scope marker is missing");
}
if (!report.metadata?.properties?.some(
  ({ name, value }) => name === "cdx:reproducible" && value === "true",
)) {
  fail("desktop SBOM is not marked reproducible");
}
if (!Array.isArray(report.components) || report.components.length < 2) {
  fail("desktop SBOM has no real component inventory");
}

const serialized = JSON.stringify(report);
if (/DummyComponent|InterferedDependency/.test(serialized)) {
  fail("desktop SBOM contains a CycloneDX fallback/dummy component");
}

const componentByRef = new Map();
for (const component of report.components) {
  const ref = component["bom-ref"];
  if (typeof ref !== "string" || ref.length === 0) {
    fail("desktop SBOM component is missing bom-ref");
  }
  if (componentByRef.has(ref)) {
    fail(`desktop SBOM contains duplicate component ${ref}`);
  }
  componentByRef.set(ref, component);
}

for (const [name, version] of expected) {
  const purl = `pkg:npm/${name}@${version}`;
  if (![...componentByRef.values()].some(component => component.purl === purl)) {
    fail(`desktop SBOM does not inventory ${name}@${version}`);
  }
}
const mediabunny = [...componentByRef.values()].find(
  component => component.purl === `pkg:npm/mediabunny@${expected.get("mediabunny")}`,
);
if (!mediabunny.licenses?.some(entry => entry.license?.id === "MPL-2.0")) {
  fail("desktop SBOM does not preserve Mediabunny's MPL-2.0 license");
}

const rendererRef =
  "@myoxus/electron-renderer@workspace:client/apps/electron-renderer";
if (!componentByRef.has(rendererRef)) {
  fail("desktop SBOM does not inventory the Electron renderer workspace");
}

const dependencies = new Map(
  (report.dependencies ?? []).map(entry => [entry.ref, entry.dependsOn ?? []]),
);
const rootRef = report.metadata.component["bom-ref"];
if (!dependencies.get(rootRef)?.includes(rendererRef)) {
  fail("desktop SBOM root does not depend on the renderer workspace");
}
for (const [name, version] of expected) {
  const ref = `${name}@npm:${version}`;
  if (!dependencies.has(ref)) {
    fail(`desktop SBOM dependency graph omits ${ref}`);
  }
}

if (!report.metadata?.tools?.components?.some(
  component =>
    component.group === "@cyclonedx" &&
    component.name === "yarn-plugin-cyclonedx" &&
    component.version === "3.3.2",
)) {
  fail("desktop SBOM does not identify the pinned CycloneDX Yarn generator");
}
NODE
}

verify_frontend_content() {
  node - "$1" <<'NODE'
const fs = require("node:fs");

const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const fail = message => { throw new Error(message); };
if (report.bomFormat !== "CycloneDX" || report.specVersion !== "1.5") {
  fail("frontend SBOM must be CycloneDX JSON 1.5");
}
if (report.metadata?.component?.group !== "@myoxus" ||
    report.metadata?.component?.name !== "web") {
  fail("frontend SBOM root is not the Web application");
}
if (!report.metadata?.properties?.some(
  ({ name, value }) =>
    name === "myoxus:sbom-scope" && value === "frontend-typescript",
)) {
  fail("frontend SBOM scope marker is missing");
}

const components = report.components ?? [];
const admin = components.find(
  component => component.group === "@myoxus" && component.name === "admin",
);
if (!admin) {
  fail("frontend SBOM does not inventory the Admin application root");
}
const forbiddenRoots = new Set([
  "electron",
  "electron-renderer",
  "mobile",
  "mobile-native",
  "mobile-shared",
]);
if (components.some(
  component => component.group === "@myoxus" && forbiddenRoots.has(component.name),
)) {
  fail("frontend SBOM contains an Electron or Mobile root component");
}

const rootRef = report.metadata.component["bom-ref"];
const rootDependency = (report.dependencies ?? []).find(
  dependency => dependency.ref === rootRef,
);
if (!rootDependency?.dependsOn?.includes(admin["bom-ref"])) {
  fail("frontend SBOM Web root does not depend on the Admin workspace root");
}
NODE
}

snapshot_release_inputs >"$WORK_DIR/inputs.before"
snapshot_repository_sboms >"$WORK_DIR/repository-sboms.before"

if bash "$REPO_ROOT/build/scripts/release/generate-sbom.sh" \
  --output "$WORK_DIR/ambiguous.cdx.json" >/dev/null 2>&1; then
  echo "An explicit output without a selected generator unexpectedly passed." >&2
  exit 1
fi
if bash "$REPO_ROOT/build/scripts/release/generate-sbom.sh" \
  --typescript-only \
  --rust-only >/dev/null 2>&1; then
  echo "Mutually exclusive generators unexpectedly passed." >&2
  exit 1
fi

(
  cd "$WORK_DIR"
  bash "$REPO_ROOT/build/scripts/release/generate-sbom.sh" \
    --typescript-only \
    --output desktop-first.cdx.json
) &
desktop_first_pid=$!
bash "$REPO_ROOT/build/scripts/release/generate-sbom.sh" \
  --typescript-only \
  --output "$WORK_DIR/desktop-second.cdx.json" &
desktop_second_pid=$!
bash "$REPO_ROOT/build/scripts/release/generate-sbom.sh" \
  --frontend-only \
  --output "$WORK_DIR/frontend-first.cdx.json" &
frontend_first_pid=$!
bash "$REPO_ROOT/build/scripts/release/generate-sbom.sh" \
  --frontend-only \
  --output "$WORK_DIR/frontend-second.cdx.json" &
frontend_second_pid=$!

generation_failed=0
for pid in \
  "$desktop_first_pid" \
  "$desktop_second_pid" \
  "$frontend_first_pid" \
  "$frontend_second_pid"; do
  wait "$pid" || generation_failed=1
done
if [ "$generation_failed" -ne 0 ]; then
  echo "One or more isolated TypeScript SBOM generations failed." >&2
  exit 1
fi

cmp "$WORK_DIR/desktop-first.cdx.json" "$WORK_DIR/desktop-second.cdx.json"
bash "$REPO_ROOT/build/scripts/release/validate-sbom.sh" \
  "$WORK_DIR/desktop-first.cdx.json"
verify_content "$WORK_DIR/desktop-first.cdx.json"

cmp "$WORK_DIR/frontend-first.cdx.json" "$WORK_DIR/frontend-second.cdx.json"
bash "$REPO_ROOT/build/scripts/release/validate-sbom.sh" \
  "$WORK_DIR/frontend-first.cdx.json"
verify_frontend_content "$WORK_DIR/frontend-first.cdx.json"

snapshot_release_inputs >"$WORK_DIR/inputs.after"
snapshot_repository_sboms >"$WORK_DIR/repository-sboms.after"
cmp "$WORK_DIR/inputs.before" "$WORK_DIR/inputs.after"
cmp "$WORK_DIR/repository-sboms.before" "$WORK_DIR/repository-sboms.after"

cat >"$WORK_DIR/dummy.cdx.json" <<'JSON'
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "version": 1,
  "metadata": {
    "component": {
      "type": "application",
      "name": "electron",
      "group": "@myoxus",
      "version": "0.40.0",
      "bom-ref": "@myoxus/electron@workspace:client/apps/electron",
      "purl": "pkg:npm/%40myoxus/electron@0.40.0"
    },
    "properties": [
      { "name": "cdx:reproducible", "value": "true" },
      { "name": "myoxus:sbom-scope", "value": "desktop-typescript" }
    ]
  },
  "components": [
    {
      "type": "library",
      "name": "DummyComponent.RootComponent",
      "version": "0.0.0",
      "bom-ref": "DummyComponent.RootComponent",
      "description": "dummy component"
    }
  ],
  "dependencies": [
    {
      "ref": "@myoxus/electron@workspace:client/apps/electron",
      "dependsOn": ["DummyComponent.RootComponent"]
    },
    {
      "ref": "DummyComponent.RootComponent"
    }
  ]
}
JSON

if verify_content "$WORK_DIR/dummy.cdx.json" >/dev/null 2>&1; then
  echo "Dummy desktop SBOM unexpectedly passed content verification." >&2
  exit 1
fi

printf 'sbom\n' >"$WORK_DIR/literal.cdx.json"
if verify_content "$WORK_DIR/literal.cdx.json" >/dev/null 2>&1; then
  echo "Literal desktop SBOM unexpectedly passed content verification." >&2
  exit 1
fi

echo "Desktop and frontend SBOM schema, content, reproducibility, and non-mutation checks passed."
