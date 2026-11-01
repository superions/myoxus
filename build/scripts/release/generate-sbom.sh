#!/usr/bin/env bash
# build/scripts/release/generate-sbom.sh
#
# Generates CycloneDX SBOMs for TypeScript product graphs and the Rust server.
#
# Usage:
#   build/scripts/release/generate-sbom.sh
#     [--typescript-only | --frontend-only | --rust-only]
#     [--output PATH --git-revision SHA --component-version VERSION
#      --source-date-epoch EPOCH]
#
# Output:
#   docs/sbom/desktop-typescript-YYYY-MM-DD.cdx.json
#   docs/sbom/rust-YYYY-MM-DD.cdx.json
#
# Requirements:
#   - Node/Yarn (for TypeScript SBOM)
#   - Rust/Cargo (for Rust SBOM)
#
# P-DEPS-ROOT-D-01-I

set -euo pipefail

CALLER_CWD="$PWD"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SBOM_DIR="$REPO_ROOT/docs/sbom"
DATE="$(date +%Y-%m-%d)"
TS_ONLY=false
FRONTEND_ONLY=false
RUST_ONLY=false
CARGO_CYCLONEDX_VERSION="0.5.9"
CYCLONEDX_YARN_VERSION="3.3.2"
OUTPUT=""
GIT_REVISION=""
COMPONENT_VERSION=""
SOURCE_EPOCH="${SOURCE_DATE_EPOCH:-}"
SOURCE_PROVENANCE="${MYOXUS_SOURCE_PROVENANCE:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --typescript-only) TS_ONLY=true ;;
    --frontend-only) FRONTEND_ONLY=true ;;
    --rust-only) RUST_ONLY=true ;;
    --output) OUTPUT="${2:?--output requires a path}"; shift ;;
    --git-revision) GIT_REVISION="${2:?--git-revision requires a value}"; shift ;;
    --component-version) COMPONENT_VERSION="${2:?--component-version requires a value}"; shift ;;
    --source-provenance) SOURCE_PROVENANCE="${2:?--source-provenance requires a path}"; shift ;;
    --source-date-epoch) SOURCE_EPOCH="${2:?--source-date-epoch requires a value}"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

selected_generators=0
if $TS_ONLY; then selected_generators=$((selected_generators + 1)); fi
if $FRONTEND_ONLY; then selected_generators=$((selected_generators + 1)); fi
if $RUST_ONLY; then selected_generators=$((selected_generators + 1)); fi
if [ "$selected_generators" -gt 1 ]; then
  echo "--typescript-only, --frontend-only and --rust-only are mutually exclusive" >&2
  exit 2
fi
if [ -n "$OUTPUT" ] && [ "$selected_generators" -ne 1 ]; then
  echo "--output requires exactly one SBOM generator" >&2
  exit 2
fi
if [ -n "$OUTPUT" ] && [[ "$OUTPUT" != /* ]]; then
  OUTPUT="$CALLER_CWD/$OUTPUT"
fi

# TypeScript product SBOM

if ! $RUST_ONLY; then
  if $FRONTEND_ONLY; then
    TS_LABEL="frontend"
    TS_SCOPE="frontend-typescript"
    TS_PRIMARY_WORKSPACE="client/web/workspaces/web"
    TS_SECONDARY_WORKSPACE="client/admin/workspaces/admin"
    TS_DEFAULT_OUTPUT="$REPO_ROOT/build/dist/frontend.cdx.json"
  else
    TS_LABEL="desktop"
    TS_SCOPE="desktop-typescript"
    TS_PRIMARY_WORKSPACE="client/apps/electron"
    TS_SECONDARY_WORKSPACE="client/apps/electron-renderer"
    TS_DEFAULT_OUTPUT="$SBOM_DIR/desktop-typescript-$DATE.cdx.json"
  fi

  echo "==> Generating $TS_LABEL TypeScript SBOM via @cyclonedx/yarn-plugin-cyclonedx ..."
  cd "$REPO_ROOT"

  installed_cyclonedx_yarn_version="$(
    yarn exec cyclonedx-yarn --version 2>/dev/null |
      awk '/@cyclonedx\/yarn-plugin-cyclonedx v/ { sub(/^v/, "", $NF); print $NF }'
  )"
  if [ "$installed_cyclonedx_yarn_version" != "$CYCLONEDX_YARN_VERSION" ]; then
    echo "@cyclonedx/yarn-plugin-cyclonedx $CYCLONEDX_YARN_VERSION is required, found ${installed_cyclonedx_yarn_version:-none}" >&2
    echo "Run yarn install from the locked workspace before generating the SBOM." >&2
    exit 1
  fi

  TS_SBOM="${OUTPUT:-$TS_DEFAULT_OUTPUT}"
  mkdir -p "$(dirname "$TS_SBOM")"
  TS_WORK_DIR="$(mktemp -d "$(dirname "$TS_SBOM")/.$TS_LABEL-sbom.XXXXXX")"
  cleanup_ts_work_dir() {
    rm -rf "$TS_WORK_DIR"
  }
  trap cleanup_ts_work_dir EXIT

  for workspace in "$TS_PRIMARY_WORKSPACE" "$TS_SECONDARY_WORKSPACE"; do
    workspace_name="$(basename "$workspace")"
    env -u NODE_ENV yarn --cwd "$workspace" run -T cyclonedx-yarn \
      --output-reproducible \
      --output-format JSON \
      --output-file "$TS_WORK_DIR/$workspace_name.cdx.json" \
      --mc-type application \
      --spec-version 1.5
  done

  primary_name="$(basename "$TS_PRIMARY_WORKSPACE")"
  secondary_name="$(basename "$TS_SECONDARY_WORKSPACE")"
  node - \
    "$TS_WORK_DIR/$primary_name.cdx.json" \
    "$TS_WORK_DIR/$secondary_name.cdx.json" \
    "$TS_WORK_DIR/combined.cdx.json" \
    "$TS_SCOPE" <<'NODE'
const fs = require("node:fs");

const [primaryPath, secondaryPath, outputPath, scope] = process.argv.slice(2);
const primary = JSON.parse(fs.readFileSync(primaryPath, "utf8"));
const secondary = JSON.parse(fs.readFileSync(secondaryPath, "utf8"));

for (const report of [primary, secondary]) {
  if (report.bomFormat !== "CycloneDX" || report.specVersion !== "1.5") {
    throw new Error("workspace SBOM is not CycloneDX JSON 1.5");
  }
}
if (JSON.stringify(primary.metadata.tools) !== JSON.stringify(secondary.metadata.tools)) {
  throw new Error("workspace SBOM tool metadata differs");
}

const components = new Map();
for (const component of [
  ...primary.components,
  secondary.metadata.component,
  ...secondary.components,
]) {
  const ref = component["bom-ref"];
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("component is missing bom-ref");
  }
  const previous = components.get(ref);
  if (previous && JSON.stringify(previous) !== JSON.stringify(component)) {
    throw new Error(`conflicting component ${ref}`);
  }
  components.set(ref, component);
}

const dependencies = new Map();
for (const dependency of [...primary.dependencies, ...secondary.dependencies]) {
  const previous = dependencies.get(dependency.ref);
  if (previous && JSON.stringify(previous) !== JSON.stringify(dependency)) {
    throw new Error(`conflicting dependency ${dependency.ref}`);
  }
  dependencies.set(dependency.ref, dependency);
}

const primaryRef = primary.metadata.component["bom-ref"];
const secondaryRef = secondary.metadata.component["bom-ref"];
const primaryDependency = dependencies.get(primaryRef);
if (!primaryDependency) {
  throw new Error("primary application component has no dependency entry");
}
primaryDependency.dependsOn = [...new Set([
  ...(primaryDependency.dependsOn ?? []),
  secondaryRef,
])].sort();

// CycloneDX 1.5 embeds SPDX 3.21, which predates this valid package license.
for (const component of components.values()) {
  for (const entry of component.licenses ?? []) {
    if (entry.license?.id === "FSL-1.1-MIT") {
      entry.license = { name: entry.license.id };
    }
  }
}

const report = {
  $schema: primary.$schema,
  bomFormat: primary.bomFormat,
  specVersion: primary.specVersion,
  version: primary.version,
  metadata: {
    ...primary.metadata,
    properties: [
      ...(primary.metadata.properties ?? []),
      {
        name: "myoxus:sbom-scope",
        value: scope,
      },
    ].sort((left, right) =>
      left.name.localeCompare(right.name) || left.value.localeCompare(right.value)
    ),
  },
  components: [...components.values()].sort((left, right) =>
    left["bom-ref"].localeCompare(right["bom-ref"])
  ),
  dependencies: [...dependencies.values()].sort((left, right) =>
    left.ref.localeCompare(right.ref)
  ),
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
NODE

  GIT_REVISION="${GIT_REVISION:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
  node "$REPO_ROOT/build/scripts/release/source-correspondence.mjs" \
    --sbom "$TS_WORK_DIR/combined.cdx.json" --revision "$GIT_REVISION" \
    --source-provenance "$SOURCE_PROVENANCE"
  mv "$TS_WORK_DIR/combined.cdx.json" "$TS_SBOM"
  cleanup_ts_work_dir
  trap - EXIT

  echo "==> $TS_LABEL TypeScript SBOM written: $TS_SBOM"
  echo "    Components: $(jq '.components | length' "$TS_SBOM" 2>/dev/null || echo '?')"
fi

# Rust server SBOM

if ! $TS_ONLY && ! $FRONTEND_ONLY; then
  echo "==> Generating Rust SBOM via cargo-cyclonedx ..."

  if ! command -v cargo-cyclonedx >/dev/null 2>&1; then
    echo "cargo-cyclonedx $CARGO_CYCLONEDX_VERSION is required; release jobs do not install tools." >&2
    exit 1
  fi
  installed_version="$(cargo cyclonedx --version | awk '{print $NF}')"
  [ "$installed_version" = "$CARGO_CYCLONEDX_VERSION" ] || {
    echo "cargo-cyclonedx $CARGO_CYCLONEDX_VERSION is required, found $installed_version" >&2
    exit 1
  }

  RUST_SBOM="${OUTPUT:-$SBOM_DIR/rust-$DATE.cdx.json}"
  GIT_REVISION="${GIT_REVISION:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
  COMPONENT_VERSION="${COMPONENT_VERSION:-$(cargo metadata --manifest-path "$REPO_ROOT/server/Cargo.toml" --format-version=1 --no-deps | python3 -c 'import json,sys; print(next(p["version"] for p in json.load(sys.stdin)["packages"] if p["name"] == "myoxus-api"))')}"
  SOURCE_EPOCH="${SOURCE_EPOCH:-$(git -C "$REPO_ROOT" show -s --format=%ct "$GIT_REVISION")}"
  mkdir -p "$(dirname "$RUST_SBOM")"

  generated_api="$REPO_ROOT/server/crates/api/myoxus-server-api.cdx.json"
  generated_cli="$REPO_ROOT/server/crates/cli/myoxus-server-cli.cdx.json"
  cleanup_generated_rust_sboms() {
    find "$REPO_ROOT/server/crates" -type f \
      \( -name 'myoxus-server-api.cdx.json' -o -name 'myoxus-server-cli.cdx.json' \) \
      -delete
  }
  trap cleanup_generated_rust_sboms EXIT
  SOURCE_DATE_EPOCH="$SOURCE_EPOCH" cargo cyclonedx \
    --manifest-path "$REPO_ROOT/server/crates/api/Cargo.toml" \
    --format json --spec-version 1.5 --all --override-filename myoxus-server-api.cdx --quiet
  SOURCE_DATE_EPOCH="$SOURCE_EPOCH" cargo cyclonedx \
    --manifest-path "$REPO_ROOT/server/crates/cli/Cargo.toml" \
    --format json --spec-version 1.5 --all --override-filename myoxus-server-cli.cdx --quiet
  node "$REPO_ROOT/build/scripts/release/normalize-server-sbom.mjs" \
    --api "$generated_api" --cli "$generated_cli" --output "$RUST_SBOM" \
    --revision "$GIT_REVISION" --version "$COMPONENT_VERSION" --epoch "$SOURCE_EPOCH" \
    --source-provenance "$SOURCE_PROVENANCE"
  echo "==> Rust SBOM written: $RUST_SBOM"
  echo "    Components: $(jq '.components | length' "$RUST_SBOM" 2>/dev/null || echo '?')"
fi

echo ""
if [ -n "$OUTPUT" ]; then
  echo "==> Done: $OUTPUT"
else
  echo "==> Done. SBOMs in $SBOM_DIR:"
  ls -1 "$SBOM_DIR"/*.cdx.json 2>/dev/null || echo "  (none)"
fi
