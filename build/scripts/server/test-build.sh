#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Packaged server-container contract for P-OFFICE-01.
set -euo pipefail

# Report the failing boundary without expanding commands that contain test secrets.
trap 'printf "[FAIL] packaged container check at line %s (exit %s)\n" "$LINENO" "$?" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SUFFIX="$$-$RANDOM"
IMAGE_NAME="myoxus-server-build-test-$SUFFIX"
SMTP_PID=""
OWNS_IMAGE=true
API_CONTAINER="myoxus-server-test-$SUFFIX"
POSTGRES_CONTAINER="myoxus-postgres-test-$SUFFIX"
REDIS_CONTAINER="myoxus-redis-test-$SUFFIX"
NETWORK="myoxus-server-test-$SUFFIX"
FIXTURE_ROOT="$(mktemp -d)"
SECRET_MARKER="office-container-secret-$SUFFIX:/@ percent%"
REVISION=localdev
if [ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf localdev)"
fi
SERVER_VERSION="$(
  node "$REPO_ROOT/build/scripts/release/write-release-identity.mjs" \
    --repo "$REPO_ROOT" \
    --role server \
    --revision "$REVISION" \
    --print-version
)"

# Reuse only an image whose complete packaged source is still identical. Test
# harness, integration fixtures and frontend-only changes do not require
# another release compilation: test sources are not shipped binary inputs.
if [ -n "${MYOXUS_TEST_SERVER_IMAGE:-}" ]; then
  IMAGE_NAME="$MYOXUS_TEST_SERVER_IMAGE"
  OWNS_IMAGE=false
  REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_NAME")"
  git -C "$REPO_ROOT" cat-file -e "$REVISION^{commit}"
  git -C "$REPO_ROOT" diff --quiet "$REVISION" -- server \
    ':!server/crates/api/tests' ':!server/crates/cli/tests' \
    ':!server/crates/infrastructure/tests' \
    ':!server/crates/infrastructure/src/database_templates/tests.rs' vendor build/dependencies \
    LICENSE \
    build/scripts/release/assemble-server-legal.mjs build/scripts/release/assemble-server-legal.sh \
    build/scripts/release/generate-sbom.sh build/scripts/release/normalize-server-sbom.mjs \
    build/scripts/release/source-correspondence.mjs \
    build/scripts/ci/collect-server-runtime-assets.sh \
    virgultum/icons/src/icon-names.json client/libs/core/public/favicon.ico \
    docs/ops/deployment/systemd \
    build/server/Dockerfile
fi

cleanup() {
  local run_exit=$?
  if [[ -n "$SMTP_PID" ]]; then
    kill "$SMTP_PID" 2>/dev/null || true
    wait "$SMTP_PID" 2>/dev/null || true
  fi
  local postgres_test_volume
  postgres_test_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)"
  # The PostgreSQL image declares an anonymous data volume. Remove it with
  # its owned test container so repeated fixtures leave no database behind.
  docker rm -fv "$API_CONTAINER" "$POSTGRES_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ "$OWNS_IMAGE" = true ]; then
    if [ "$run_exit" -eq 0 ]; then
      docker rmi "$IMAGE_NAME" >/dev/null 2>&1 || true
    elif docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
      echo "[INFO] retained completed image for packaged_image recovery: $IMAGE_NAME"
    fi
  fi
  rm -rf "$FIXTURE_ROOT"
  if [[ -n "$postgres_test_volume" ]] && docker volume inspect "$postgres_test_volume" >/dev/null 2>&1; then
    echo "[FAIL] packaged PostgreSQL test data survived container cleanup" >&2
    return 1
  fi
}
trap cleanup EXIT

mkdir -p \
  "$FIXTURE_ROOT/private" \
  "$FIXTURE_ROOT/runtime-config/git-sync" \
  "$FIXTURE_ROOT/secrets" \
  "$FIXTURE_ROOT/style"
printf '%s\n' "$SECRET_MARKER" >"$FIXTURE_ROOT/secrets/postgres_password"
printf '%s\n' "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
  >"$FIXTURE_ROOT/secrets/crypto_private_key"
openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -days 1 \
  -subj "/CN=Myoxus packaged Git Sync test CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$FIXTURE_ROOT/private/git-sync-ca.key" \
  -out "$FIXTURE_ROOT/runtime-config/git-sync/packaged-ca.pem" \
  >/dev/null 2>&1
cat >"$FIXTURE_ROOT/runtime-config/local.yaml" <<'YAML'
git_sync:
  https_ca_bundle_path: git-sync/packaged-ca.pem
YAML
chmod 600 "$FIXTURE_ROOT/secrets/"*

# Reproduce the bind-mount ownership contract used by the deployment
# preflights. Atomic overlay replacement needs a writable directory, not just
# a readable local.yaml owned by the test runner.
docker run --rm \
  -v "$FIXTURE_ROOT/runtime-config:/runtime-config" \
  -v "$FIXTURE_ROOT/style:/style" \
  alpine:3.20 sh -ec '
    chown 1000:1000 /runtime-config /style
    chmod 700 /runtime-config
    chmod 755 /style
  ' >/dev/null

echo "=== Building packaged server image ==="
if [ "$OWNS_IMAGE" = true ]; then
docker build \
  --pull \
  --build-arg "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-8}" \
  --build-arg "GITHUB_SHA=$REVISION" \
  --build-arg "MYOXUS_SERVER_VERSION=$SERVER_VERSION" \
  -f "$REPO_ROOT/build/server/Dockerfile" \
  -t "$IMAGE_NAME" \
  "$REPO_ROOT"
else
  echo "[INFO] reusing verified unchanged packaged source: $REVISION"
fi
docker image inspect "$IMAGE_NAME" >"$FIXTURE_ROOT/image-inspect.json"
node "$REPO_ROOT/build/scripts/ci/verify-built-release-identity.mjs" \
  --role server \
  --revision "$REVISION" \
  --server-manifest "$REPO_ROOT/server/Cargo.toml" \
  --image-inspect "$FIXTURE_ROOT/image-inspect.json"

# Read archive metadata without installing inspection tools in the runtime.
# Docker cp preserves the container's modes/owners in its tar stream; access
# checks below use the actual configured app UID, not the test host's UID.
assert_container_files() {
python3 - "$API_CONTAINER" "$1" "$FIXTURE_ROOT/image-inspect.json" <<'PY'
import io, json, subprocess, sys, tarfile
container, phase, inspect_path = sys.argv[1:]
def entry(path):
    archive = subprocess.check_output(["docker", "cp", f"{container}:{path}", "-"], stderr=subprocess.DEVNULL)
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        info = files.getmembers()[0]
        if path == "/opt/myoxus/templates/features":
            for member in files.getmembers():
                if member.name.endswith(".myoxus.zip"):
                    shift = 6 if member.uid == 1000 else (3 if member.gid == 999 else 0)
                    assert (member.mode >> shift) & 6 == 4, "packaged Feature archive permissions changed"
        body = files.extractfile(info).read() if info.isfile() else b""
        return info, body
def access(path, bits, immutable=True):
    info, body = entry(path)
    shift = 6 if info.uid == 1000 else (3 if info.gid == 999 else 0)
    permitted = (info.mode >> shift) & 7
    assert permitted & bits == bits, f"app UID cannot access {path}"
    if immutable: assert not permitted & 2, f"app UID can modify {path}"
    return body
if phase == "package":
    image = json.load(open(inspect_path))[0]
    assert image["Config"]["User"] == "myoxus"
    for binary in ["myoxus-server", "myoxus-cli", "myoxus-pdf-compiler"]:
        access(f"/usr/local/bin/{binary}", 5)
    for path in ["static/features/release.yaml", "templates/features/catalog.yaml", "config/default.yaml"]:
        access(f"/opt/myoxus/{path}", 4)
    assert subprocess.run(["docker", "cp", f"{container}:/opt/myoxus/config/local.yaml", "-"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
    info, _ = entry("/opt/myoxus/templates/features")
    assert info.isdir()
    for path in ["licenses/biblatex/LICENSE-MIT", "licenses/hayagriva/NOTICE", "licenses/simba/LICENSE",
                 "licenses/safer-bytes/DECLARED-MIT.txt", "provenance/paste-consumers-source.json"]:
        assert access(f"/usr/share/doc/myoxus-server/{path}", 4)
    for path in ["/run/myoxus", "/opt/myoxus/runtime-config", "/opt/myoxus/runtime-assets/style"]:
        access(path, 3, immutable=False)
    for key, value in {"STORAGE__ROOT":"/opt/myoxus/data/storage", "LOGGING__FILE_PATH":"/opt/myoxus/data/logs/myoxus.log",
                       "GIT_SYNC__REPO_BASE_DIR":"/opt/myoxus/data/git-sync"}.items():
        assert f"MYOXUS__{key}={value}" in image["Config"]["Env"]
    packages = access("/usr/share/doc/myoxus-server/os-packages.tsv", 4).decode().splitlines()
    names = {line.split("\t")[0] for line in packages}
    assert names.isdisjoint({"git", "curl", "libcurl3t64-gnutls", "libcurl4t64", "perl", "perl-base", "perl-modules-5.40", "libperl5.40",
                            "libacl1", "libsystemd0", "libudev1", "libtinfo6", "ncurses-base", "ncurses-bin", "bsdutils", "libblkid1",
                            "liblastlog2-2", "libmount1", "libsmartcols1", "libuuid1", "login", "mount", "util-linux"})
    print(f"[INFO] packaged image: {len(names)} OS packages; {image['Size']} uncompressed bytes")
elif phase == "secret":
    info, body = entry("/run/myoxus/database-url")
    assert info.uid == 1000 and info.mode == 0o600 and body, "database URL must remain private and readable"
elif phase == "mounted":
    assert b"operator customization" in access("/opt/myoxus/templates/mail/en/verify-email.html", 4, immutable=False)
    access("/opt/myoxus/templates/mail/en/change-email.html", 4, immutable=False)
    mounts = json.loads(subprocess.check_output(["docker", "inspect", container]))[0]["Mounts"]
    assert any(m["Destination"] == "/opt/myoxus/templates" and not m["RW"] for m in mounts)
PY
}

echo "=== Verifying immutable package and writable runtime boundaries ==="
docker create --name "$API_CONTAINER" "$IMAGE_NAME" >/dev/null
assert_container_files package
docker rm "$API_CONTAINER" >/dev/null

bash "$SCRIPT_DIR/test-native-template-artifacts.sh" "$IMAGE_NAME" "$FIXTURE_ROOT"

MYOXUS_TEMPLATE_VALIDATOR_IMAGE="$IMAGE_NAME" bash "$SCRIPT_DIR/test-templates.sh"

echo "=== Verifying external template root and non-destructive seeding ==="
bash "$SCRIPT_DIR/prepare-templates.sh" \
  --server-image "$IMAGE_NAME" --output "$FIXTURE_ROOT/templates"
cmp "$REPO_ROOT/server/templates/mail/en/verify-email.html" \
  "$FIXTURE_ROOT/templates/mail/en/verify-email.html"
node - "$FIXTURE_ROOT/templates/mail/en/sign-in.html" <<'NODE'
const fs=require('node:fs'),file=process.argv[2];
fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('Your sign-in link for Myoxus','Operator packaged sign-in').replace('You requested a sign-in link for','packaged operator mail: You requested a sign-in link for'));
NODE

cmp "$REPO_ROOT/server/templates/mail/en/change-email.html" \
  "$FIXTURE_ROOT/templates/mail/en/change-email.html"
printf '\n<!-- operator customization -->\n' >>"$FIXTURE_ROOT/templates/mail/en/verify-email.html"
cp "$FIXTURE_ROOT/templates/mail/en/verify-email.html" "$FIXTURE_ROOT/custom-verify.html"
rm "$FIXTURE_ROOT/templates/mail/en/change-email.html"
bash "$SCRIPT_DIR/prepare-templates.sh" \
  --server-image "$IMAGE_NAME" --output "$FIXTURE_ROOT/templates"
cmp "$FIXTURE_ROOT/custom-verify.html" "$FIXTURE_ROOT/templates/mail/en/verify-email.html"
cmp "$REPO_ROOT/server/templates/mail/en/change-email.html" \
  "$FIXTURE_ROOT/templates/mail/en/change-email.html"
# Source-directory delivery consumes the same generated release as image
# delivery. Loose authoring files are inputs to pack, never a runtime fallback.
docker create --name "$API_CONTAINER" "$IMAGE_NAME" >/dev/null
docker cp "$API_CONTAINER:/opt/myoxus/templates" "$FIXTURE_ROOT/release-source"
docker rm "$API_CONTAINER" >/dev/null
bash "$SCRIPT_DIR/prepare-templates.sh" \
  --source-dir "$FIXTURE_ROOT/release-source" --validator-image "$IMAGE_NAME" --output "$FIXTURE_ROOT/templates"
cmp "$FIXTURE_ROOT/custom-verify.html" "$FIXTURE_ROOT/templates/mail/en/verify-email.html"

# Consume both deployment definitions: the host path must remain an editable
# config choice, while the mount must not let the API replace operator files.
MYOXUS_TEMPLATE_HOST_DIR="$FIXTURE_ROOT/templates" \
MYOXUS_POSTGRES_PASSWORD_FILE="$FIXTURE_ROOT/secrets/postgres_password" \
MYOXUS_CRYPTO_PRIVATE_KEY_FILE="$FIXTURE_ROOT/secrets/crypto_private_key" \
docker compose -f "$REPO_ROOT/build/server/docker-compose.selfhost.yml" config --format json \
  >"$FIXTURE_ROOT/compose.json"
MYOXUS_SWARM_STATE_ROOT="$FIXTURE_ROOT" \
MYOXUS_SERVER_IMAGE_TAG="$REVISION" \
MYOXUS_SERVER_ORIGIN=http://localhost:3010 \
MYOXUS_FRONTEND_ASSET_ROOT="$FIXTURE_ROOT/frontends" \
docker compose -f "$REPO_ROOT/build/server/docker-stack.registry.yml" config --format json \
  >"$FIXTURE_ROOT/swarm.json"
node - "$FIXTURE_ROOT" <<'NODE'
const fs = require("node:fs");
const root = process.argv[2];
for (const name of ["compose", "swarm"]) {
  const config = JSON.parse(fs.readFileSync(`${root}/${name}.json`, "utf8"));
  const mount = config.services.api.volumes.find(volume => volume.target === "/opt/myoxus/templates");
  if (mount?.source !== `${root}/templates` || mount?.type !== "bind" || mount?.read_only !== true) {
    throw new Error(`${name} template mount differs: ${JSON.stringify(mount)}`);
  }
  // Compose omits false flags from JSON; an empty bind object is the same
  // non-creating mount. Short bind syntax renders create_host_path: true.
  if (name === "compose" && mount.bind?.create_host_path === true) {
    throw new Error("Compose may create an empty directory that hides packaged templates");
  }
  if (config.services.api.environment.MYOXUS__TEMPLATES__ROOT_DIR !== undefined) {
    throw new Error(`${name} overrides the Admin-owned template root`);
  }
}
NODE
node - "$FIXTURE_ROOT" "$REPO_ROOT" <<'NODE'
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [state, repo] = process.argv.slice(2);
const environment = Object.fromEntries([
  "DATA_DIR", "RUNTIME_CONFIG_DIR", "STYLE_HOST_DIR", "POSTGRES_PASSWORD_FILE", "CRYPTO_PRIVATE_KEY_FILE", "FRONTEND_ASSET_ROOT"
].map(key => [`MYOXUS_${key}`, `${state}/${key.toLowerCase()}`]));
const file = `${state}/profile.json`;
const profile = { schema: "myoxus.runtime-profile.v1", checkout: repo, stateDirectory: state, project: "mail-template-test", mode: "isolated", environment };
const exportsFor = () => execFileSync(process.execPath, [`${repo}/build/scripts/server/runtime-profile.mjs`, "exports", repo], {
  encoding: "utf8", env: { ...process.env, MYOXUS_RUNTIME_PROFILE: file }
});
fs.writeFileSync(file, JSON.stringify(profile));
if (!exportsFor().includes(`export MYOXUS_TEMPLATE_HOST_DIR='${state}/templates'`)) {
  throw new Error("Existing runtime profiles did not gain their own template directory");
}
environment.MYOXUS_TEMPLATE_HOST_DIR = `${state}/custom-templates`;
fs.writeFileSync(file, JSON.stringify(profile));
if (!exportsFor().includes(`export MYOXUS_TEMPLATE_HOST_DIR='${state}/custom-templates'`)) {
  throw new Error("Configured runtime template directory was ignored");
}
environment.MYOXUS_TEMPLATE_HOST_DIR = "/foreign-templates";
fs.writeFileSync(file, JSON.stringify(profile));
let rejected = false;
try { exportsFor(); } catch { rejected = true; }
if (!rejected) throw new Error("Runtime profiles accepted a foreign template directory");
NODE
docker create --name "$API_CONTAINER" \
  -v "$FIXTURE_ROOT/templates:/opt/myoxus/templates:ro" "$IMAGE_NAME" >/dev/null
assert_container_files mounted
docker rm "$API_CONTAINER" >/dev/null
cmp "$FIXTURE_ROOT/custom-verify.html" "$FIXTURE_ROOT/templates/mail/en/verify-email.html"

echo "=== Verifying production secret failures are fail-closed and redacted ==="
if docker run --rm "$IMAGE_NAME" /usr/local/bin/myoxus-cli --version \
  >"$FIXTURE_ROOT/missing-secret.stdout" 2>"$FIXTURE_ROOT/missing-secret.stderr"; then
  echo "[FAIL] packaged server accepted a missing PostgreSQL secret" >&2
  exit 1
fi
grep -q 'postgres password secret is missing' "$FIXTURE_ROOT/missing-secret.stderr"
if grep -q '/run/secrets/postgres_password' "$FIXTURE_ROOT/missing-secret.stderr"; then
  echo "[FAIL] missing-secret diagnostic disclosed its credential-bearing path" >&2
  exit 1
fi

docker network create "$NETWORK" >/dev/null
SMTP_HOST="$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK")"
node "$SCRIPT_DIR/packaged-template-smtp.mjs" "$SMTP_HOST" "$FIXTURE_ROOT/smtp" \
  >"$FIXTURE_ROOT/smtp.log" 2>&1 &
SMTP_PID=$!
for _ in $(seq 1 30); do
  [[ ! -f "$FIXTURE_ROOT/smtp/ready.json" ]] || break
  kill -0 "$SMTP_PID"
  sleep 1
done
SMTP_PORT="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1])).port))' "$FIXTURE_ROOT/smtp/ready.json")"
printf '\nmail:\n  smtp_host: "%s"\n  smtp_port: %s\n  smtp_transport: plain\n' \
  "$SMTP_HOST" "$SMTP_PORT" >>"$FIXTURE_ROOT/runtime-config/local.yaml"

docker run -d --name "$POSTGRES_CONTAINER" --network "$NETWORK" --network-alias postgres \
  -e POSTGRES_USER=myoxus \
  -e POSTGRES_DB=myoxus \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
  -v "$FIXTURE_ROOT/secrets/postgres_password:/run/secrets/postgres_password:ro" \
  pgvector/pgvector:pg16 >/dev/null
docker run -d --name "$REDIS_CONTAINER" --network "$NETWORK" --network-alias redis redis:8 >/dev/null

# The image's temporary init server accepts Unix sockets before restarting.
# TCP readiness belongs to the final server that the API can actually reach.
for _ in $(seq 1 60); do
  if docker exec "$POSTGRES_CONTAINER" pg_isready -h 127.0.0.1 -U myoxus -d myoxus >/dev/null 2>&1 \
    && docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$POSTGRES_CONTAINER" pg_isready -h 127.0.0.1 -U myoxus -d myoxus >/dev/null
docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null

docker run -d --name "$API_CONTAINER" --network "$NETWORK" \
  -p 127.0.0.1::3001 \
  -e RUN_MODE=production \
  -e POSTGRES_HOST=postgres \
  -e POSTGRES_PORT=5432 \
  -e POSTGRES_USER=myoxus \
  -e POSTGRES_DB=myoxus \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
  -e MYOXUS__DATABASE__URL_FILE=/run/myoxus/database-url \
  -e MYOXUS__CRYPTO__PRIVATE_KEY_FILE=/run/secrets/crypto_private_key \
  -e MYOXUS__CONFIG__WRITEBACK_PATH=/opt/myoxus/runtime-config/local.yaml \
  -e MYOXUS__BRANDING__STYLE_DIR=/opt/myoxus/runtime-assets/style \
  -e MYOXUS__REDIS__URL=redis://redis:6379 \
  -e MYOXUS__SERVER__ORIGIN=http://localhost:3010 \
  -v "$FIXTURE_ROOT/secrets:/run/secrets:ro" \
  -v "$FIXTURE_ROOT/runtime-config:/opt/myoxus/runtime-config:rw" \
  -v "$FIXTURE_ROOT/style:/opt/myoxus/runtime-assets/style:rw" \
  -v "$FIXTURE_ROOT/templates:/opt/myoxus/templates:ro" \
  "$IMAGE_NAME" >/dev/null

for _ in $(seq 1 120); do
  if docker exec "$API_CONTAINER" myoxus-cli container health >/dev/null 2>&1; then
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$API_CONTAINER")" != true ]]; then
    echo "[FAIL] packaged API exited before becoming healthy" >&2
    docker logs --tail 100 "$API_CONTAINER" >&2
    exit 1
  fi
  sleep 1
done
docker exec "$API_CONTAINER" myoxus-cli container health
API_ORIGIN="http://$(docker port "$API_CONTAINER" 3001/tcp)"
curl -fsS "$API_ORIGIN/info" >"$FIXTURE_ROOT/info.json"
docker logs "$API_CONTAINER" >"$FIXTURE_ROOT/api-startup.log" 2>&1
sed -E $'s/\033\\[[0-9;]*[mK]//g' \
  "$FIXTURE_ROOT/api-startup.log" >"$FIXTURE_ROOT/api-startup.normalized.log"
for expected in \
  'materialized restart-bound Git-Sync HTTPS CA bundle' \
  'certificate_count=1' \
  'policy="additional_ca_plus_system_roots"' \
  'restart_required=true'; do
  if ! grep -q -F "$expected" "$FIXTURE_ROOT/api-startup.normalized.log"; then
    echo "[FAIL] packaged Git-Sync CA startup log omitted: $expected" >&2
    tail -n 100 "$FIXTURE_ROOT/api-startup.normalized.log" >&2
    exit 1
  fi
done
if grep -q -- '-----BEGIN CERTIFICATE-----' "$FIXTURE_ROOT/api-startup.normalized.log"; then
  echo "[FAIL] packaged Git-Sync CA material leaked into startup logs" >&2
  exit 1
fi
node -e '
const info = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (info.version !== process.argv[2]) {
  throw new Error(`server /info version ${info.version} does not match OCI version ${process.argv[2]}`);
}
' "$FIXTURE_ROOT/info.json" "$SERVER_VERSION"

echo "=== Verifying mounted mail delivery and document registration ==="
. "$SCRIPT_DIR/lib-auth-smoke.sh"
MAIL_RECIPIENT="packaged-template-$SUFFIX@example.test"
docker exec "$API_CONTAINER" myoxus-cli users create --email "$MAIL_RECIPIENT" --name 'Packaged Mail Recipient' \
  >"$FIXTURE_ROOT/mail-user.json" 2>"$FIXTURE_ROOT/mail-user.stderr"
CAPTCHA="$(captcha_token "$API_ORIGIN")"
headers=(-H 'Content-Type: application/json')
[[ -z "$CAPTCHA" ]] || headers+=(-H "x-captcha-token: $CAPTCHA")
printf '{"email":"%s"}' "$MAIL_RECIPIENT" >"$FIXTURE_ROOT/sign-in.json"
curl -fsS "$API_ORIGIN/api/auth/sign-in" -X POST "${headers[@]}" \
  --data-binary @"$FIXTURE_ROOT/sign-in.json" >"$FIXTURE_ROOT/sign-in-response.json"
for _ in $(seq 1 30); do
  [[ ! -f "$FIXTURE_ROOT/smtp/0.eml" ]] || break
  sleep 1
done
node - "$FIXTURE_ROOT/smtp/0.eml" <<'NODE'
const fs=require('node:fs'),assert=require('node:assert/strict');
const message=fs.readFileSync(process.argv[2],'utf8');
assert.match(message,/Subject: Operator packaged sign-in\r?\n/);
assert.match(message,/packaged operator mail/);
NODE
meeting_revisions() {
  docker exec "$POSTGRES_CONTAINER" psql -U myoxus -d myoxus -Atc \
    "SELECT e.slug,r.id,r.version,r.checksum FROM template_catalog_entries e JOIN template_revisions r ON r.template_id=e.id WHERE e.slug IN ('meeting-focus','meeting-agenda','meeting-register') ORDER BY e.slug,r.version"
}
meeting_revisions >"$FIXTURE_ROOT/meeting-before.txt"
node - "$REPO_ROOT/server/templates/features/base/manifest.yaml" "$FIXTURE_ROOT/meeting-before.txt" <<'NODE'
const fs = require('node:fs'), YAML = require('yaml'), assert = require('node:assert/strict');
// The Feature manifest selects shipped versions; loose authoring archives can
// retain other versions that are deliberately not part of the release.
const expected = YAML.parse(fs.readFileSync(process.argv[2], 'utf8')).components
  .filter(component => component.kind === 'documentTemplate')
  .flatMap(component => {
    const match = /^documents\/(meeting-(?:agenda|focus|register))\/([^/]+)\.zip$/.exec(component.path);
    return match ? [`${match[1]}|${match[2]}`] : [];
  }).sort();
const actual = fs.readFileSync(process.argv[3], 'utf8').trim().split('\n').map(line => {
  const [slug, revision, version, checksum] = line.split('|');
  assert.ok(revision && checksum, 'registered source must retain revision and checksum');
  return `${slug}|${version}`;
}).sort();
assert.deepEqual(actual, expected, 'Registry must register every delivered native version exactly once');
NODE

echo "=== Verifying in-container CLI and credential redaction ==="
CLI_STDOUT="$FIXTURE_ROOT/cli.stdout"
CLI_STDERR="$FIXTURE_ROOT/cli.stderr"
docker exec "$API_CONTAINER" myoxus-cli users list >"$CLI_STDOUT" 2>"$CLI_STDERR"
assert_container_files secret

echo "=== Verifying effective config provenance and lifecycle ==="
docker exec "$API_CONTAINER" myoxus-cli config export --raw-source --format json \
  >"$FIXTURE_ROOT/config-before.json"
node - "$FIXTURE_ROOT/config-before.json" <<'NODE'
const fields = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const byPath = new Map(fields.map(field => [field.path, field]));
const origin = byPath.get("server.origin");
const crypto = byPath.get("crypto.private_key");
if (origin?.winning_source !== "ENVIRONMENT" ||
    origin?.winning_key !== "MYOXUS__SERVER__ORIGIN" ||
    origin?.runtime_effective_state !== "EFFECTIVE") {
  throw new Error(`origin provenance mismatch: ${JSON.stringify(origin)}`);
}
if (crypto?.winning_source !== "SECRET_FILE" ||
    crypto?.winning_key !== "MYOXUS__CRYPTO__PRIVATE_KEY_FILE" ||
    crypto?.configured_value !== "***REDACTED***" ||
    crypto?.runtime_effective_value !== "***REDACTED***") {
  throw new Error(`crypto secret projection mismatch: ${JSON.stringify(crypto)}`);
}
NODE

docker exec "$API_CONTAINER" myoxus-cli config set git_sync.enabled false \
  >>"$CLI_STDOUT" 2>>"$CLI_STDERR"
docker exec "$API_CONTAINER" myoxus-cli config set mail.smtp_host '"smtp.packaged.invalid"' \
  >>"$CLI_STDOUT" 2>>"$CLI_STDERR"
docker exec "$API_CONTAINER" myoxus-cli config export --raw-source --format json \
  >"$FIXTURE_ROOT/config-pending.json"
node - "$FIXTURE_ROOT/config-pending.json" <<'NODE'
const fields = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const byPath = new Map(fields.map(field => [field.path, field]));
const enabled = byPath.get("git_sync.enabled");
const smtp = byPath.get("mail.smtp_host");
if (enabled?.winning_source !== "DATABASE" ||
    enabled?.runtime_effective_value !== false ||
    enabled?.runtime_effective_state !== "EFFECTIVE") {
  throw new Error(`live Git Sync override mismatch: ${JSON.stringify(enabled)}`);
}
if (smtp?.winning_source !== "DATABASE" ||
    smtp?.configured_value !== "smtp.packaged.invalid" ||
    smtp?.runtime_effective_value !== "smtp.packaged.invalid" ||
    smtp?.runtime_effective_state !== "EFFECTIVE" ||
    smtp?.restart_required !== true) {
  throw new Error(`SMTP CLI projection mismatch: ${JSON.stringify(smtp)}`);
}
NODE
grep -q '^git_sync:$' "$FIXTURE_ROOT/runtime-config/local.yaml"
grep -q '^  https_ca_bundle_path: git-sync/packaged-ca.pem$' \
  "$FIXTURE_ROOT/runtime-config/local.yaml"
grep -q '^mail:$' "$FIXTURE_ROOT/runtime-config/local.yaml"
grep -q '^  smtp_host: smtp.packaged.invalid$' \
  "$FIXTURE_ROOT/runtime-config/local.yaml"

echo "=== Verifying restart persistence and file-backed CLI recovery ==="
docker restart "$API_CONTAINER" >/dev/null
for _ in $(seq 1 120); do
  if docker exec "$API_CONTAINER" myoxus-cli container health >/dev/null 2>&1; then
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$API_CONTAINER")" != true ]]; then
    echo "[FAIL] packaged API exited during restart recovery" >&2
    docker logs --tail 100 "$API_CONTAINER" >&2
    exit 1
  fi
  sleep 1
done
docker exec "$API_CONTAINER" myoxus-cli container health
docker exec "$API_CONTAINER" myoxus-cli users list >>"$CLI_STDOUT" 2>>"$CLI_STDERR"
assert_container_files mounted
cmp "$FIXTURE_ROOT/custom-verify.html" "$FIXTURE_ROOT/templates/mail/en/verify-email.html"
docker exec "$API_CONTAINER" myoxus-cli config export --raw-source --format json \
  >"$FIXTURE_ROOT/config-after.json"
node - "$FIXTURE_ROOT/config-after.json" <<'NODE'
const fields = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const byPath = new Map(fields.map(field => [field.path, field]));
const smtp = byPath.get("mail.smtp_host");
if (smtp?.winning_source !== "DATABASE" ||
    smtp?.configured_value !== "smtp.packaged.invalid" ||
    smtp?.runtime_effective_value !== "smtp.packaged.invalid" ||
    smtp?.runtime_effective_state !== "EFFECTIVE") {
  throw new Error(`SMTP restart materialization mismatch: ${JSON.stringify(smtp)}`);
}
NODE
grep -q '^mail:$' "$FIXTURE_ROOT/runtime-config/local.yaml"
grep -q '^  smtp_host: smtp.packaged.invalid$' "$FIXTURE_ROOT/runtime-config/local.yaml"
grep -q '^git_sync:$' "$FIXTURE_ROOT/runtime-config/local.yaml"
grep -q '^  https_ca_bundle_path: git-sync/packaged-ca.pem$' \
  "$FIXTURE_ROOT/runtime-config/local.yaml"

meeting_revisions >"$FIXTURE_ROOT/meeting-after.txt"
cmp "$FIXTURE_ROOT/meeting-before.txt" "$FIXTURE_ROOT/meeting-after.txt"
bash "$SCRIPT_DIR/prepare-templates.sh" --server-image "$IMAGE_NAME" --output "$FIXTURE_ROOT/templates"
cmp "$FIXTURE_ROOT/custom-verify.html" "$FIXTURE_ROOT/templates/mail/en/verify-email.html"

echo "=== Verifying packaged workspace lifecycle CLI ==="
LIFECYCLE_EMAIL="workspace-lifecycle-$SUFFIX@packaged.invalid"
docker exec "$API_CONTAINER" myoxus-cli --json users create \
  --email "$LIFECYCLE_EMAIL" --name "Packaged Workspace Owner" \
  >"$FIXTURE_ROOT/lifecycle-user.json" 2>>"$CLI_STDERR"
docker exec "$API_CONTAINER" myoxus-cli --json workspaces create \
  --owner-user "$LIFECYCLE_EMAIL" --name "Packaged Lifecycle" \
  >"$FIXTURE_ROOT/lifecycle-created.json" 2>>"$CLI_STDERR"
LIFECYCLE_WORKSPACE_ID="$(node -e '
const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (typeof value.id !== "string" || value.id.length === 0) {
  throw new Error("packaged workspace create did not return an id");
}
process.stdout.write(value.id);
' "$FIXTURE_ROOT/lifecycle-created.json")"
docker exec "$API_CONTAINER" myoxus-cli --json workspaces get "$LIFECYCLE_WORKSPACE_ID" \
  >"$FIXTURE_ROOT/lifecycle-before-delete.json" 2>>"$CLI_STDERR"
docker exec "$API_CONTAINER" myoxus-cli workspaces delete "$LIFECYCLE_WORKSPACE_ID" --confirm \
  >>"$CLI_STDOUT" 2>>"$CLI_STDERR"
docker exec "$API_CONTAINER" myoxus-cli --json workspaces get "$LIFECYCLE_WORKSPACE_ID" \
  >"$FIXTURE_ROOT/lifecycle-deleted.json" 2>>"$CLI_STDERR"
docker exec "$API_CONTAINER" myoxus-cli --json workspaces undelete "$LIFECYCLE_WORKSPACE_ID" \
  >"$FIXTURE_ROOT/lifecycle-restored.json" 2>>"$CLI_STDERR"
node - \
  "$LIFECYCLE_WORKSPACE_ID" \
  "$FIXTURE_ROOT/lifecycle-before-delete.json" \
  "$FIXTURE_ROOT/lifecycle-deleted.json" \
  "$FIXTURE_ROOT/lifecycle-restored.json" <<'NODE'
const fs = require("node:fs");
const expectedId = process.argv[2];
const [before, deleted, restored] = process.argv.slice(3).map(path =>
  JSON.parse(fs.readFileSync(path, "utf8"))
);
if (before.id !== expectedId || deleted.id !== expectedId || restored.id !== expectedId) {
  throw new Error("packaged workspace lifecycle changed workspace identity");
}
if (typeof deleted.deleted_at !== "string" || deleted.deleted_at.length === 0) {
  throw new Error("packaged workspace delete did not expose the soft-deleted state");
}
if (restored.deleted_at !== "") {
  throw new Error("packaged workspace undelete did not restore the active state");
}
NODE

node "$SCRIPT_DIR/test-global-tls-bootstrap.mjs" \
  "$IMAGE_NAME" "$API_CONTAINER" "$POSTGRES_CONTAINER" "$NETWORK" "$FIXTURE_ROOT"

node "$SCRIPT_DIR/test-packaged-template-loaders.mjs" \
  "$API_CONTAINER" "$POSTGRES_CONTAINER" "$FIXTURE_ROOT"

if [[ "${MYOXUS_PACKAGED_VERIFY_CODEGEN:-0}" == 1 ]]; then
  # Docker can reassign an ephemeral host port after the restart journeys.
  API_ORIGIN="http://$(docker port "$API_CONTAINER" 3001/tcp)"
  MYOXUS_CODEGEN_SERVER_ORIGIN="$API_ORIGIN" \
    bash "$REPO_ROOT/build/scripts/test/run.sh" --suite graphql.codegen.stack --strict
fi

docker inspect "$API_CONTAINER" >"$FIXTURE_ROOT/inspect.json"
docker top "$API_CONTAINER" -eo pid,args >"$FIXTURE_ROOT/processes.txt"
docker logs "$API_CONTAINER" >"$FIXTURE_ROOT/api.log" 2>&1
if grep -R -q -F "$SECRET_MARKER" \
  "$CLI_STDOUT" "$CLI_STDERR" "$FIXTURE_ROOT/inspect.json" \
  "$FIXTURE_ROOT/processes.txt" "$FIXTURE_ROOT/api.log"; then
  echo "[FAIL] database credential leaked through output, container metadata, process list or logs" >&2
  exit 1
fi
if grep -R -q -E 'postgres://[^[:space:]]+@' \
  "$CLI_STDOUT" "$CLI_STDERR" "$FIXTURE_ROOT/inspect.json" \
  "$FIXTURE_ROOT/processes.txt" "$FIXTURE_ROOT/api.log"; then
  echo "[FAIL] database URL leaked through output, container metadata, process list or logs" >&2
  exit 1
fi

echo "=== Packaged server-container contract passed ==="
