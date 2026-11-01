#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CANONICAL_OWNER = "myoxus";
const CANONICAL_IMAGES = [
  "myoxus",
  "myoxus-web-frontend",
  "myoxus-admin-frontend",
];
const HOST =
  /^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$/;
const SHA = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    args.set(key, value);
  }
  return args;
}

export function validateRegistryTarget({ registryHost, owner, images }) {
  if (!HOST.test(registryHost)) {
    throw new Error("Registry host must not contain a scheme or path");
  }
  if (owner !== CANONICAL_OWNER) {
    throw new Error(`Registry owner must be ${CANONICAL_OWNER}`);
  }
  const sorted = [...new Set(images)].sort();
  const expected = [...CANONICAL_IMAGES].sort();
  if (sorted.some((name) => name.includes("/"))) {
    throw new Error("Nested container package names are forbidden");
  }
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    throw new Error(
      `Registry packages must be exactly ${expected.join(", ")}; found ${sorted.join(", ") || "none"}`,
    );
  }
}

async function readInventory({ registryHost, owner, inventoryFile }) {
  if (inventoryFile) {
    return JSON.parse(readFileSync(inventoryFile, "utf8"));
  }
  const inventory = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://${registryHost}/api/v1/packages/${owner}?type=container&limit=100&page=${page}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(
        `Forgejo package inventory failed with HTTP ${response.status}`,
      );
    }
    const entries = await response.json();
    if (!Array.isArray(entries)) {
      throw new Error("Forgejo package inventory page is not an array");
    }
    inventory.push(...entries);
    if (entries.length < 100) break;
  }
  return inventory;
}

function imageDigest(reference) {
  const digest = execFileSync(
    "docker",
    [
      "buildx",
      "imagetools",
      "inspect",
      "--format",
      "{{json .Manifest.Digest}}",
      reference,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .trim()
    .replaceAll('"', "");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Registry reference has no OCI digest: ${reference}`);
  }
  return digest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryHost = args.get("--registry-host") ?? "";
  const owner = args.get("--owner") ?? "";
  const commit = args.get("--commit");
  const promotionTag = args.get("--promotion-tag");
  const selectedImages = (args.get("--images") ?? CANONICAL_IMAGES.join(","))
    .split(",")
    .filter(Boolean);
  const stage = args.get("--stage") ?? "inventory";
  const evidencePath = args.get("--evidence");
  if (!evidencePath) throw new Error("--evidence is required");
  if (!new Set(["inventory", "commit", "promoted"]).has(stage)) {
    throw new Error("--stage must be inventory, commit, or promoted");
  }
  if (stage !== "inventory" && (!commit || !SHA.test(commit))) {
    throw new Error("Commit verification requires a full 40-character SHA");
  }
  if (stage === "promoted" && !promotionTag) {
    throw new Error("Promoted verification requires --promotion-tag");
  }

  const inventory = await readInventory({
    registryHost,
    owner,
    inventoryFile: args.get("--inventory-file"),
  });
  if (!Array.isArray(inventory)) {
    throw new Error("Forgejo package inventory is not an array");
  }
  const containerRows = inventory.filter((entry) => entry.type === "container");
  const packageNames = [...new Set(containerRows.map((entry) => entry.name))];
  validateRegistryTarget({ registryHost, owner, images: packageNames });
  if (
    selectedImages.length === 0 ||
    selectedImages.some((image) => !CANONICAL_IMAGES.includes(image))
  ) {
    throw new Error("--images contains an unsupported container package");
  }

  const packages = selectedImages.map((image) => {
    const versions = containerRows
      .filter((entry) => entry.name === image)
      .map((entry) => entry.version);
    if (stage !== "inventory" && !versions.includes(commit)) {
      throw new Error(`${image} does not expose accepted commit tag ${commit}`);
    }
    if (stage === "promoted" && !versions.includes(promotionTag)) {
      throw new Error(`${image} does not expose promotion tag ${promotionTag}`);
    }
    const commitReference = `${registryHost}/${owner}/${image}:${commit}`;
    const promotionReference = `${registryHost}/${owner}/${image}:${promotionTag}`;
    const commitDigest =
      stage === "inventory" ? null : imageDigest(commitReference);
    const promotionDigest =
      stage === "promoted" ? imageDigest(promotionReference) : null;
    if (stage === "promoted" && promotionDigest !== commitDigest) {
      throw new Error(
        `${image} commit and promotion tags have different digests`,
      );
    }
    return {
      image,
      commitTag: stage === "inventory" ? null : commit,
      promotionTag: stage === "promoted" ? promotionTag : null,
      commitDigest,
      promotionDigest,
      pseudoVersions: versions.filter((version) =>
        /^sha256:[0-9a-f]{64}$/.test(version),
      ),
    };
  });

  const evidence = {
    schemaVersion: 1,
    registryHost,
    owner,
    stage,
    packages,
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[PASS] canonical registry contract verified (${stage})`);
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
