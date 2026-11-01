#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  readFileSync,
  realpathSync,
  statSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const [command, repo] = process.argv.slice(2);
const file = process.env.MYOXUS_RUNTIME_PROFILE;
if (!file || !isAbsolute(file))
  throw new Error(
    "Set MYOXUS_RUNTIME_PROFILE to an explicit isolated or maintenance instance profile before changing runtime state.",
  );
const profile = JSON.parse(readFileSync(file, "utf8"));
const root = realpathSync(repo);
const inside = (base, path) => {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
if (
  profile.schema !== "myoxus.runtime-profile.v1" ||
  profile.checkout !== root ||
  !["isolated", "maintenance"].includes(profile.mode)
)
  throw new Error("Runtime profile does not belong to this checkout");
if (!isAbsolute(profile.stateDirectory) || inside(root, profile.stateDirectory))
  throw new Error("Runtime state must be outside the checkout");
if (!/^[a-z0-9][a-z0-9_-]+$/.test(profile.project))
  throw new Error("Invalid Compose identity");
if (process.getuid && statSync(file).uid !== process.getuid())
  throw new Error("Runtime profile owner differs");
const allowed =
  /^(COMPOSE_PROJECT_NAME|POSTGRES_(IMAGE|USER|DB|PORT|IMAGE_TAG|DATA_VOLUME|MEMORY_LIMIT|MEMORY_SWAP_LIMIT)|REDIS_(IMAGE|PORT|IMAGE_TAG|DATA_VOLUME|MEMORY_LIMIT|MEMORY_SWAP_LIMIT)|RUN_MODE|MYOXUS_(RUNTIME_SKIP_SEED|RUNTIME_MODE|QA_ARTIFACT_DIR|DATA_DIR|RUNTIME_CONFIG_DIR|STYLE_HOST_DIR|TEMPLATE_HOST_DIR|POSTGRES_PASSWORD_FILE|CRYPTO_PRIVATE_KEY_FILE|API_USER|API_MEMORY_LIMIT|API_MEMORY_SWAP_LIMIT|PUBLIC_HOST|PUBLIC_PORT|FRONTEND_PORT|FRONTEND_BASE_PATH|SOCKET_IO_PROXY_READ_TIMEOUT_SECONDS|SOCKET_IO_PROXY_SEND_TIMEOUT_SECONDS|SERVER_ORIGIN|FRONTEND_ASSET_ROOT|LOCAL_WEB_IMAGE|LOCAL_ADMIN_IMAGE|API_IMAGE|NGINX_IMAGE|PDF_FONTS_VOLUME))$/;
const env = {
  ...profile.environment,
  // Existing profiles gain a directory within their already owned state root.
  MYOXUS_TEMPLATE_HOST_DIR:
    profile.environment.MYOXUS_TEMPLATE_HOST_DIR ??
    resolve(profile.stateDirectory, "templates"),
  COMPOSE_PROJECT_NAME: profile.project,
  MYOXUS_RUNTIME_MODE: profile.mode,
  MYOXUS_RUNTIME_SKIP_SEED: profile.mode === "maintenance" ? "true" : "false",
};
for (const [key, value] of Object.entries(env))
  if (
    !allowed.test(key) ||
    typeof value !== "string" ||
    value.includes("\n") ||
    value.includes("\0")
  )
    throw new Error(`Invalid runtime environment field ${key}`);
for (const key of [
  "MYOXUS_DATA_DIR",
  "MYOXUS_RUNTIME_CONFIG_DIR",
  "MYOXUS_STYLE_HOST_DIR",
  "MYOXUS_TEMPLATE_HOST_DIR",
  "MYOXUS_POSTGRES_PASSWORD_FILE",
  "MYOXUS_CRYPTO_PRIVATE_KEY_FILE",
  "MYOXUS_FRONTEND_ASSET_ROOT",
]) {
  const value = env[key];
  if (
    !value ||
    !isAbsolute(value) ||
    !inside(profile.stateDirectory, resolve(value))
  )
    throw new Error(`Runtime path must belong to the instance: ${key}`);
  // Missing leaves still inherit the boundary of their nearest existing parent.
  let ancestor = resolve(value);
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    ancestor = dirname(ancestor);
  }
  if (!inside(realpathSync(profile.stateDirectory), realpathSync(ancestor)))
    throw new Error(`Runtime path escapes through a symlink: ${key}`);
}
// Every local application build receives a revision-specific image identity;
// recovery images from either checkout are never overwritten by default tags.
const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/.test(revision))
  throw new Error("Missing source revision");
env.MYOXUS_API_IMAGE = `myoxus-api:${revision}`;
env.MYOXUS_LOCAL_WEB_IMAGE = `myoxus-web-frontend:${revision}`;
env.MYOXUS_LOCAL_ADMIN_IMAGE = `myoxus-admin-frontend:${revision}`;
if (command === "exports") {
  for (const [key, value] of Object.entries(env))
    console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`);
} else if (command === "verify" || command === "verify-build") {
  if (command === "verify-build") {
    if (
      execFileSync("git", ["-C", root, "status", "--porcelain"], {
        encoding: "utf8",
      }).trim()
    )
      throw new Error(
        "Commit the owned source checkpoint before a revision-bound runtime operation",
      );
  }
  const docker = (...args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 30000,
    }).trim();
  const config = JSON.parse(
    docker(
      "compose",
      "-f",
      resolve(root, "build/server/docker-compose.selfhost.yml"),
      "config",
      "--format",
      "json",
    ),
  );
  if (config.name !== profile.project)
    throw new Error("Rendered Compose project differs");
  const volumeNames = Object.values(config.volumes ?? {})
    .map((v) => v.name)
    .sort();
  if (
    JSON.stringify(volumeNames) !== JSON.stringify([...profile.volumes].sort())
  )
    throw new Error("Rendered volumes differ from the approved instance");
  const ports = [];
  for (const service of Object.values(config.services)) {
    for (const mount of service.volumes ?? [])
      if (
        mount.type === "bind" &&
        !inside(root, mount.source) &&
        !inside(profile.stateDirectory, mount.source)
      )
        throw new Error("Foreign bind source");
    for (const port of service.ports ?? []) ports.push(String(port.published));
  }
  if (
    JSON.stringify(ports.sort()) !== JSON.stringify([...profile.ports].sort())
  )
    throw new Error("Rendered ports differ from the approved instance");
  const ids = docker(
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${profile.project}`,
  )
    .split("\n")
    .filter(Boolean);
  if (ids.length)
    for (const container of JSON.parse(docker("inspect", ...ids))) {
      const owner =
        container.Config.Labels["com.docker.compose.project.working_dir"];
      if (!owner || !inside(root, owner)) {
        if (
          profile.mode !== "maintenance" ||
          container.State.Running ||
          !profile.previousContainerIds?.includes(container.Id)
        )
          throw new Error(
            "Foreign or running old-checkout instance; takeover refused",
          );
      }
    }
  if (profile.mode === "maintenance") {
    for (const volume of profile.volumes) docker("volume", "inspect", volume);
    for (const key of [
      "MYOXUS_POSTGRES_PASSWORD_FILE",
      "MYOXUS_CRYPTO_PRIVATE_KEY_FILE",
      "MYOXUS_DATA_DIR",
      "MYOXUS_RUNTIME_CONFIG_DIR",
    ])
      if (!existsSync(env[key]))
        throw new Error("Missing preserved runtime input");
    if (!profile.coldRecoveryVerified || !profile.migrationLedgerVerified)
      throw new Error(
        "Maintenance takeover requires verified recovery and database ledger",
      );
  } else {
    for (const volume of profile.volumes) {
      const all = docker("volume", "ls", "-q", "--filter", `name=^${volume}$`);
      if (all && !ids.length)
        throw new Error("Existing unattached volume is not proof of isolation");
    }
  }
} else throw new Error("Expected exports or verify");
