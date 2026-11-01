#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  applySourceToSbom,
  readSourceProvenance,
} from "./source-correspondence.mjs";
import { readFile, writeFile } from "node:fs/promises";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const required = [
  "--api",
  "--cli",
  "--output",
  "--revision",
  "--version",
  "--epoch",
];
for (const name of required) {
  if (!args.get(name)) {
    throw new Error(`Missing required argument ${name}`);
  }
}

const revision = args.get("--revision");
if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revision)) {
  throw new Error(
    "--revision must be a full 40- or 64-character lowercase hex revision",
  );
}

const epoch = Number(args.get("--epoch"));
if (!Number.isSafeInteger(epoch) || epoch < 0) {
  throw new Error("--epoch must be a non-negative integer");
}

const documents = await Promise.all(
  [args.get("--api"), args.get("--cli")].map(async (path) =>
    JSON.parse(await readFile(path, "utf8")),
  ),
);

function canonicalizeWorkspaceReferences(value) {
  if (Array.isArray(value)) return value.map(canonicalizeWorkspaceReferences);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        canonicalizeWorkspaceReferences(child),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (value.startsWith("path+file://")) {
    const fragment = value.split("#").at(-1);
    return `urn:myoxus:cargo-workspace:${encodeURIComponent(fragment)}`;
  }
  if (
    value.startsWith("pkg:cargo/") &&
    value.includes("?download_url=file://")
  ) {
    const [base] = value.split("?download_url=");
    const fragment = value.includes("#") ? `#${value.split("#").at(-1)}` : "";
    return `${base}${fragment}`;
  }
  return value;
}

for (let index = 0; index < documents.length; index += 1) {
  documents[index] = canonicalizeWorkspaceReferences(documents[index]);
}
const [api] = documents;
for (const document of documents) {
  if (document.bomFormat !== "CycloneDX" || document.specVersion !== "1.5") {
    throw new Error("cargo-cyclonedx output is not CycloneDX 1.5");
  }
}

const componentByRef = new Map();
const dependencyByRef = new Map();
for (const document of documents) {
  const root = document.metadata?.component;
  if (root?.["bom-ref"]) componentByRef.set(root["bom-ref"], root);
  for (const component of document.components ?? []) {
    if (component["bom-ref"])
      componentByRef.set(component["bom-ref"], component);
  }
  for (const dependency of document.dependencies ?? []) {
    const existing = dependencyByRef.get(dependency.ref) ?? new Set();
    for (const child of dependency.dependsOn ?? []) existing.add(child);
    dependencyByRef.set(dependency.ref, existing);
  }
}

const rootRef = `pkg:cargo/myoxus-server@${encodeURIComponent(args.get("--version"))}`;
const binaryRefs = documents
  .map((document) => document.metadata?.component?.["bom-ref"])
  .filter(Boolean)
  .sort();
dependencyByRef.set(rootRef, new Set(binaryRefs));

const uuidHex = createHash("sha256")
  .update(`myoxus-server\0${revision}\0${args.get("--version")}`)
  .digest("hex")
  .slice(0, 32);
const uuid = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-5${uuidHex.slice(13, 16)}-a${uuidHex.slice(17, 20)}-${uuidHex.slice(20)}`;

const output = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${uuid}`,
  version: 1,
  metadata: {
    timestamp: new Date(epoch * 1000).toISOString(),
    tools: api.metadata?.tools,
    component: {
      type: "application",
      name: "myoxus-server",
      version: args.get("--version"),
      "bom-ref": rootRef,
      licenses: [{ license: { id: "AGPL-3.0-or-later" } }],
      properties: [
        { name: "myoxus:git-revision", value: revision },
        { name: "myoxus:sbom-scope", value: "cargo-application" },
      ],
    },
  },
  components: [...componentByRef.values()].sort((left, right) =>
    left["bom-ref"].localeCompare(right["bom-ref"]),
  ),
  dependencies: [...dependencyByRef.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() })),
};

applySourceToSbom(
  output,
  revision,
  readSourceProvenance(
    args.get("--source-provenance") ?? process.env.MYOXUS_SOURCE_PROVENANCE,
    revision,
  ),
);

await writeFile(args.get("--output"), `${JSON.stringify(output, null, 2)}\n`);
