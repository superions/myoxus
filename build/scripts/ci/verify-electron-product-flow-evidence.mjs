#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_ONLY_SCHEMA,
  validateBuildOnlyEvidence,
} from "./macos-build-only-evidence.mjs";

const CONTRACT = ["D-ER-C-03", "D-ER-C-04", "D-ER-C-05", "QG-ER-5"];
const PRODUCT_FLOW_SCHEMA = "myoxus.electron-product-flow.v1";
const RELEASE_CELL_SCHEMA = "myoxus.desktop-release-cell.v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+[.]\d+[.]\d+(?:-[0-9A-Za-z.-]+)?$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PUBLISHABLE_TUPLES = new Set([
  "linux/x64/deb",
  "linux/x64/flatpak",
  "linux/x64/rpm",
  "macos/arm64/dmg",
  "macos/arm64/zip",
  "macos/x64/dmg",
  "macos/x64/zip",
  "windows/x64/nsis",
  "windows/x64/zip",
]);

function fail(message) {
  throw new Error(
    `Invalid packaged Electron product-flow evidence: ${message}`,
  );
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function requireExactKeys(value, keys, label) {
  const object = requireObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return object;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a nonempty string`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function requireTrue(value, label) {
  if (value !== true) fail(`${label} must be true`);
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value)) fail(`${label} must be an integer`);
  return value;
}

function requireArray(value, label, { nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    fail(`${label} must be ${nonempty ? "a nonempty" : "an"} array`);
  }
  return value;
}

function requireEmptyArray(value, label) {
  const array = requireArray(value, label);
  if (array.length !== 0) fail(`${label} must be empty`);
  return array;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireUrl(value, label) {
  requireString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be an absolute URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    fail(`${label} must use http or https`);
  }
  if (url.username || url.password)
    fail(`${label} must not contain credentials`);
  return url;
}

function requireReleaseBaseUrl(value, label) {
  const url = requireUrl(value, label);
  if (url.protocol !== "https:") fail(`${label} must use https`);
  if (url.pathname !== "/" || url.search || url.hash) {
    fail(`${label} must be a root base URL without query or fragment`);
  }
  return url;
}

function requireRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist: ${file}`);
    fail(`${label} cannot be inspected: ${file}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file: ${file}`);
  }
  return stat;
}

function readJson(file, label) {
  requireRegularFile(file, label);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function findReleaseCell(evidenceFile) {
  let directory = path.dirname(evidenceFile);
  while (true) {
    const candidate = path.join(directory, "cell.json");
    if (fs.existsSync(candidate)) {
      return {
        cell: requireObject(
          readJson(candidate, "release cell"),
          "release cell",
        ),
        directory,
        file: candidate,
      };
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      fail(`${evidenceFile} has no ancestor cell.json`);
    }
    directory = parent;
  }
}

function requireRuntimeEvent(value, label) {
  const event = requireExactKeys(
    value,
    ["level", "source", "text", "url"],
    label,
  );
  requireString(event.level, `${label}.level`);
  if (!["console", "pageerror", "requestfailed"].includes(event.source)) {
    fail(`${label}.source is unsupported`);
  }
  requireString(event.text, `${label}.text`);
  requireString(event.url, `${label}.url`);
  return event;
}

function requireRuntimeEvents(value, label, { nonempty = false } = {}) {
  return requireArray(value, label, { nonempty }).map((event, index) =>
    requireRuntimeEvent(event, `${label}[${index}]`),
  );
}

function validateWebRuntime(value, evidenceFile) {
  const runtime = requireExactKeys(
    value,
    ["expectedQueryAborts", "unexpectedEvents"],
    `${evidenceFile} webRuntime`,
  );
  requireEmptyArray(
    runtime.unexpectedEvents,
    `${evidenceFile} webRuntime.unexpectedEvents`,
  );
  for (const [index, value] of requireArray(
    runtime.expectedQueryAborts,
    `${evidenceFile} webRuntime.expectedQueryAborts`,
  ).entries()) {
    const label = `${evidenceFile} webRuntime.expectedQueryAborts[${index}]`;
    const event = requireExactKeys(
      value,
      [
        "method",
        "operationName",
        "operationType",
        "resourceType",
        "source",
        "text",
        "url",
      ],
      label,
    );
    if (
      event.method !== "POST" ||
      event.operationType !== "query" ||
      event.source !== "requestfailed" ||
      event.text !== "net::ERR_ABORTED"
    ) {
      fail(`${label} is not a narrowly classified GraphQL query abort`);
    }
    requireString(event.operationName, `${label}.operationName`);
    requireString(event.resourceType, `${label}.resourceType`);
    const url = requireUrl(event.url, `${label}.url`);
    if (url.pathname !== "/graphql") {
      fail(`${label}.url must identify the GraphQL endpoint`);
    }
  }
}

function requirePng(file, label) {
  const stat = requireRegularFile(file, label);
  if (stat.size <= PNG_SIGNATURE.length) fail(`${label} must be nonempty`);
  const png = fs.readFileSync(file);
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail(`${label} does not have a PNG signature`);
  }

  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawIend = false;
  while (offset < png.length) {
    if (offset + 12 > png.length) fail(`${label} has a truncated PNG chunk`);
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length)
      fail(`${label} has a truncated ${type || "unknown"} chunk`);
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) {
        fail(`${label} must begin with a 13-byte IHDR chunk`);
      }
      if (
        png.readUInt32BE(offset + 8) === 0 ||
        png.readUInt32BE(offset + 12) === 0
      ) {
        fail(`${label} has invalid PNG dimensions`);
      }
    }
    if (type === "IEND") {
      if (length !== 0 || end !== png.length) {
        fail(`${label} has an invalid IEND chunk`);
      }
      sawIend = true;
    }
    offset = end;
    chunkIndex += 1;
  }
  if (!sawIend) fail(`${label} has no IEND chunk`);
}

function validateScreenshots(value, evidenceFile) {
  const screenshots = requireExactKeys(
    value,
    ["electron", "offline", "web"],
    `${evidenceFile} screenshots`,
  );
  const evidenceDirectory = path.dirname(evidenceFile);
  const seen = new Set();

  for (const name of ["electron", "web", "offline"]) {
    const entry = requireExactKeys(
      screenshots[name],
      ["file", "sha256"],
      `${evidenceFile} screenshots.${name}`,
    );
    const fileName = requireString(
      entry.file,
      `${evidenceFile} screenshots.${name}.file`,
    );
    if (
      path.basename(fileName) !== fileName ||
      path.extname(fileName).toLowerCase() !== ".png"
    ) {
      fail(`${evidenceFile} screenshots.${name}.file must be an adjacent PNG`);
    }
    const screenshotFile = path.join(evidenceDirectory, fileName);
    requirePng(screenshotFile, `${evidenceFile} screenshots.${name}`);
    const realFile = fs.realpathSync(screenshotFile);
    if (path.dirname(realFile) !== fs.realpathSync(evidenceDirectory)) {
      fail(`${evidenceFile} screenshots.${name}.file is not adjacent`);
    }
    if (seen.has(realFile)) {
      fail(`${evidenceFile} reuses screenshot file ${fileName}`);
    }
    seen.add(realFile);
    const expectedDigest = requireSha256(
      entry.sha256,
      `${evidenceFile} screenshots.${name}.sha256`,
    );
    if (sha256(screenshotFile) !== expectedDigest) {
      fail(`${evidenceFile} screenshots.${name} hash does not match`);
    }
  }
}

function validateCleanup(value, evidenceFile, docId) {
  const cleanup = requireObject(value, `${evidenceFile} cleanup`);
  requireEmptyArray(cleanup.errors, `${evidenceFile} cleanup.errors`);
  for (const key of [
    "firstRuntimeClosed",
    "secondRuntimeClosed",
    "webBrowserClosed",
    "webSessionSignedOut",
  ]) {
    requireTrue(cleanup[key], `${evidenceFile} cleanup.${key}`);
  }

  const document = requireObject(
    cleanup.document,
    `${evidenceFile} cleanup.document`,
  );
  requireTrue(document.attempted, `${evidenceFile} cleanup.document.attempted`);
  requireTrue(document.deleted, `${evidenceFile} cleanup.document.deleted`);
  requireTrue(
    document.verifiedAbsent,
    `${evidenceFile} cleanup.document.verifiedAbsent`,
  );
  if (document.docId !== docId) {
    fail(`${evidenceFile} cleanup.document.docId differs from document.docId`);
  }
  const result = requireExactKeys(
    document.result,
    ["failed", "forbidden"],
    `${evidenceFile} cleanup.document.result`,
  );
  if (
    requireInteger(
      result.failed,
      `${evidenceFile} cleanup.document.result.failed`,
    ) !== 0 ||
    requireInteger(
      result.forbidden,
      `${evidenceFile} cleanup.document.result.forbidden`,
    ) !== 0
  ) {
    fail(`${evidenceFile} cleanup document deletion was not successful`);
  }

  const profile = requireObject(
    cleanup.profile,
    `${evidenceFile} cleanup.profile`,
  );
  requireString(profile.path, `${evidenceFile} cleanup.profile.path`);
  requireTrue(profile.removed, `${evidenceFile} cleanup.profile.removed`);
}

function validateCell(cellInfo, evidenceFile, expectedVersion) {
  const { cell } = cellInfo;
  if (cell.schema !== RELEASE_CELL_SCHEMA) {
    fail(`${evidenceFile} ancestor cell has the wrong schema`);
  }
  const platform = requireString(
    cell.platform,
    `${evidenceFile} cell.platform`,
  );
  const arch = requireString(cell.arch, `${evidenceFile} cell.arch`);
  const channel = requireString(cell.channel, `${evidenceFile} cell.channel`);
  if (!["beta", "internal", "stable"].includes(channel)) {
    fail(`${evidenceFile} cell.channel is unsupported`);
  }
  const sourceCommit = requireString(
    cell.sourceCommit,
    `${evidenceFile} cell.sourceCommit`,
  );
  if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) {
    fail(`${evidenceFile} cell.sourceCommit must be a Git commit digest`);
  }
  if (cell.version !== expectedVersion) {
    fail(`${evidenceFile} cell.version differs from ${expectedVersion}`);
  }
  const formats = requireArray(cell.formats, `${evidenceFile} cell.formats`, {
    nonempty: true,
  });
  if (
    formats.some(
      (format) => typeof format !== "string" || format.trim() === "",
    ) ||
    new Set(formats).size !== formats.length
  ) {
    fail(`${evidenceFile} cell.formats must contain unique nonempty strings`);
  }
  if (
    formats.some(
      (format) => !PUBLISHABLE_TUPLES.has(`${platform}/${arch}/${format}`),
    )
  ) {
    fail(`${evidenceFile} cell.formats contains an unsupported release tuple`);
  }
  return { arch, channel, formats, platform, sourceCommit };
}

function validateEvidence(evidence, evidenceFile, cellInfo, expectedVersion) {
  if (evidence.schema !== PRODUCT_FLOW_SCHEMA) {
    fail(`${evidenceFile} has the wrong schema`);
  }
  if (Object.hasOwn(evidence, "flowFailure")) {
    fail(`${evidenceFile} reports flowFailure`);
  }

  const flowId = requireString(evidence.flowId, `${evidenceFile} flowId`);
  if (
    !Array.isArray(evidence.contract) ||
    evidence.contract.length !== CONTRACT.length ||
    evidence.contract.some((item, index) => item !== CONTRACT[index])
  ) {
    fail(`${evidenceFile} has the wrong product contract`);
  }
  const generatedAt = requireString(
    evidence.generatedAt,
    `${evidenceFile} generatedAt`,
  );
  const generatedDate = new Date(generatedAt);
  if (
    Number.isNaN(generatedDate.valueOf()) ||
    generatedDate.toISOString() !== generatedAt
  ) {
    fail(`${evidenceFile} generatedAt must be an ISO-8601 UTC timestamp`);
  }

  const cell = validateCell(cellInfo, evidenceFile, expectedVersion);
  const serverInfo = requireExactKeys(
    evidence.serverInfo,
    ["flavor", "initialized", "version"],
    `${evidenceFile} serverInfo`,
  );
  if (
    serverInfo.flavor !== "myoxus-rust" ||
    serverInfo.initialized !== true ||
    serverInfo.version !== expectedVersion ||
    serverInfo.version !== cellInfo.cell.version
  ) {
    fail(
      `${evidenceFile} was not executed against initialized Myoxus ${expectedVersion}`,
    );
  }

  const workspace = requireObject(
    evidence.workspace,
    `${evidenceFile} workspace`,
  );
  const workspaceId = requireString(
    workspace.id,
    `${evidenceFile} workspace.id`,
  );
  requireTrue(workspace.initialized, `${evidenceFile} workspace.initialized`);
  if (
    workspace.name !== null &&
    (typeof workspace.name !== "string" || workspace.name.trim() === "")
  ) {
    fail(`${evidenceFile} workspace.name must be null or a nonempty string`);
  }

  const document = requireExactKeys(
    evidence.document,
    ["docId", "initialContent", "liveContent", "title"],
    `${evidenceFile} document`,
  );
  const docId = requireString(document.docId, `${evidenceFile} document.docId`);
  const initialContent = requireString(
    document.initialContent,
    `${evidenceFile} document.initialContent`,
  );
  const liveContent = requireString(
    document.liveContent,
    `${evidenceFile} document.liveContent`,
  );
  const title = requireString(document.title, `${evidenceFile} document.title`);
  if (initialContent === liveContent) {
    fail(`${evidenceFile} document content did not change`);
  }

  const credentials = requireExactKeys(
    evidence.credentials,
    ["emailEnvironment", "passwordEnvironment", "provisioner"],
    `${evidenceFile} credentials`,
  );
  if (
    credentials.emailEnvironment !== "E2E_USER_EMAIL" ||
    credentials.passwordEnvironment !== "E2E_USER_PASSWORD" ||
    credentials.provisioner !== "build/scripts/test/seed-test-users.sh"
  ) {
    fail(
      `${evidenceFile} credentials do not identify the synthetic seed contract`,
    );
  }

  const login = requireExactKeys(
    evidence.login,
    ["captchaSolved", "method", "server"],
    `${evidenceFile} login`,
  );
  if (login.method !== "password") {
    fail(`${evidenceFile} login.method must be password`);
  }
  requireBoolean(login.captchaSolved, `${evidenceFile} login.captchaSolved`);
  const loginServer = requireReleaseBaseUrl(
    login.server,
    `${evidenceFile} login.server`,
  );
  const environment = requireExactKeys(
    evidence.environment,
    ["apiUrl", "environmentId", "frontendUrl"],
    `${evidenceFile} environment`,
  );
  const apiUrl = requireReleaseBaseUrl(
    environment.apiUrl,
    `${evidenceFile} environment.apiUrl`,
  );
  const frontendUrl = requireReleaseBaseUrl(
    environment.frontendUrl,
    `${evidenceFile} environment.frontendUrl`,
  );
  if (apiUrl.href !== loginServer.href) {
    fail(`${evidenceFile} login.server differs from environment.apiUrl`);
  }

  const release = requireExactKeys(
    evidence.release,
    [
      "arch",
      "channel",
      "environmentId",
      "executable",
      "format",
      "package",
      "platform",
      "sourceCommit",
    ],
    `${evidenceFile} release`,
  );
  const environmentId = requireString(
    release.environmentId,
    `${evidenceFile} release.environmentId`,
  );
  if (!/^[A-Za-z0-9._:-]{3,128}$/.test(environmentId)) {
    fail(`${evidenceFile} release.environmentId is malformed`);
  }
  if (environment.environmentId !== environmentId) {
    fail(
      `${evidenceFile} environment.environmentId differs from release.environmentId`,
    );
  }
  for (const key of ["arch", "channel", "platform", "sourceCommit"]) {
    if (release[key] !== cell[key]) {
      fail(`${evidenceFile} release.${key} differs from its cell`);
    }
  }
  const format = requireString(
    release.format,
    `${evidenceFile} release.format`,
  );
  if (!cell.formats.includes(format)) {
    fail(`${evidenceFile} release.format is absent from cell.formats`);
  }
  const tuple = `${release.platform}/${release.arch}/${format}`;
  if (!PUBLISHABLE_TUPLES.has(tuple)) {
    fail(`${evidenceFile} has unsupported release tuple ${tuple}`);
  }

  const packageEvidence = requireExactKeys(
    release.package,
    ["name", "sha256"],
    `${evidenceFile} release.package`,
  );
  const packageName = requireString(
    packageEvidence.name,
    `${evidenceFile} release.package.name`,
  );
  if (path.basename(packageName) !== packageName) {
    fail(`${evidenceFile} release.package.name must be a file name`);
  }
  const packagesDirectory = path.join(cellInfo.directory, "packages");
  let packagesStat;
  try {
    packagesStat = fs.lstatSync(packagesDirectory);
  } catch {
    fail(`${evidenceFile} cell packages directory does not exist`);
  }
  if (!packagesStat.isDirectory() || packagesStat.isSymbolicLink()) {
    fail(`${evidenceFile} cell packages must be a real directory`);
  }
  const packageFile = path.join(packagesDirectory, packageName);
  requireRegularFile(packageFile, `${evidenceFile} release package`);
  if (
    path.dirname(fs.realpathSync(packageFile)) !==
    fs.realpathSync(packagesDirectory)
  ) {
    fail(`${evidenceFile} release package is outside cell packages`);
  }
  const packageDigest = requireSha256(
    packageEvidence.sha256,
    `${evidenceFile} release.package.sha256`,
  );
  if (sha256(packageFile) !== packageDigest) {
    fail(`${evidenceFile} release.package.sha256 does not match the package`);
  }

  const executable = requireExactKeys(
    release.executable,
    ["name", "sha256"],
    `${evidenceFile} release.executable`,
  );
  const executableName = requireString(
    executable.name,
    `${evidenceFile} release.executable.name`,
  );
  if (path.basename(executableName) !== executableName) {
    fail(`${evidenceFile} release.executable.name must be a file name`);
  }
  requireSha256(executable.sha256, `${evidenceFile} release.executable.sha256`);

  const liveSync = requireExactKeys(
    evidence.liveSync,
    ["mainFrameNavigations", "observedContent", "urlAfter", "urlBefore"],
    `${evidenceFile} liveSync`,
  );
  if (
    requireInteger(
      liveSync.mainFrameNavigations,
      `${evidenceFile} liveSync.mainFrameNavigations`,
    ) !== 0
  ) {
    fail(`${evidenceFile} liveSync navigated the Web main frame`);
  }
  const observedContent = requireString(
    liveSync.observedContent,
    `${evidenceFile} liveSync.observedContent`,
  );
  if (
    !observedContent.includes(initialContent) ||
    !observedContent.includes(liveContent)
  ) {
    fail(`${evidenceFile} liveSync content differs from document content`);
  }
  const liveUrlBefore = requireUrl(
    liveSync.urlBefore,
    `${evidenceFile} liveSync.urlBefore`,
  );
  const liveUrlAfter = requireUrl(
    liveSync.urlAfter,
    `${evidenceFile} liveSync.urlAfter`,
  );
  if (
    liveUrlBefore.protocol !== "https:" ||
    liveUrlAfter.protocol !== "https:" ||
    liveUrlBefore.origin !== frontendUrl.origin ||
    liveUrlAfter.origin !== frontendUrl.origin
  ) {
    fail(`${evidenceFile} liveSync URLs are outside the release-test frontend`);
  }
  if (liveSync.urlBefore !== liveSync.urlAfter) {
    fail(`${evidenceFile} liveSync URL changed`);
  }
  if (
    !liveSync.urlAfter.includes(encodeURIComponent(workspaceId)) ||
    !liveSync.urlAfter.includes(encodeURIComponent(docId))
  ) {
    fail(
      `${evidenceFile} liveSync URL does not identify the workspace and document`,
    );
  }

  const restart = requireObject(
    evidence.restartPersistence,
    `${evidenceFile} restartPersistence`,
  );
  const expectedOfflineEvents = requireRuntimeEvents(
    restart.expectedOfflineEvents,
    `${evidenceFile} restartPersistence.expectedOfflineEvents`,
    { nonempty: true },
  );
  if (
    !expectedOfflineEvents.some((event) => event.source === "requestfailed")
  ) {
    fail(`${evidenceFile} restartPersistence lacks an offline request failure`);
  }
  requireEmptyArray(
    restart.unexpectedEvents,
    `${evidenceFile} restartPersistence.unexpectedEvents`,
  );
  const persistence = requireExactKeys(
    restart.persistence,
    [
      "content",
      "docId",
      "fetchFailure",
      "rendererStartedOffline",
      "title",
      "url",
      "workspaceId",
    ],
    `${evidenceFile} restartPersistence.persistence`,
  );
  if (
    persistence.content !== liveContent ||
    persistence.docId !== docId ||
    persistence.title !== title ||
    persistence.workspaceId !== workspaceId
  ) {
    fail(
      `${evidenceFile} restart persistence differs from its document or workspace`,
    );
  }
  requireTrue(
    persistence.rendererStartedOffline,
    `${evidenceFile} restartPersistence.persistence.rendererStartedOffline`,
  );
  const fetchFailure = requireString(
    persistence.fetchFailure,
    `${evidenceFile} restartPersistence.persistence.fetchFailure`,
  );
  if (/^unexpected HTTP\b/i.test(fetchFailure)) {
    fail(
      `${evidenceFile} restart persistence did not prove an offline fetch failure`,
    );
  }
  const persistenceUrl = requireUrl(
    persistence.url,
    `${evidenceFile} restartPersistence.persistence.url`,
  );
  if (
    persistenceUrl.protocol !== "https:" ||
    persistenceUrl.origin !== frontendUrl.origin
  ) {
    fail(
      `${evidenceFile} persistence URL is outside the release-test frontend`,
    );
  }
  if (
    !persistence.url.includes(encodeURIComponent(workspaceId)) ||
    !persistence.url.includes(encodeURIComponent(docId))
  ) {
    fail(
      `${evidenceFile} persistence URL does not identify the workspace and document`,
    );
  }

  const firstLaunch = requireObject(
    evidence.firstLaunch,
    `${evidenceFile} firstLaunch`,
  );
  requireEmptyArray(
    firstLaunch.unexpectedEvents,
    `${evidenceFile} firstLaunch.unexpectedEvents`,
  );
  if (firstLaunch.expectedOfflineBootstrapEvents !== undefined) {
    requireRuntimeEvents(
      firstLaunch.expectedOfflineBootstrapEvents,
      `${evidenceFile} firstLaunch.expectedOfflineBootstrapEvents`,
    );
  }
  for (const key of ["main", "renderer", "shell"]) {
    requireObject(firstLaunch[key], `${evidenceFile} firstLaunch.${key}`);
  }
  if (
    firstLaunch.main.appVersion !== expectedVersion ||
    path.basename(firstLaunch.main.executableRealPath ?? "") !== executableName
  ) {
    fail(`${evidenceFile} firstLaunch main identity differs from release`);
  }

  validateWebRuntime(evidence.webRuntime, evidenceFile);
  validateScreenshots(evidence.screenshots, evidenceFile);
  validateCleanup(evidence.cleanup, evidenceFile, docId);

  return {
    environmentId,
    flowId,
    sourceCommit: cell.sourceCommit,
    tuple,
    channel: cell.channel,
  };
}

const [expectedVersion, ...files] = process.argv.slice(2);
if (!VERSION_PATTERN.test(expectedVersion ?? "")) {
  fail("usage: verify-electron-product-flow-evidence.mjs <version> <file>...");
}
if (files.length !== 9) {
  fail(
    `expected evidence for nine publishable package formats, got ${files.length}`,
  );
}

const seenEvidencePaths = new Set();
const seenFlowIds = new Set();
const seenTuples = new Set();
const identities = [];

for (const file of files) {
  const absolute = path.resolve(file);
  requireRegularFile(absolute, "evidence file");
  const realFile = fs.realpathSync(absolute);
  if (seenEvidencePaths.has(realFile)) fail(`duplicate evidence path ${file}`);
  seenEvidencePaths.add(realFile);

  const evidence = requireObject(readJson(absolute, file), file);
  const cellInfo = findReleaseCell(absolute);
  if (evidence.schema === BUILD_ONLY_SCHEMA) {
    const cell = validateCell(cellInfo, absolute, expectedVersion);
    validateBuildOnlyEvidence(
      evidence,
      cellInfo.cell,
      path.join(cellInfo.directory, "packages"),
    );
    const tuple = `${cell.platform}/${cell.arch}/${evidence.format}`;
    if (seenTuples.has(tuple))
      fail(`duplicate platform/arch/format tuple ${tuple}`);
    seenTuples.add(tuple);
    identities.push({ ...cell, tuple, buildOnly: true });
    continue;
  }
  const identity = validateEvidence(
    evidence,
    absolute,
    cellInfo,
    expectedVersion,
  );
  if (seenFlowIds.has(identity.flowId)) {
    fail(`duplicate flow ID ${identity.flowId}`);
  }
  seenFlowIds.add(identity.flowId);
  if (seenTuples.has(identity.tuple)) {
    fail(`duplicate platform/arch/format tuple ${identity.tuple}`);
  }
  seenTuples.add(identity.tuple);
  identities.push(identity);
}

if (
  seenTuples.size !== PUBLISHABLE_TUPLES.size ||
  [...PUBLISHABLE_TUPLES].some((tuple) => !seenTuples.has(tuple))
) {
  fail("evidence does not cover the exact nine publishable release tuples");
}
for (const key of ["channel", "environmentId", "sourceCommit"]) {
  const applicable =
    key === "environmentId"
      ? identities.filter((identity) => !identity.buildOnly)
      : identities;
  if (new Set(applicable.map((identity) => identity[key])).size !== 1) {
    fail(`evidence files do not share one release ${key}`);
  }
}

console.log(
  `verified packaged product flow for ${identities.filter((identity) => !identity.buildOnly).length} package formats; ${identities.filter((identity) => identity.buildOnly).length} ARM64 formats are build-only, native runtime/update tests NOT RUN`,
);
