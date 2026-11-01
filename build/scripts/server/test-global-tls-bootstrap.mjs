#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Admitted by server.packaged-container; all state belongs to test-build.sh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const [image, api, postgres, network, root] = process.argv.slice(2);
assert(
  image && api && postgres && network && root,
  "packaged fixture arguments",
);
const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
const caPath = join(root, "runtime-config/git-sync/packaged-ca.pem");
// Docker reallocates an ephemeral published port across container restarts.
const apiOrigin = () => `http://${docker(["port", api, "3001/tcp"]).trim()}`;
const configPath = join(root, "runtime-config/local.yaml");
const fingerprint = () =>
  createHash("sha256").update(readFileSync(caPath)).digest("hex");
function trust() {
  const health = JSON.parse(
    execFileSync("curl", ["-fsS", `${apiOrigin()}/health`], {
      encoding: "utf8",
      timeout: 30000,
    }),
  );
  const check = health.checks.find(
    (item) => item.name === "additional_ca_trust",
  );
  assert(check, "packaged API must publish its loaded trust");
  assert.equal(check.status, "pass");
  return { code: check.code, ...JSON.parse(check.detail) };
}
async function restart() {
  docker(["restart", api]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return trust();
    } catch (error) {
      assert.equal(
        docker(["inspect", "-f", "{{.State.Running}}", api]).trim(),
        "true",
        "API exited during trust restart",
      );
      if (attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
const cli = (...args) => docker(["exec", "-i", api, "myoxus-cli", ...args]);
function sql(statement) {
  return docker(
    [
      "exec",
      "-i",
      postgres,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "myoxus",
      "-d",
      "myoxus",
      "-At",
    ],
    { input: statement },
  );
}
function setConfig(update) {
  const config = YAML.parse(readFileSync(configPath, "utf8"));
  update(config);
  writeFileSync(configPath, YAML.stringify(config));
}

console.log(
  "=== Global TLS: old file alias loads the global startup snapshot ===",
);
assert.equal(trust().additional_ca_count, 1);
assert.equal(trust().snapshot_id, fingerprint());
assert.equal(trust().code, "tls_bootstrap_loaded");

console.log(
  "=== Global TLS: invalid trust fails before database/network access ===",
);
for (const env of [
  ["MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH=missing.pem"],
  ["MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH=../outside.pem"],
  [
    "MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH=new.pem",
    "MYOXUS__GIT_SYNC__HTTPS_CA_BUNDLE_PATH=old.pem",
  ],
]) {
  const name = `myoxus-tls-fail-${randomUUID()}`;
  try {
    let failure;
    try {
      docker(
        [
          "run",
          "--rm",
          "--name",
          name,
          "--network",
          "none",
          "--entrypoint",
          "/usr/local/bin/myoxus-cli",
          "-e",
          "MYOXUS__DATABASE__URL=postgres://unreachable:credential-marker@127.0.0.1:1/absent",
          ...env.flatMap((value) => ["-e", value]),
          image,
          "users",
          "list",
        ],
        { timeout: 10000 },
      );
    } catch (error) {
      failure = error;
    }
    assert(
      failure && failure.status !== null,
      "CLI must exit itself before any network timeout",
    );
    const stderr = String(failure.stderr);
    assert.match(
      stderr,
      env.length === 2
        ? /conflicting tls\.additional_ca_bundle_path and deprecated git_sync\.https_ca_bundle_path/
        : /invalid bootstrap TLS configuration/,
    );
    assert(!stderr.includes("credential-marker"));
  } finally {
    // --rm normally removed it; inspect first so a timeout cannot leak a child.
    const remaining = docker([
      "ps",
      "-aq",
      "--filter",
      `name=^/${name}$`,
    ]).trim();
    if (remaining) docker(["rm", "-f", name]);
  }
}

console.log(
  "=== Global TLS: read-only runtime mount supports fresh CLI startup ===",
);
const readOnly = `myoxus-tls-readonly-${randomUUID()}`;
try {
  docker([
    "run",
    "--rm",
    "--name",
    readOnly,
    "--network",
    network,
    "-e",
    "RUN_MODE=production",
    "-e",
    "POSTGRES_HOST=postgres",
    "-e",
    "POSTGRES_USER=myoxus",
    "-e",
    "POSTGRES_DB=myoxus",
    "-e",
    "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password",
    "-e",
    "MYOXUS__DATABASE__URL_FILE=/run/myoxus/database-url",
    "-e",
    "MYOXUS__CRYPTO__PRIVATE_KEY_FILE=/run/secrets/crypto_private_key",
    "-e",
    "MYOXUS__CONFIG__WRITEBACK_PATH=/opt/myoxus/runtime-config/local.yaml",
    "-e",
    "MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH=git-sync/packaged-ca.pem",
    "-v",
    `${root}/secrets:/run/secrets:ro`,
    "-v",
    `${root}/runtime-config:/opt/myoxus/runtime-config:ro`,
    image,
    "myoxus-cli",
    "users",
    "list",
  ]);
} finally {
  if (docker(["ps", "-aq", "--filter", `name=^/${readOnly}$`]).trim())
    docker(["rm", "-f", readOnly]);
}

console.log(
  "=== Global TLS: file replacement/removal never changes the running snapshot ===",
);
const before = trust().snapshot_id;
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Myoxus replacement fixture CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    join(root, "private/replacement.key"),
    "-out",
    caPath,
  ],
  { stdio: "pipe", timeout: 15000 },
);
assert.notEqual(fingerprint(), before);
assert.equal(trust().snapshot_id, before);
assert.equal((await restart()).snapshot_id, fingerprint());
const loaded = trust().snapshot_id;
const saved = join(root, "private/saved-ca.pem");
copyFileSync(caPath, saved);
unlinkSync(caPath);
assert.equal(trust().snapshot_id, loaded);
let missing;
try {
  cli("users", "list");
} catch (error) {
  missing = error;
}
assert(missing, "fresh CLI must reject a removed CA");
assert.match(String(missing.stderr), /invalid bootstrap TLS configuration/);
copyFileSync(saved, caPath);

console.log(
  "=== Global TLS: DB-only legacy is Git-only, explicit empty overrides it ===",
);
sql(
  "INSERT INTO app_configs (id,value,created_at,updated_at) VALUES ('git_sync.https_ca_bundle_path','\"git-sync/packaged-ca.pem\"'::jsonb,now(),now()) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value;",
);
setConfig((config) => {
  delete config.git_sync.https_ca_bundle_path;
});
let state = await restart();
assert.equal(state.code, "tls_legacy_git_migration_required");
assert.equal(state.additional_ca_count, 0);
assert.equal(state.legacy_git_ca_count, 1);
setConfig((config) => {
  config.tls = { additional_ca_bundle_path: "" };
});
state = await restart();
assert.equal(state.code, "tls_bootstrap_loaded");
assert.equal(state.additional_ca_count, 0);
assert.equal(state.legacy_git_ca_count, 0);

console.log(
  "=== Global TLS: migrate bootstrap first, remove legacy only after activation ===",
);
setConfig((config) => {
  config.tls.additional_ca_bundle_path = "git-sync/packaged-ca.pem";
});
state = await restart();
assert.equal(state.snapshot_id, fingerprint());
assert.equal(state.additional_ca_count, 1);
assert.equal(state.legacy_git_ca_count, 0);
docker(["exec", "-i", api, "myoxus-cli", "config", "import", "-"], {
  input: JSON.stringify({ git_sync: { https_ca_bundle_path: null } }),
});
assert.equal(
  sql(
    "SELECT count(*) FROM app_configs WHERE id='git_sync.https_ca_bundle_path';",
  ).trim(),
  "0",
);
assert.equal((await restart()).snapshot_id, fingerprint());
console.log("[PASS] packaged global TLS bootstrap and deployed migration");
