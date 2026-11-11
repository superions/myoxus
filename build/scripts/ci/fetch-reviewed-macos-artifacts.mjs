// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { execFileSync } from "node:child_process";

const [number, revision, version, output] = process.argv.slice(2);
if (
  !/^\d+$/.test(number ?? "") ||
  !/^[a-f0-9]{40}$/.test(revision ?? "") ||
  !/^\d+\.\d+\.\d+$/.test(version ?? "") ||
  !output
)
  throw new Error(
    "Require reviewed packaging run, full source revision, stable version and new output directory",
  );
const api = "https://git.blume29.de/api/v1/repos/myoxus/myoxus";
const headers = {
  Authorization: `token ${process.env.FORGEJO_RELEASE_READ_TOKEN}`,
};
async function get(relative) {
  const response = await fetch(`${api}${relative}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`Producer read failed: HTTP ${response.status}`);
  return response.json();
}
const listing = await get(`/actions/runs?run_number=${number}&limit=1`);
const run = listing.workflow_runs?.[0];
if (
  run?.index_in_repo !== Number(number) ||
  run.commit_sha !== revision ||
  run.status !== "success" ||
  run.workflow_id !== "electron-packaging.yml"
)
  throw new Error(
    "Producer is not the successful reviewed Electron packaging run/source",
  );
const jobs = await get(`/actions/runs/${run.id}/jobs`);
for (const name of [
  "Electron source and dependency contracts",
  "macOS arm64 application, DMG and ZIP",
  "macOS x64 application, DMG and ZIP",
])
  if (
    jobs.filter((j) => j.name === name && j.status === "success").length !== 1
  )
    throw new Error(`Producer gate is missing: ${name}`);
const artifacts = await get(`/actions/runs/${run.id}/artifacts`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output, { recursive: false });
const receipt = {
  sourceCommit: revision,
  version,
  producer: run.html_url,
  runId: run.id,
  artifacts: [],
};
for (const arch of ["arm64", "x64"]) {
  const matches = artifacts.filter(
    (a) => a.name === `electron-packaging-macos-${arch}`,
  );
  const artifact = matches[0];
  if (
    matches.length !== 1 ||
    artifact.expired ||
    artifact.run_id !== run.id ||
    artifact.archive_download_url !==
      `${api}/actions/artifacts/${artifact.id}/zip`
  )
    throw new Error(`Missing retained ${arch} artifact from this producer`);
  const archive = path.join(output, `${arch}.zip`);
  const response = await fetch(artifact.archive_download_url, {
    headers,
    signal: AbortSignal.timeout(900000),
  });
  if (!response.ok)
    throw new Error(`Artifact download HTTP ${response.status}`);
  const sha = createHash("sha256");
  let size = 0;
  await pipeline(
    response.body,
    new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        sha.update(chunk);
        if (size > artifact.size_in_bytes)
          callback(new Error("Artifact exceeds producer size"));
        else callback(null, chunk);
      },
    }),
    fs.createWriteStream(archive, { flags: "wx" }),
  );
  if (size !== artifact.size_in_bytes)
    throw new Error("Artifact differs from producer size");
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  const expected = ["dmg", "zip"]
    .map((ext) => `myoxus-${version}-stable-macos-${arch}.${ext}`)
    .sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected))
    throw new Error("Producer artifact has a different package inventory");
  const directory = path.join(output, arch);
  fs.mkdirSync(directory);
  execFileSync("unzip", ["-q", archive, "-d", directory]);
  for (const name of expected)
    if (!fs.lstatSync(path.join(directory, name)).isFile())
      throw new Error("Package is not a regular file");
  receipt.artifacts.push({
    id: artifact.id,
    name: artifact.name,
    size,
    sha256: sha.digest("hex"),
    packages: expected,
  });
}
fs.writeFileSync(
  path.join(output, "producer-receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(
  `Reused both architectures from successful packaging run ${number}; no product build`,
);
