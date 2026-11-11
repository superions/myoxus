// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readSourceProvenance } from "./source-correspondence.mjs";

const [version, output] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !output)
  throw new Error("Expected version and output JSON");
const notes = process.env.RELEASE_NOTES;
if (!notes?.trim()) throw new Error("Explicit release notes are required");
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...options });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
if (process.env.RELEASE_SCOPE === "desktop" && !process.env.DESKTOP_RELEASE_TAG)
  throw new Error(
    "Desktop publication requires its explicit existing platform tag",
  );
if (process.env.RELEASE_SCOPE === "release" && process.env.DESKTOP_RELEASE_TAG)
  throw new Error("Container publication must not select a desktop tag");
if (process.env.DESKTOP_RELEASE_TAG) {
  // Desktop publication consumes its own immutable platform release. It never
  // invokes container verification, tags, builds or source selection below.
  const tag = process.env.DESKTOP_RELEASE_TAG;
  if (
    !new RegExp(
      `^(?:macos-client|linux-client|windows-client|desktop)-v${version.replaceAll(".", "\\.")}$`,
    ).test(tag)
  )
    throw new Error("Desktop tag must match the selected platform/version");
  const base =
    "https://git.blume29.de/myoxus/packages/releases/download/" + tag;
  const read = async (name) => {
    const response = await fetch(`${base}/${name}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`Published desktop metadata HTTP ${response.status}`);
    return response.text();
  };
  const manifest = JSON.parse(await read("desktop-release.json"));
  if (manifest.version !== version || !manifest.publishable)
    throw new Error("Desktop release is not admitted");
  const sums = await read("SHA256SUMS");
  const assets = [];
  const names = new Set();
  for (const line of sums.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64}) [ *](.+)$/);
    if (!match) throw new Error("Malformed desktop checksums");
    const name = path.basename(match[2]);
    if (names.has(name)) throw new Error("Duplicate desktop asset basename");
    names.add(name);
    const kind =
      name === "desktop-provenance.json"
        ? "provenance"
        : name.endsWith(".cdx.json")
          ? "sbom"
          : name === "legal-notices.tar.gz"
            ? "legal"
            : /\.(dmg|zip|exe|deb|rpm|flatpak)$/.test(name)
              ? "desktop-package"
              : name === "latest.yml"
                ? "update-metadata"
                : "notice";
    assets.push({
      name,
      kind,
      url: `${base}/${encodeURIComponent(name)}`,
      sha256: match[1],
    });
  }
  assets.push({
    name: "SHA256SUMS",
    kind: "checksums",
    url: `${base}/SHA256SUMS`,
    sha256: sha(sums),
    size: Buffer.byteLength(sums),
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        scope: "desktop",
        version,
        tag,
        prerelease: manifest.channel !== "stable",
        notes,
        assets,
      },
      null,
      2,
    ) + "\n",
  );
  const correspondence = `https://git.blume29.de/api/packages/myoxus/generic/myoxus-source/${version}-${manifest.sourceCommit}/source-correspondence.json`;
  const response = await fetch(correspondence, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`Desktop source correspondence HTTP ${response.status}`);
  const sourceFile = path.join(
    path.dirname(output),
    "source-correspondence.json",
  );
  fs.writeFileSync(sourceFile, await response.text());
  readSourceProvenance(sourceFile, manifest.sourceCommit);
  console.log(
    `Prepared desktop allowlist from ${tag}; no container operation or product build`,
  );
  process.exit(0);
}
run("git", [
  "fetch",
  "--depth=1",
  "origin",
  `refs/tags/server-v${version}:refs/tags/server-v${version}`,
  `refs/tags/frontends-v${version}:refs/tags/frontends-v${version}`,
]);
const revision = run("git", ["rev-parse", `server-v${version}^{}`]).trim();
const frontendRevision = run("git", [
  "rev-parse",
  `frontends-v${version}^{}`,
]).trim();
if (frontendRevision !== revision) {
  // A server-recipe repair must not rebuild or relabel accepted frontends.
  // Fail closed if anything outside that recipe differs between the sources.
  try {
    run("git", [
      "diff",
      "--quiet",
      frontendRevision,
      revision,
      "--",
      ".",
      ":(exclude)build/server/Dockerfile",
    ]);
  } catch {
    throw new Error(
      "Server/frontend sources differ outside the server build recipe",
    );
  }
}
// The existing acceptance/registry verifier owns publication. This copy only
// consumes its result; no compilation, packaging or new qualification suite.
const verifiedRegistry = run("bash", [
  "build/scripts/release/release-containers.sh",
  "verify",
  version,
]);
process.stdout.write(verifiedRegistry);
const root = path.join(
  process.env.CI_RUNNER_CACHE ?? "/var/cache/ci-runner",
  "artifacts",
  process.env.GITHUB_REPOSITORY,
);
const sourceRoot = path.join(root, "public-source", revision);
const sourceReport = path.join(sourceRoot, "source-correspondence.json");
const publicSource = readSourceProvenance(sourceReport, revision);
const frontendPublicSource = readSourceProvenance(
  path.join(
    root,
    "public-source",
    frontendRevision,
    "source-correspondence.json",
  ),
  frontendRevision,
);
const select = (kind, required, sourceRevision = revision) => {
  const dir = path.join(root, kind);
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(`-${sourceRevision}`))
    .sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]));
  const selected = names
    .map((n) => path.join(dir, n))
    .find((d) => fs.existsSync(path.join(d, required)));
  if (!selected)
    throw new Error(`Missing accepted ${kind} for ${sourceRevision}`);
  return selected;
};
const registry = select("container-registry", "server-promoted.json");
const frontendRegistry = select(
  "container-registry",
  "frontends-promoted.json",
  frontendRevision,
);
const receipts = [
  json(path.join(registry, "server-promoted.json")),
  json(path.join(frontendRegistry, "frontends-promoted.json")),
];
const containers = [];
for (const [role, image, kind] of [
  ["server", "myoxus", "server"],
  ["web", "myoxus-web-frontend", "web-frontend"],
  ["admin", "myoxus-admin-frontend", "admin-frontend"],
]) {
  const sourceRevision = role === "server" ? revision : frontendRevision;
  const dir = select(
    `${kind}-container-provenance`,
    `${role}-image-inspect.json`,
    sourceRevision,
  );
  run("bash", ["build/scripts/ci/verify-sha256sums.sh", dir], {
    stdio: "inherit",
  });
  run(
    "node",
    [
      "build/scripts/ci/verify-container-build-evidence.mjs",
      "--evidence-dir",
      dir,
      "--role",
      role,
      "--revision",
      sourceRevision,
      "--version",
      version,
      "--publish-mode",
      "true",
    ],
    { stdio: "inherit" },
  );
  const inspection = json(path.join(dir, `${role}-image-inspect.json`));
  const imageData = Array.isArray(inspection) ? inspection[0] : inspection;
  const promoted = receipts
    .flatMap((r) => r.packages ?? [])
    .find((p) => p.image === image && p.promotionTag === version);
  if (!/^sha256:[0-9a-f]{64}$/.test(promoted?.promotionDigest ?? ""))
    throw new Error(`No matching promotion receipt for ${image}`);
  const coordinate = `git.blume29.de/myoxus/${image}@${promoted.promotionDigest}`;
  if (
    !verifiedRegistry
      .split("\n")
      .some(
        (line) =>
          line.includes(`git.blume29.de/myoxus/${image}:${version} `) &&
          line.trim().endsWith(promoted.promotionDigest),
      )
  )
    throw new Error(
      `Promotion receipt differs from the verified registry: ${image}`,
    );
  const recorded = (imageData.RepoDigests ?? []).filter((d) =>
    d.startsWith(`git.blume29.de/myoxus/${image}@`),
  );
  if (recorded.length && !recorded.includes(coordinate))
    throw new Error(`Image inspection and promotion differ for ${image}`);
  containers.push({ role, coordinate, directory: dir });
}
fs.mkdirSync(path.dirname(output), { recursive: true });
const work = fs.mkdtempSync(
  path.join(path.dirname(output), "github-metadata-"),
);
const originals = [];
const add = (name, file, kind) => originals.push({ name, file, kind });
const server = containers.find((c) => c.role === "server");
run("docker", ["pull", server.coordinate], { stdio: "inherit" });
const holder = run("docker", [
  "create",
  server.coordinate,
  "/__myoxus_legal_inspection__",
]).trim();
try {
  run("docker", [
    "cp",
    `${holder}:/usr/share/doc/myoxus-server`,
    path.join(work, "server-legal"),
  ]);
} finally {
  run("docker", ["rm", holder]);
}
const legal = path.join(work, "server-legal");
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
for (const file of walk(legal)) {
  let name = "server-" + path.relative(legal, file).replaceAll(path.sep, "-");
  if (name.length > 100)
    name =
      "server-" + sha(name).slice(0, 16) + "-" + path.basename(file).slice(-65);
  add(name, file, file.endsWith(".cdx.json") ? "sbom" : "legal");
}
for (const c of containers)
  add(
    `${c.role}-oci.cdx.json`,
    path.join(
      c.directory,
      c.role === "server" ? "server-oci.cdx.json" : "frontend.cdx.json",
    ),
    "sbom",
  );
for (const file of [
  "LICENSE",
  "client/REUSE.toml",
  "client/provenance/components.json",
  "client/provenance/LICENSE-UPSTREAM-MIT.txt",
  "virgultum/provenance/licenses.json",
])
  add(
    "source-" + file.replaceAll("/", "-"),
    path.join(sourceRoot, "snapshot", file),
    "legal",
  );
const provenance = path.join(work, "release-provenance.json");
const identities = Object.fromEntries(
  fs
    .readFileSync(path.join(sourceRoot, "candidate-identities.txt"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("=")),
);
fs.writeFileSync(
  provenance,
  JSON.stringify(
    {
      schemaVersion: 1,
      revision,
      publicSource,
      componentSources: {
        server: { revision, publicSource },
        frontends: {
          revision: frontendRevision,
          publicSource: frontendPublicSource,
        },
      },
      sourceQualification: {
        producer: "publish-github-mirror.sh",
        archiveSha256: identities.archive_sha256,
        manifestSha256: identities.manifest_sha256,
      },
      producerReceipts: receipts,
      boundaries: [
        { id: "server", status: "ready", coordinate: server.coordinate },
        {
          id: "frontends",
          status: "ready",
          coordinates: containers
            .filter((c) => c.role !== "server")
            .map((c) => c.coordinate),
        },
      ],
      summary: {
        inReleaseReady: ["server", "frontends"],
        inReleaseBlocked: [],
      },
    },
    null,
    2,
  ) + "\n",
);
add("release-provenance.json", provenance, "provenance");
const assets = [];
const token = process.env.FORGEJO_RELEASE_READ_TOKEN;
if (!token) throw new Error("Forgejo package credential is required");
const authorization =
  process.env.FORGEJO_PACKAGE_USER && process.env.FORGEJO_PACKAGE_PASSWORD
    ? "Basic " +
      Buffer.from(
        process.env.FORGEJO_PACKAGE_USER +
          ":" +
          process.env.FORGEJO_PACKAGE_PASSWORD,
      ).toString("base64")
    : `token ${token}`;
for (const a of originals) {
  const bytes = fs.readFileSync(a.file);
  const url = `https://git.blume29.de/api/packages/myoxus/generic/myoxus-github-release/${version}-${revision}/${a.name}`;
  let response = await fetch(url, {
    headers: { Authorization: authorization },
  });
  if (response.status === 404) {
    response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: authorization },
      body: bytes,
    });
    if (!response.ok)
      throw new Error(`Cannot retain ${a.name}: ${response.status}`);
    response = await fetch(url);
  }
  if (
    !response.ok ||
    sha(Buffer.from(await response.arrayBuffer())) !== sha(bytes)
  )
    throw new Error(`Retained bytes differ: ${a.name}`);
  assets.push({
    name: a.name,
    url,
    sha256: sha(bytes),
    size: bytes.length,
    kind: a.kind,
  });
}
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      version,
      tag: `v${version}`,
      scope: "selfhost",
      prerelease: true,
      notes,
      containers: containers.map(({ role, coordinate }) => ({
        role,
        coordinate,
      })),
      assets,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Prepared exact release input for ${version}; no build or package modification.`,
);
