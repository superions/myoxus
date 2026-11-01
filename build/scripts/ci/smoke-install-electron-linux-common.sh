#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Shared runtime gate for an already installed Linux desktop package.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "$1 is required for the installed Electron package smoke" >&2
    exit 1
  }
}

resolve_desktop_identity() {
  local build_type="${BUILD_TYPE:-stable}"
  case "$build_type" in
    stable)
      MYOXUS_PRODUCT_NAME="Myoxus"
      MYOXUS_PACKAGE_NAME="myoxus"
      MYOXUS_APP_ID="org.myoxus.desktop"
      ;;
    beta|internal)
      MYOXUS_PRODUCT_NAME="Myoxus-$build_type"
      MYOXUS_PACKAGE_NAME="myoxus-$build_type"
      MYOXUS_APP_ID="org.myoxus.$build_type"
      ;;
    *)
      echo "BUILD_TYPE must be stable, beta, or internal; got $build_type" >&2
      return 1
      ;;
  esac
  readonly MYOXUS_PRODUCT_NAME MYOXUS_PACKAGE_NAME MYOXUS_APP_ID
}

assert_unprivileged_sandbox_contract() {
  if [ "$(id -u)" -eq 0 ]; then
    echo "Installed Electron package smokes must run as an unprivileged user" >&2
    exit 1
  fi
  if printf '%s\n' "$* ${ELECTRON_EXTRA_LAUNCH_ARGS:-} ${NODE_OPTIONS:-}" | grep -q -- '--no-sandbox'; then
    echo "--no-sandbox is forbidden in installed Electron package smokes" >&2
    exit 1
  fi
}

assert_production_package() {
  local asar_path="$1"
  test -s "$asar_path"
  ASAR_PATH="$asar_path" yarn node <<'NODE'
const asar = require("@electron/asar");
const provenance = asar.extractFile(
  process.env.ASAR_PATH,
  "BUILD-PROVENANCE.txt",
).toString("utf8");
if (!/^electronE2e=false$/m.test(provenance)) {
  throw new Error(
    "Install smoke must exercise the exact production package",
  );
}
NODE
}

write_audio_fixture() {
  local output="$1"
  AUDIO_FIXTURE="$output" node <<'NODE'
const fs = require("node:fs");
const sampleRate = 48_000;
const channels = 2;
const frames = sampleRate;
const samples = Buffer.alloc(frames * channels * 2);
for (let frame = 0; frame < frames; frame += 1) {
  const value = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 12_000);
  for (let channel = 0; channel < channels; channel += 1) {
    samples.writeInt16LE(value, (frame * channels + channel) * 2);
  }
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + samples.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * channels * 2, 28);
header.writeUInt16LE(channels * 2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(samples.length, 40);
fs.writeFileSync(process.env.AUDIO_FIXTURE, Buffer.concat([header, samples]));
NODE
}

write_workspace_fixture() {
  local output="$1"
  REPO_ROOT="$REPO_ROOT" WORKSPACE_FIXTURE="$output" yarn node <<'NODE'
const path = require("node:path");
const { DocStorage, DocStoragePool } = require(
  path.join(process.env.REPO_ROOT, "client/libs/local-store/native-binding.cjs"),
);
(async () => {
  const workspaceId = "linux-package-import-source";
  const universalId = `@peer(local);@type(workspace);@id(${workspaceId});`;
  const pool = new DocStoragePool();
  await pool.connect(universalId, process.env.WORKSPACE_FIXTURE);
  await pool.setSpaceId(universalId, workspaceId);
  await pool.checkpoint(universalId);
  await pool.disconnect(universalId);
  const storage = new DocStorage(process.env.WORKSPACE_FIXTURE);
  if (!(await storage.validate())) {
    throw new Error("Synthetic package workspace fixture is invalid");
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
NODE
}

run_installed_package_smoke() {
  if [ "$#" -ne 8 ]; then
    echo "run_installed_package_smoke <kind> <command> <launch-args-json> <profile> <import-path> <host-import-path> <export-path> <evidence-dir>" >&2
    return 2
  fi
  local kind="$1"
  local launch_command="$2"
  local launch_arguments="$3"
  local profile="$4"
  local import_path="$5"
  local host_import_path="$6"
  local export_path="$7"
  local evidence_dir="$8"
  local runtime_root
  runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/myoxus-${kind}-runtime.XXXXXX")"
  local audio_fixture="$runtime_root/system-audio.wav"
  local audio_loop_pid=""

  cleanup_runtime() {
    if [ -n "$audio_loop_pid" ] && kill -0 "$audio_loop_pid" 2>/dev/null; then
      kill -TERM -- "-$audio_loop_pid" 2>/dev/null || kill -TERM "$audio_loop_pid" 2>/dev/null || true
      wait "$audio_loop_pid" 2>/dev/null || true
    fi
    find "$runtime_root" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$runtime_root" 2>/dev/null || true
  }
  trap cleanup_runtime RETURN

  require_command node
  require_command paplay
  require_command timeout
  require_command xdotool
  if [[ "$launch_command" == */* ]]; then
    test -x "$launch_command"
  else
    require_command "$launch_command"
  fi
  mkdir -p "$profile" "$(dirname "$host_import_path")" "$(dirname "$export_path")" "$evidence_dir"
  if [ ! -s "$host_import_path" ]; then
    write_workspace_fixture "$host_import_path"
  fi
  write_audio_fixture "$audio_fixture"

  setsid bash -c 'while paplay "$1"; do :; done' bash "$audio_fixture" \
    >"$evidence_dir/${kind}-audio-source.log" 2>&1 &
  audio_loop_pid=$!

  (
    cd "$REPO_ROOT"
    MYOXUS_LINUX_PACKAGE_KIND="$kind" \
      MYOXUS_LINUX_PACKAGE_EVIDENCE="$evidence_dir" \
      MYOXUS_ELECTRON_PROFILE="$profile" \
      MYOXUS_ELECTRON_IMPORT_PATH="$import_path" \
      MYOXUS_ELECTRON_IMPORT_HOST_PATH="$host_import_path" \
      MYOXUS_ELECTRON_EXPORT_HOST_PATH="$export_path" \
      MYOXUS_ELECTRON_LAUNCH_COMMAND="$launch_command" \
      MYOXUS_ELECTRON_LAUNCH_ARGUMENTS="$launch_arguments" \
      timeout --signal=TERM --kill-after=30s 900s \
      yarn playwright test \
        --config tests/client/desktop/electron/playwright.config.ts \
        tests/client/desktop/electron/e2e/linux-packages.spec.ts \
        --reporter=list
  )

  case "${MYOXUS_RUN_RELEASE_RUNTIME:-0}" in
    0) ;;
    1)
      (
        cd "$REPO_ROOT"
        test -f "${MYOXUS_PRODUCT_FLOW_ENV_FILE:-}"
        test "$(stat -c '%a' "$MYOXUS_PRODUCT_FLOW_ENV_FILE")" = 600
        mapfile -d '' -t product_flow_env <"$MYOXUS_PRODUCT_FLOW_ENV_FILE"
        test "${#product_flow_env[@]}" = 5
        E2E_USER_EMAIL="${product_flow_env[2]}" \
          E2E_USER_PASSWORD="${product_flow_env[3]}" \
          MYOXUS_API_URL="${product_flow_env[0]}" \
          MYOXUS_DESKTOP_TEST_ENVIRONMENT_ID="${product_flow_env[4]}" \
          MYOXUS_FRONTEND_URL="${product_flow_env[1]}" \
          MYOXUS_ELECTRON_LAUNCH_COMMAND="$launch_command" \
          MYOXUS_ELECTRON_LAUNCH_ARGUMENTS="$launch_arguments" \
          MYOXUS_ELECTRON_RELEASE_EVIDENCE="$evidence_dir/release-smoke" \
          build/scripts/test/run.sh \
            --suite desktop.electron.runtime \
            --include-manual \
            --strict
      )
      ;;
    *)
      echo "MYOXUS_RUN_RELEASE_RUNTIME must be 0 or 1" >&2
      return 1
      ;;
  esac
}
