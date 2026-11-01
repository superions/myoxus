#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Negative controls for the exact CRDT version gate. The behavior test is
# intentionally skipped here because each fixture only mutates expected
# versions; the normal yjs.compat suite owns the server behavior run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPAT_SCRIPT="$REPO_ROOT/build/scripts/ci/yjs-compat-local.sh"
OUTPUT="$(mktemp -t myoxus-yjs-compat.XXXXXX)"
trap 'rm -f "$OUTPUT"' EXIT

expect_failure() {
  local label="$1"
  shift
  if env YJS_COMPAT_VERSION_ONLY=1 "$@" bash "$COMPAT_SCRIPT" >"$OUTPUT" 2>&1; then
    echo "[FAIL] $label was accepted" >&2
    cat "$OUTPUT" >&2
    exit 1
  fi
  echo "[PASS] $label was rejected"
}

expect_failure "wrong Yjs version" YJS_TARGET=99.0.0
expect_failure "superseded Yjs version" YJS_TARGET=13.6.31
expect_failure "wrong y-protocols version" Y_PROTOCOLS_TARGET=99.0.0
expect_failure "wrong yrs version" YRS_TARGET=99.0.0

YJS_COMPAT_VERSION_ONLY=1 bash "$COMPAT_SCRIPT" >"$OUTPUT"
echo "[PASS] current CRDT version set was accepted"

# The positive path above uses real Cargo resolution. Isolated negative controls
# then distinguish manifests, locks, resolved identity and modified cache bytes.
node - "$REPO_ROOT" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = process.argv[2];
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'myoxus-yrs-source-'));
const guard = path.join(root, 'build/scripts/ci/verify-yrs-source.mjs');
const sourceFile = 'build/dependencies/yrs-source.json';
const source = JSON.parse(fs.readFileSync(path.join(root, sourceFile)));
const originals = new Map(['Cargo.toml', 'server/Cargo.toml', 'Cargo.lock', 'server/Cargo.lock', sourceFile].map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', path.join(root, 'server/Cargo.toml')], {encoding:'utf8', maxBuffer:64*1024*1024, timeout:180000}));
const realPackage = metadata.packages.find(pkg => pkg.name === source.package);
if (!realPackage) throw new Error('Real external myoxus-yrs source is missing');
function reset() {
  fs.rmSync(fixture, {recursive:true, force:true});
  for (const [file, text] of originals) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), {recursive:true});
    fs.writeFileSync(path.join(fixture, file), text);
  }
  for (const file of Object.keys(source.files)) {
    const destination = path.join(fixture, 'resolved', file);
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.copyFileSync(path.join(path.dirname(realPackage.manifest_path), file), destination);
  }
  const resolved = {packages:[{...realPackage, manifest_path:path.join(fixture, 'resolved/Cargo.toml')}]};
  for (const owner of ['native', 'server']) fs.writeFileSync(path.join(fixture, `${owner}-metadata.json`), JSON.stringify(resolved));
  fs.mkdirSync(path.join(fixture, 'bin'));
  fs.writeFileSync(path.join(fixture, 'bin/cargo'), `#!/usr/bin/env node\nconst fs=require('node:fs');const path=require('node:path');const owner=process.argv.some(arg=>arg.endsWith('/server/Cargo.toml'))?'server':'native';process.stdout.write(fs.readFileSync(path.join(__dirname,'../'+owner+'-metadata.json')));\n`, {mode:0o755});
}
function run() {
  return spawnSync(process.execPath, [guard, fixture], {encoding:'utf8', timeout:30000, env:{...process.env, PATH:`${fixture}/bin:${process.env.PATH}`}});
}
function reject(label, expected, mutate) {
  reset();
  mutate();
  const result = run();
  if (result.status === 0 || !result.stderr?.includes(expected)) throw new Error(`${label}: wrong result ${result.status}: ${result.stderr}`);
  console.log(`[PASS] ${label} rejected`);
}
function replace(file, from, to) {
  fs.writeFileSync(path.join(fixture, file), fs.readFileSync(path.join(fixture, file), 'utf8').replace(from, to));
}
try {
  reset();
  const valid = run();
  if (valid.status !== 0) throw new Error(`Valid source fixture failed: ${valid.stderr}`);
  reject('upstream package substitution', 'Cargo.toml: yrs must use the pinned crates.io', () => replace('Cargo.toml', 'package = "myoxus-yrs"', 'package = "yrs"'));
  reject('divergent server version', 'server/Cargo.toml: yrs must use the pinned crates.io', () => replace('server/Cargo.toml', source.version, '0.28.0-myoxus.2'));
  reject('local vendor source', 'Local vendor/yrs source must not shadow', () => fs.mkdirSync(path.join(fixture, 'vendor/yrs'), {recursive:true}));
  for (const file of ['Cargo.lock', 'server/Cargo.lock']) {
    reject(`retired string package in ${file}`, `${file}: retired smallstr remains`, () => fs.appendFileSync(path.join(fixture, file), '\n[[package]]\nname = "smallstr"\nversion = "0.3.1"\n'));
  }
  reject('parallel upstream Yrs source', 'upstream yrs must not coexist', () => fs.appendFileSync(path.join(fixture, 'Cargo.lock'), '\n[[package]]\nname = "yrs"\nversion = "0.28.0"\n'));
  reject('wrong locked archive', 'Cargo.lock: myoxus-yrs must lock the reviewed crates.io archive', () => replace('Cargo.lock', source.crateSha256, '0'.repeat(64)));
  reject('Git source override', 'Cargo.toml: yrs must use the pinned crates.io', () => replace('Cargo.toml', 'package = "myoxus-yrs"', `package = "myoxus-yrs", git = "${source.repository}"`));
  reject('Cargo source substitution', 'Cargo did not resolve the reviewed external', () => {
    const file = path.join(fixture, 'native-metadata.json');
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    metadata.packages[0].source = `git+${source.repository}?rev=${source.revision}#${source.revision}`;
    fs.writeFileSync(file, JSON.stringify(metadata));
  });
  reject('different server source tree', 'Server and native consumers resolved different', () => {
    fs.mkdirSync(path.join(fixture, 'other'));
    fs.copyFileSync(path.join(fixture, 'resolved/Cargo.toml'), path.join(fixture, 'other/Cargo.toml'));
    replace('server-metadata.json', path.join(fixture, 'resolved/Cargo.toml'), path.join(fixture, 'other/Cargo.toml'));
  });
  reject('local edits to resolved package', 'differs from the unmodified reviewed package: src/block.rs', () => fs.appendFileSync(path.join(fixture, 'resolved/src/block.rs'), '\n// unreviewed change\n'));
} finally {
  fs.rmSync(fixture, {recursive:true, force:true});
}
NODE
