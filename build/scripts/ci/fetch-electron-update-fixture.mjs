// SPDX-License-Identifier: AGPL-3.0-or-later
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const [run, revision, artifactName, destination] = process.argv.slice(2);
if (!/^\d+$/.test(run ?? "") || !/^[a-f0-9]{40}$/.test(revision ?? ""))
  throw new Error("Exact fixture run/source required");
const origin = "https://git.blume29.de";
const base = `${origin}/api/v1/repos/myoxus/myoxus`;
const token = process.env.ARTIFACT_TOKEN;
if (!token) throw new Error("ARTIFACT_TOKEN is required");
const headers = { Authorization: `token ${token}` };
async function api(url) {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Fixture API ${response.status}`);
  return response.json();
}

// Test-driver corrections may replay original bytes. Product/native inputs may
// not silently change, and the retained package source stays in its evidence.
const source = await api(`${base}/actions/runs/${run}`);
if (
  source.commit_sha !== revision ||
  source.workflow_id !== "electron-packaging.yml"
)
  throw new Error("Fixture source run differs");
execFileSync(
  "git",
  [
    "diff",
    "--exit-code",
    revision,
    "HEAD",
    "--",
    "client/apps/electron",
    "client/apps/electron-renderer",
    "client/libs/desktop-api-contract",
    "client/libs/crypto",
    "client/libs/local-store",
    "client/libs/media-capture",
    "client/libs/icons",
    "client/branding",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    ".cargo",
  ],
  { stdio: "inherit" },
);
const jobs = await api(`${base}/actions/runs/${run}/jobs`);
if (
  !jobs.some(
    (job) =>
      job.name === "Electron source and dependency contracts" &&
      job.status === "success",
  )
)
  throw new Error("Original source/native-unit contracts did not pass");
const identity = artifactName?.match(
  /^electron-update-(native|macos-homebrew|linux-flatpak|windows-(?:nsis|zip))-(stable|beta|internal)$/,
);
if (!identity || !destination)
  throw new Error("Unsupported update fixture artifact");
if (
  identity[1] === "native" &&
  !jobs.some(
    (job) =>
      job.name === `Build Linux native ${identity[2]} N/N+1 fixtures` &&
      job.status === "success",
  )
)
  throw new Error("Original native fixture build did not pass");
if (
  identity[1].startsWith("windows-") &&
  !jobs.some(
    (job) =>
      job.name === `Windows ${identity[1].slice(8)} ${identity[2]} N/N+1`,
  )
)
  throw new Error("Original Windows fixture owner is missing");
const artifacts = await api(`${base}/actions/runs/${run}/artifacts`);
const matching = artifacts.filter(
  (artifact) => artifact.name === artifactName && !artifact.expired,
);
if (matching.length !== 1)
  throw new Error("Expected one retained channel fixture");
const url = new URL(matching[0].archive_download_url);
if (url.origin !== origin) throw new Error("Foreign fixture origin");
let response = await fetch(url, {
  headers,
  redirect: "manual",
  signal: AbortSignal.timeout(600000),
});
if ([301, 302, 303, 307, 308].includes(response.status)) {
  const target = new URL(response.headers.get("location"), url);
  if (target.protocol !== "https:") throw new Error("Unsafe fixture redirect");
  // Object-storage redirects must never receive the repository credential.
  response = await fetch(target, {
    redirect: "error",
    signal: AbortSignal.timeout(600000),
  });
}
if (!response.ok) throw new Error(`Fixture download ${response.status}`);
await mkdir(destination);
const archive = `${destination}.zip`;
try {
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(archive, { flags: "wx" }),
  );
  execFileSync(
    process.platform === "win32"
      ? "powershell"
      : process.platform === "darwin"
        ? "ditto"
        : "unzip",
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:MYOXUS_FIXTURE_ARCHIVE -DestinationPath $env:MYOXUS_FIXTURE_DESTINATION -Force",
        ]
      : process.platform === "darwin"
        ? ["-x", "-k", archive, destination]
        : ["-q", archive, "-d", destination],
    {
      stdio: "inherit",
      timeout: 600_000,
      env: {
        ...process.env,
        MYOXUS_FIXTURE_ARCHIVE: archive,
        MYOXUS_FIXTURE_DESTINATION: destination,
      },
    },
  );
} finally {
  await rm(archive, { force: true });
}
let evidenceRoot = destination;
if (identity[1] === "native") {
  const manifests = [];
  const pending = [destination];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.name === "fixture-build.json") manifests.push(file);
    }
  }
  if (manifests.length !== 1)
    throw new Error("Expected one native fixture manifest");
  evidenceRoot = path.dirname(manifests[0]);
}
await writeFile(
  path.join(evidenceRoot, "fixture-source.json"),
  JSON.stringify({ revision, run, artifact: matching[0].id }),
);
await appendFile(
  process.env.GITHUB_ENV,
  `MYOXUS_UPDATE_E2E_REUSE_DIR=${evidenceRoot}\nMYOXUS_UPDATE_E2E_DOWNLOAD_ROOT=${destination}\n`,
);
console.log(
  `Reusing ${artifactName}: source ${revision}, run ${run}, artifact ${matching[0].id}`,
);
