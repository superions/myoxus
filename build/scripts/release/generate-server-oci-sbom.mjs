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
for (const name of [
  "--cargo-sbom",
  "--os-packages",
  "--image-inspect",
  "--output",
  "--revision",
]) {
  if (!args.get(name)) throw new Error(`Missing ${name}`);
}

const cargoBom = JSON.parse(await readFile(args.get("--cargo-sbom"), "utf8"));
const [image] = JSON.parse(await readFile(args.get("--image-inspect"), "utf8"));
if (!image) throw new Error("Docker image inspection is empty");

const repoDigest = (image.RepoDigests ?? []).find((value) =>
  value.includes("@sha256:"),
);
const digest = repoDigest?.split("@").at(-1) ?? image.Id;
if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
  throw new Error("Image has no immutable SHA-256 identity");
}
const requireRegistryDigest = args.get("--require-registry-digest") === "true";
if (requireRegistryDigest && !repoDigest) {
  throw new Error("Published server image has no registry manifest digest");
}

const labels = image.Config?.Labels ?? {};
const revision = args.get("--revision");
if (labels["org.opencontainers.image.revision"] !== revision) {
  throw new Error("Image revision label does not match requested revision");
}

const osComponents = (await readFile(args.get("--os-packages"), "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, version, arch] = line.split("\t");
    if (!name || !version || !arch)
      throw new Error(`Invalid dpkg row: ${line}`);
    const bomRef = `pkg:deb/debian/${encodeURIComponent(name)}@${encodeURIComponent(version)}?arch=${encodeURIComponent(arch)}`;
    return {
      type: "library",
      name,
      version,
      "bom-ref": bomRef,
      purl: bomRef,
      properties: [{ name: "myoxus:package-layer", value: "debian-runtime" }],
    };
  })
  .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));

const version = labels["org.opencontainers.image.version"];
if (!version) throw new Error("Image version label is missing");
const rootRef = `urn:oci:${digest}`;
const cargoRoot = cargoBom.metadata?.component;
const components = [cargoRoot, ...(cargoBom.components ?? []), ...osComponents]
  .filter(Boolean)
  .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));
const uuidHex = createHash("sha256")
  .update(`myoxus-server-oci\0${digest}`)
  .digest("hex")
  .slice(0, 32);
const uuid = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-5${uuidHex.slice(13, 16)}-a${uuidHex.slice(17, 20)}-${uuidHex.slice(20)}`;

const output = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${uuid}`,
  version: 1,
  metadata: {
    timestamp: cargoBom.metadata.timestamp,
    tools: cargoBom.metadata.tools,
    component: {
      type: "container",
      name: "myoxus-server-oci",
      version,
      "bom-ref": rootRef,
      hashes: [{ alg: "SHA-256", content: digest.slice(7) }],
      properties: [
        { name: "myoxus:git-revision", value: revision },
        { name: "myoxus:sbom-scope", value: "final-oci-filesystem" },
        {
          name: "myoxus:oci-digest-kind",
          value: repoDigest ? "registry-manifest" : "local-image",
        },
        { name: "myoxus:oci-digest", value: digest },
      ],
    },
  },
  components,
  dependencies: [
    {
      ref: rootRef,
      dependsOn: [
        cargoRoot?.["bom-ref"],
        ...osComponents.map((component) => component["bom-ref"]),
      ]
        .filter(Boolean)
        .sort(),
    },
    ...(cargoBom.dependencies ?? []),
  ],
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
