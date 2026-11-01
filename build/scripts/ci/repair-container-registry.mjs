#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CANONICAL_OWNER = "myoxus";
const CANONICAL_IMAGES = new Set([
  "myoxus",
  "myoxus-web-frontend",
  "myoxus-admin-frontend",
]);
const PSEUDO_VERSION = /^sha256:[0-9a-f]{64}$/;
const HOST =
  /^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$/;

export function selectRepairCandidates(inventory) {
  const containerRows = inventory.filter((entry) => entry.type === "container");
  const unexpectedPackages = [
    ...new Set(
      containerRows
        .map((entry) => entry.name)
        .filter((name) => !CANONICAL_IMAGES.has(name)),
    ),
  ];
  if (unexpectedPackages.length) {
    throw new Error(
      `Refusing broad cleanup with unexpected packages: ${unexpectedPackages.join(", ")}`,
    );
  }
  return containerRows.filter(
    (entry) =>
      CANONICAL_IMAGES.has(entry.name) && PSEUDO_VERSION.test(entry.version),
  );
}

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function forgejoRequest(url, init = {}) {
  const user = process.env.REGISTRY_USER;
  const password = process.env.REGISTRY_PASSWORD;
  if (!user || !password) {
    throw new Error(
      "Registry repair requires REGISTRY_USER and REGISTRY_PASSWORD",
    );
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
      ...init.headers,
    },
  });
  if (!response.ok && response.status !== 204) {
    throw new Error(
      `Forgejo package request failed with HTTP ${response.status}`,
    );
  }
  return response;
}

async function main() {
  const registryHost = value("--registry-host") ?? "";
  const owner = value("--owner") ?? "";
  const evidencePath = value("--evidence");
  if (owner !== CANONICAL_OWNER || !HOST.test(registryHost)) {
    throw new Error(
      "Registry repair is restricted to the canonical myoxus owner and host-only registry",
    );
  }
  if (!evidencePath) throw new Error("--evidence is required");
  if (process.env.CONFIRM_REGISTRY_REPAIR !== "remove-sha256-pseudo-versions") {
    throw new Error(
      "Registry repair requires the exact CONFIRM_REGISTRY_REPAIR value",
    );
  }

  async function inventory() {
    const entries = [];
    for (let page = 1; ; page += 1) {
      const response = await forgejoRequest(
        `https://${registryHost}/api/v1/packages/${owner}?type=container&limit=100&page=${page}`,
      );
      const current = await response.json();
      if (!Array.isArray(current)) {
        throw new Error("Forgejo package inventory page is not an array");
      }
      entries.push(...current);
      if (current.length < 100) return entries;
    }
  }
  const currentInventory = await inventory();
  const candidates = selectRepairCandidates(currentInventory);
  for (const entry of candidates) {
    const url = `https://${registryHost}/api/v1/packages/${owner}/container/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await forgejoRequest(url, { method: "DELETE" });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const current = await inventory();
        const stillPresent = selectRepairCandidates(current).some(
          (candidate) =>
            candidate.name === entry.name &&
            candidate.version === entry.version,
        );
        if (!stillPresent) {
          lastError = undefined;
          break;
        }
        if (attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
        }
      }
    }
    if (lastError) {
      throw new Error(
        `Could not remove ${entry.name}:${entry.version} after bounded retries: ${lastError instanceof Error ? lastError.message : lastError}`,
      );
    }
  }

  const remaining = await inventory();
  const remainingPseudo = selectRepairCandidates(remaining);
  if (remainingPseudo.length) {
    throw new Error(
      "Forgejo still exposes sha256 pseudo-versions after cleanup",
    );
  }

  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        registryHost,
        owner,
        removed: candidates.map(({ id, name, version }) => ({
          id,
          name,
          version,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[PASS] removed ${candidates.length} sha256 pseudo-version(s)`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[FAIL] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
