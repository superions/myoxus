// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "../../../client/apps/electron/scripts/lib/process.ts";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const keepTemporary = args.has("--keep-temporary");
const buildOnly = args.has("--build-only");
const cleanupOnly = args.has("--cleanup-only");
// Linux /tmp may be a small tmpfs. Cold dependency/native/package closures
// belong on the runner's existing disk-backed scratch volume.
const temporaryBase = process.env.RUNNER_TEMP?.trim() || tmpdir();
const buildTemporaryEnvironment =
  process.platform === "win32" ? {} : { TMPDIR: temporaryBase };

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const platform = required("MYOXUS_UPDATE_E2E_PLATFORM");
const arch = required("MYOXUS_UPDATE_E2E_ARCH");
const backend = required("MYOXUS_UPDATE_E2E_BACKEND");
const channel = required("MYOXUS_UPDATE_E2E_CHANNEL");

const platformContract = {
  linux: {
    host: "linux",
    platforms: ["x64"],
    backends: ["deb", "flatpak", "rpm"],
    packagingPlatform: "linux",
  },
  macos: {
    host: "darwin",
    platforms: ["x64"],
    backends: ["homebrew"],
    packagingPlatform: "darwin",
  },
  windows: {
    host: "win32",
    platforms: ["x64"],
    backends: ["nsis", "zip"],
    packagingPlatform: "win32",
  },
};
const contract = platformContract[platform];
if (
  !contract ||
  !contract.platforms.includes(arch) ||
  !contract.backends.includes(backend) ||
  !["beta", "internal", "stable"].includes(channel)
) {
  throw new Error(
    `Unsupported update E2E cell ${platform}/${arch}/${backend}/${channel}`,
  );
}
if (buildOnly && (platform !== "linux" || backend !== "deb")) {
  throw new Error("Build-only creates the shared Linux DEB/RPM fixture set");
}
if (
  cleanupOnly &&
  (platform !== "linux" ||
    !["deb", "rpm"].includes(backend) ||
    !process.env.MYOXUS_UPDATE_E2E_REUSE_DIR)
) {
  throw new Error("Cleanup-only requires retained Linux native fixtures");
}

const versions = {
  stable: ["9000.0.0", "9000.0.1"],
  beta: ["9000.0.0-beta.1", "9000.0.0-beta.2"],
  internal: ["9000.0.0-internal.1", "9000.0.0-internal.2"],
};
const [sourceVersion, targetVersion] = versions[channel];
const cellId = `${platform}-${arch}-${backend}-${channel}`;
const channelIndex = ["stable", "beta", "internal"].indexOf(channel);
// DEB and RPM share one sealed build and its embedded feed URL. Their native
// lifecycles run on different OS owners, so the same per-channel port is safe.
const feedBackend = platform === "linux" && backend === "rpm" ? "deb" : backend;
const feedCellIndex =
  platform === "linux"
    ? ["deb", "flatpak", "rpm"].indexOf(feedBackend) * 3 + channelIndex
    : platform === "macos"
      ? 9 + ["arm64", "x64"].indexOf(arch) * 3 + channelIndex
      : 15 + ["nsis", "zip"].indexOf(backend) * 3 + channelIndex;
const feedPort = 44000 + feedCellIndex;
const feedUrl = `https://127.0.0.1:${feedPort}/api/v1/repos/myoxus/packages/releases?page=1&limit=50`;
const productName = channel === "stable" ? "Myoxus" : `Myoxus-${channel}`;
const artifactFormat =
  backend === "homebrew" ? "dmg" : backend === "nsis" ? "exe" : backend;
const appId = {
  stable: "org.myoxus.desktop",
  beta: "org.myoxus.beta",
  internal: "org.myoxus.internal",
}[channel];
const evidenceDirectory = path.join(
  repoRoot,
  "output",
  "electron-build",
  "P-ELECTRON-BUILD-12",
  "update-e2e",
  `${platform}-${arch}-${backend}-${channel}`,
);

const plan = {
  arch,
  backend,
  channel,
  controlBundleScan: true,
  evidenceDirectory: path.relative(repoRoot, evidenceDirectory),
  feedUrl,
  platform,
  sourceFormat: backend === "homebrew" ? "dmg" : backend,
  sourceVersion,
  targetFormat: backend === "homebrew" ? "dmg" : backend,
  targetVersion,
  updateMode:
    backend === "homebrew"
      ? "homebrew-cask"
      : backend === "flatpak"
        ? "flatpak-ostree"
        : backend === "zip"
          ? "portable-no-backend"
          : "electron-updater",
};
if (dryRun) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}
if (process.platform !== contract.host) {
  throw new Error(
    `${platform} update E2E requires ${contract.host}, got ${process.platform}`,
  );
}

async function run(command, commandArgs, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(
          new Error(
            `${command} exited with ${code ?? signal}${stderr ? `\n${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

async function capture(command, commandArgs, options = {}) {
  let result;
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        result = { stderr, stdout };
        resolve();
      } else {
        reject(
          new Error(
            `${command} exited with ${code ?? signal}${stderr ? `\n${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
  return result;
}

async function runStatus(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === null) {
        reject(new Error(`${command} exited by signal ${signal ?? "unknown"}`));
      } else {
        resolve(code);
      }
    });
  });
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function acquireHostLock(lockDirectory) {
  const deadline = Date.now() + 3 * 60 * 60 * 1000;
  while (true) {
    try {
      await mkdir(lockDirectory);
      await writeFile(
        path.join(lockDirectory, "owner.json"),
        `${JSON.stringify({
          cellId,
          feedPort,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        })}\n`,
      );
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(
          await readFile(path.join(lockDirectory, "owner.json"), "utf8"),
        );
        if (!Number.isInteger(owner.pid)) {
          stale = true;
        } else {
          try {
            process.kill(owner.pid, 0);
          } catch (processError) {
            if (processError?.code === "ESRCH") stale = true;
            else throw processError;
          }
        }
      } catch (ownerError) {
        if (
          ownerError?.code === "ENOENT" ||
          ownerError instanceof SyntaxError
        ) {
          stale = true;
        } else {
          throw ownerError;
        }
      }
      if (stale) {
        await rm(lockDirectory, { force: true, recursive: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for serialized update E2E host state (${lockDirectory})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

async function setSyntheticVersion(sourceRoot, version) {
  const manifestPath = path.join(
    sourceRoot,
    "client/apps/electron/package.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await run("git", ["add", "client/apps/electron/package.json"], {
    cwd: sourceRoot,
  });
  await run(
    "git",
    [
      "-c",
      "user.name=Myoxus Update E2E",
      "-c",
      "user.email=update-e2e@invalid.myoxus",
      "commit",
      "-m",
      `electron-e2e-version-${version}`,
    ],
    { cwd: sourceRoot },
  );
  const { stdout } = await capture("git", ["status", "--porcelain"], {
    cwd: sourceRoot,
  });
  if (stdout.trim()) {
    throw new Error(
      `Synthetic source clone is dirty before packaging:\n${stdout}`,
    );
  }
}

async function allFiles(root) {
  const result = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  return result;
}

async function fileContains(file, needle) {
  const handle = createReadStream(file);
  const target = Buffer.from(needle);
  let tail = Buffer.alloc(0);
  for await (const chunk of handle) {
    const buffer = Buffer.concat([tail, chunk]);
    if (buffer.indexOf(target) >= 0) return true;
    tail = buffer.subarray(Math.max(0, buffer.length - target.length + 1));
  }
  return false;
}

async function assertTreeContains(root, needle) {
  for (const file of await allFiles(root)) {
    if (await fileContains(file, needle)) return;
  }
  throw new Error(`E2E stage does not contain compile-time feed ${needle}`);
}

async function assertProductionTree(root) {
  const forbidden = [
    "https://127.0.0.1:",
    "electronE2e: true",
    "electronE2e=true",
  ];
  for (const file of await allFiles(root)) {
    for (const needle of forbidden) {
      if (await fileContains(file, needle)) {
        throw new Error(
          `Production bundle ${file} contains forbidden E2E marker ${needle}`,
        );
      }
    }
  }
}

function yarn(sourceRoot, commandArgs, environment) {
  return run(
    process.execPath,
    [path.join(sourceRoot, ".yarn/releases/yarn-4.18.0.cjs"), ...commandArgs],
    { cwd: sourceRoot, env: environment },
  );
}

async function fetchMacRuntimes(sourceRoot) {
  const directory = path.join(temporaryRoot, "electron-runtime");
  await mkdir(directory);
  const manifest = JSON.parse(
    await readFile(
      path.join(sourceRoot, "client/apps/electron/package.json"),
      "utf8",
    ),
  );
  const version = manifest.devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Electron runtime must be pinned");
  const release = `https://github.com/electron/electron/releases/download/v${version}`;
  // Same official HTTP/1.1 and digest contract as the ordinary Mac package cell.
  // Fetch once for both architectures, rather than retrying Node's refused streams.
  const download = (name) =>
    run("curl", [
      "--http1.1",
      "--fail",
      "--location",
      "--retry",
      "3",
      "--retry-max-time",
      "180",
      "--connect-timeout",
      "20",
      "--max-time",
      "300",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      `${release}/${name}`,
      "--output",
      path.join(directory, name),
    ]);
  await download("SHASUMS256.txt");
  const checksums = (
    await readFile(path.join(directory, "SHASUMS256.txt"), "utf8")
  ).split("\n");
  for (const arch of ["x64", "arm64"]) {
    const archive = `electron-v${version}-darwin-${arch}.zip`;
    const expected = checksums
      .map((line) => line.trim().split(/\s+\*?/))
      .filter((parts) => parts[1] === archive);
    if (expected.length !== 1 || !/^[a-f0-9]{64}$/.test(expected[0][0]))
      throw new Error(`Missing upstream digest for ${archive}`);
    await download(archive);
    if ((await sha256(path.join(directory, archive))) !== expected[0][0])
      throw new Error(`Electron runtime digest mismatch: ${archive}`);
  }
  return directory;
}

async function buildVersion(sourceRoot, version, targetArch = arch) {
  await setSyntheticVersion(sourceRoot, version);
  const environment = {
    ...process.env,
    ...buildTemporaryEnvironment,
    BUILD_TYPE: channel,
    DISTRIBUTION: "desktop",
    ELECTRON_E2E: "1",
    ELECTRON_E2E_UPDATE_FEED: feedUrl,
    NODE_ENV: "production",
    ...(electronZipDir ? { ELECTRON_ZIP_DIR: electronZipDir } : {}),
    ...(backend === "deb" || backend === "rpm" || backend === "nsis"
      ? { ELECTRON_E2E_PACKAGE_TYPE: backend }
      : {}),
  };
  if (backend === "homebrew") {
    for (const key of [
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
    ])
      delete environment[key];
  }
  // Use the normal package owner: native bindings precede Main/renderer builds
  // in cold clones too. A standalone build with SKIP_WEB_BUILD assumed warm .node files.
  await yarn(
    sourceRoot,
    [
      "workspace",
      "@myoxus/electron",
      "package",
      "--platform",
      contract.packagingPlatform,
      "--arch",
      targetArch,
    ],
    environment,
  );
  const stage = path.join(
    sourceRoot,
    "client/apps/electron/out",
    channel,
    "stage",
    `${contract.packagingPlatform}-${targetArch}`,
    "app",
  );
  await assertTreeContains(stage, feedUrl);
  const packagedApp = path.join(
    sourceRoot,
    "client/apps/electron/out",
    channel,
    `${productName}-${contract.packagingPlatform}-${targetArch}`,
  );
  await assertTreeContains(packagedApp, feedUrl);
  await assertTreeContains(packagedApp, "electronE2e=true");

  // The immutable application was just packaged; native makers consume it,
  // rather than building the same N/N+1 candidate a second time.
  environment.SKIP_PACKAGE = "1";

  if (platform === "linux") {
    await yarn(
      sourceRoot,
      [
        "workspace",
        "@myoxus/electron",
        "make-linux",
        "--platform",
        "linux",
        "--arch",
        targetArch,
      ],
      { ...environment, LINUX_TARGETS: buildOnly ? "deb,rpm" : backend },
    );
  } else if (backend === "nsis") {
    await yarn(
      sourceRoot,
      [
        "workspace",
        "@myoxus/electron",
        "make-nsis",
        "--platform",
        "win32",
        "--arch",
        targetArch,
      ],
      environment,
    );
  } else {
    await yarn(
      sourceRoot,
      [
        "workspace",
        "@myoxus/electron",
        "make",
        "--platform",
        contract.packagingPlatform,
        "--arch",
        targetArch,
      ],
      environment,
    );
  }

  const expected = `myoxus-${version}-${channel}-${platform}-${targetArch}.${artifactFormat}`;
  const candidates = (
    await allFiles(
      path.join(sourceRoot, "client/apps/electron/out", channel, "make"),
    )
  ).filter((candidate) => path.basename(candidate) === expected);
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one ${expected}, found ${candidates.length}`,
    );
  }
  const destination = path.join(evidenceDirectory, "artifacts", expected);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(candidates[0], destination);
  if (buildOnly) {
    const rpm = expected.replace(/\.deb$/, ".rpm");
    const rpms = (
      await allFiles(
        path.join(sourceRoot, "client/apps/electron/out", channel, "make"),
      )
    ).filter((file) => path.basename(file) === rpm);
    if (rpms.length !== 1) throw new Error(`Expected exactly one ${rpm}`);
    await copyFile(rpms[0], path.join(evidenceDirectory, "artifacts", rpm));
  }
  return destination;
}

async function stageNativeFixtureRuntime(sourceCommit) {
  // Install owners execute only the existing Playwright consumer. They do not
  // need the workspace dependency graph, Rust, a renderer build or browsers.
  const runtime = path.join(evidenceDirectory, "runtime", "node_modules");
  await mkdir(runtime, { recursive: true });
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    await cp(
      path.join(repoRoot, "node_modules", name),
      path.join(runtime, name),
      { recursive: true, dereference: true },
    );
  }
  const files = (
    await allFiles(path.join(evidenceDirectory, "artifacts"))
  ).filter((file) => /\.(deb|rpm)$/.test(file));
  if (files.length !== 4)
    throw new Error("Native fixture set must contain N/N+1 DEB and RPM");
  await writeFile(
    path.join(evidenceDirectory, "fixture-build.json"),
    JSON.stringify(
      {
        schema: "myoxus.electron-native-update-fixture.v1",
        sourceCommit,
        channel,
        artifacts: await Promise.all(files.map(artifactEvidence)),
      },
      null,
      2,
    ) + "\n",
  );
}

async function buildProductionControl(sourceRoot) {
  const environment = {
    ...process.env,
    ...buildTemporaryEnvironment,
    BUILD_TYPE: channel,
    DISTRIBUTION: "desktop",
    NODE_ENV: "production",
    ...(electronZipDir ? { ELECTRON_ZIP_DIR: electronZipDir } : {}),
  };
  delete environment.ELECTRON_E2E;
  delete environment.ELECTRON_E2E_PACKAGE_TYPE;
  delete environment.ELECTRON_E2E_UPDATE_FEED;
  if (backend === "homebrew") {
    for (const key of [
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
    ])
      delete environment[key];
  }
  await yarn(
    sourceRoot,
    [
      "workspace",
      "@myoxus/electron",
      "package",
      "--platform",
      contract.packagingPlatform,
      "--arch",
      arch,
    ],
    environment,
  );
  const packagedApp = path.join(
    sourceRoot,
    "client/apps/electron/out",
    channel,
    `${productName}-${contract.packagingPlatform}-${arch}`,
  );
  await assertProductionTree(packagedApp);
  await writeFile(
    path.join(evidenceDirectory, "production-bundle-scan.json"),
    `${JSON.stringify(
      {
        forbidden: [
          "https://127.0.0.1:",
          "electronE2e: true",
          "electronE2e=true",
        ],
        result: "absent",
      },
      null,
      2,
    )}\n`,
  );
}

async function sha256(file) {
  // ASARs can exceed the memory budget of an installation-only VM.
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function nativeHeadlessPath(root, searchPath) {
  const directory = path.join(root, "headless-path");
  await mkdir(directory);
  // LinuxUpdater otherwise prefers pkexec merely because it exists, even when
  // CI has no graphical agent. Project real executables, excluding only its
  // graphical authentication candidates; package managers are never shimmed.
  const graphical = new Set(["gksudo", "kdesudo", "pkexec", "beesu"]);
  const names = new Set();
  for (const source of searchPath
    .split(path.delimiter)
    .filter(path.isAbsolute)) {
    let entries;
    try {
      entries = await readdir(source, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (
        graphical.has(entry.name) ||
        names.has(entry.name) ||
        (!entry.isFile() && !entry.isSymbolicLink())
      )
        continue;
      const executable = path.join(source, entry.name);
      try {
        await access(executable, constants.X_OK);
      } catch (error) {
        if (["ENOENT", "EACCES"].includes(error?.code)) continue;
        throw error;
      }
      await symlink(executable, path.join(directory, entry.name));
      names.add(entry.name);
    }
  }
  if (!names.has("sudo"))
    throw new Error(
      "Native headless update requires the provisioned sudo binary",
    );
  return directory;
}

async function artifactEvidence(file) {
  return {
    name: path.basename(file),
    sha256: await sha256(file),
    size: (await stat(file)).size,
  };
}

async function waitForAsarChange(file, previousDigest) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await sha256(file)) !== previousDigest) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Installed app.asar did not change at ${file}`);
}

async function installMacDmg(artifact, temporaryRoot) {
  const mount = path.join(temporaryRoot, "dmg");
  const applications = path.join(temporaryRoot, "Applications");
  await mkdir(mount, { recursive: true });
  await mkdir(applications, { recursive: true });
  await run("hdiutil", [
    "attach",
    artifact,
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
  ]);
  try {
    const app = (await readdir(mount)).find((entry) => entry.endsWith(".app"));
    if (!app) throw new Error("DMG contains no application bundle");
    await run("ditto", [path.join(mount, app), path.join(applications, app)]);
    const bundle = path.join(applications, app);
    return {
      asar: path.join(bundle, "Contents/Resources/app.asar"),
      executable: path.join(bundle, `Contents/MacOS/${productName}`),
    };
  } finally {
    await run("hdiutil", ["detach", mount]);
  }
}

async function pathExists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function prepareHomebrew(temporaryRoot, runtimeEnvironment) {
  const environment = {
    ...runtimeEnvironment,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_FROM_API: "1",
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_CACHE: path.join(temporaryRoot, "brew-cache"),
    HOMEBREW_LOGS: path.join(temporaryRoot, "brew-logs"),
  };
  delete environment.HOMEBREW_CASK_OPTS;
  // CI may only read the host's Homebrew installation. A local source clone
  // gives this journey its own prefix, Caskroom and taps without chmod/sudo.
  const hostRepository = (
    await capture("brew", ["--repository"])
  ).stdout.trim();
  const prefix = path.join(temporaryRoot, "homebrew");
  await run("git", ["clone", "--shared", hostRepository, prefix]);
  const portableRuby = "Library/Homebrew/vendor/portable-ruby";
  if (await pathExists(path.join(hostRepository, portableRuby))) {
    await symlink(
      path.join(hostRepository, portableRuby),
      path.join(prefix, portableRuby),
      "dir",
    );
  }
  const brewPath = path.join(prefix, "bin/brew");
  const brew = (args) => run(brewPath, args, { env: environment });
  const query = async (args) =>
    (await capture(brewPath, args, { env: environment })).stdout.trim();
  if ((await query(["--prefix"])) !== (await realpath(prefix)))
    throw new Error("Homebrew fixture escaped its owned prefix");
  await query(["--version"]);
  return { brew, query };
}

async function runHomebrewLifecycle({
  sourceArtifact,
  targetArtifact,
  armSource,
  armTarget,
  temporaryRoot,
  profile,
  runtimeEnvironment,
  cleanup,
  homebrewFixture,
}) {
  const { renderHomebrewCask } = await import("./write-homebrew-cask.mjs");
  const token = channel === "stable" ? "myoxus" : `myoxus-${channel}`;
  const tap = `myoxus/e2e-${path.basename(temporaryRoot).toLowerCase()}`;
  const fullToken = `${tap}/${token}`;
  const tapSource = path.join(temporaryRoot, "tap");
  const { brew, query } = homebrewFixture;
  const caskroom = path.join(await query(["--caskroom"]), token);
  if (await pathExists(caskroom))
    throw new Error(`Refusing pre-existing Homebrew installation ${token}`);
  await mkdir(path.join(tapSource, "Casks"), { recursive: true });
  await run("git", ["init", "--initial-branch=main", tapSource]);
  const writeCask = async (version, intel, arm) => {
    // Both DMGs are real built/hash-verified fixtures. ARM64 is never executed.
    // Reuse the production Cask renderer, replacing only its download origin
    // with this task's immutable local artifacts; no security override/hooks.
    const artifacts = [];
    for (const [arch, file] of [
      ["x64", intel],
      ["arm64", arm],
    ])
      artifacts.push({
        platform: "macos",
        arch,
        format: "dmg",
        name: path.basename(file),
        sha256: await sha256(file),
      });
    const cask = renderHomebrewCask({
      scope: "macos",
      publishable: true,
      channel,
      version,
      artifacts,
    });
    const local = `${pathToFileURL(path.dirname(intel) + path.sep).href}myoxus-${version}-${channel}-macos-#{arch}.dmg`;
    await writeFile(
      path.join(tapSource, cask.path),
      cask.source.replace(/^  url "[^"]+"$/m, `  url "${local}"`),
    );
    await run("git", ["-C", tapSource, "add", cask.path]);
    await run("git", [
      "-C",
      tapSource,
      "-c",
      "user.name=Myoxus fixture",
      "-c",
      "user.email=fixture@myoxus.invalid",
      "commit",
      "-m",
      `Fixture ${version}`,
    ]);
  };
  await writeCask(sourceVersion, sourceArtifact, armSource);
  const taps = () => query(["tap"]);
  if ((await taps()).split("\n").includes(tap))
    throw new Error("Fixture tap already exists");
  cleanup.push(async () => {
    if (await pathExists(caskroom)) {
      const info = JSON.parse(
        await query(["info", "--json=v2", "--cask", fullToken]),
      ).casks[0];
      const versions = Array.isArray(info.installed)
        ? info.installed
        : [info.installed];
      if (
        info.tap !== tap ||
        versions.some(
          (v) =>
            ![sourceVersion, targetVersion].includes(
              typeof v === "string" ? v : v?.version,
            ),
        )
      )
        throw new Error("Refusing foreign Homebrew cleanup");
      await brew(["uninstall", "--cask", fullToken]);
      if (await pathExists(caskroom))
        throw new Error("Homebrew installation was not removed");
    }
    if ((await taps()).split("\n").includes(tap)) await brew(["untap", tap]);
  });
  await brew(["tap", tap, pathToFileURL(tapSource).href]);
  // Exercise explicit direct-DMG handover rather than silently assuming a
  // pre-existing app is Homebrew-owned. --adopt refuses non-identical bytes.
  const installed = await installMacDmg(sourceArtifact, temporaryRoot);
  await runSpec({
    executable: installed.executable,
    phase: "external-before",
    profile,
    environment: runtimeEnvironment,
  });
  const applications = path.dirname(
    path.dirname(path.dirname(installed.executable)),
  );
  const appDirectory = path.dirname(applications);
  const originalAsar = await sha256(installed.asar);
  await brew([
    "install",
    "--cask",
    "--adopt",
    `--appdir=${appDirectory}`,
    fullToken,
  ]);
  await runSpec({
    executable: installed.executable,
    phase: "external-adopted",
    profile,
    environment: runtimeEnvironment,
  });
  await writeCask(targetVersion, targetArtifact, armTarget);
  const tapCheckout = await query(["--repo", tap]);
  await run("git", ["-C", tapCheckout, "pull", "--ff-only"]);
  await brew(["upgrade", "--cask", `--appdir=${appDirectory}`, fullToken]);
  const activatedAsar = await sha256(installed.asar);
  if (activatedAsar === originalAsar)
    throw new Error("Homebrew upgrade did not activate a new application");
  await runSpec({
    executable: installed.executable,
    phase: "external-after",
    profile,
    environment: runtimeEnvironment,
  });
  await writeFile(
    path.join(evidenceDirectory, "homebrew-activation.json"),
    JSON.stringify(
      {
        tap,
        sourceVersion,
        targetVersion,
        originalAsar,
        activatedAsar,
        directDmgAdopted: true,
      },
      null,
      2,
    ) + "\n",
  );
}

async function preflightWindowsFixture(artifactRoot, temporaryRoot) {
  await run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(repoRoot, "build/scripts/ci/verify-windows-client-install.ps1"),
    "-ArtifactRoot",
    artifactRoot,
    "-Version",
    sourceVersion,
    "-Channel",
    channel,
    "-OwnedRoot",
    path.join(temporaryRoot, "installed"),
    "-EvidenceRoot",
    path.join(evidenceDirectory, "registration-preflight"),
    "-PreflightOnly",
  ]);
}

async function installWindowsNsis(artifact, temporaryRoot, cleanup) {
  const installRoot = path.join(temporaryRoot, "installed");
  let installationCompleted = false;
  await preflightWindowsFixture(path.dirname(artifact), temporaryRoot);
  await mkdir(installRoot, { recursive: true });
  cleanup.push(async () => {
    const uninstallers = (await allFiles(installRoot)).filter((candidate) =>
      /^Uninstall.*\.exe$/i.test(path.basename(candidate)),
    );
    if (uninstallers.length === 0 && !installationCompleted) return;
    if (uninstallers.length !== 1) {
      throw new Error(
        `Expected one NSIS uninstaller, found ${uninstallers.length}`,
      );
    }
    await runProcess({
      command: uninstallers[0],
      args: ["/S", "/CurrentUser", `_?=${installRoot}`],
      cwd: repoRoot,
      timeoutMs: 120_000,
    });
  });
  await runProcess({
    command: artifact,
    args: ["/S", "/CurrentUser", `/D=${installRoot}`],
    cwd: repoRoot,
    timeoutMs: 180_000,
  });
  installationCompleted = true;
  const uninstallers = (await allFiles(installRoot)).filter((candidate) =>
    /^Uninstall.*\.exe$/i.test(path.basename(candidate)),
  );
  if (uninstallers.length !== 1) {
    throw new Error(
      `Expected one NSIS uninstaller after installation, found ${uninstallers.length}`,
    );
  }
  return {
    asar: path.join(installRoot, "resources", "app.asar"),
    executable: path.join(installRoot, `${productName}.exe`),
  };
}

async function extractWindowsZip(artifact, temporaryRoot, cleanup) {
  const installRoot = path.join(temporaryRoot, "portable");
  await preflightWindowsFixture(path.dirname(artifact), temporaryRoot);
  cleanup.push(async () => {
    await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "build/scripts/ci/verify-windows-client-install.ps1"),
      "-ArtifactRoot",
      path.dirname(artifact),
      "-Version",
      sourceVersion,
      "-Channel",
      channel,
      "-OwnedRoot",
      installRoot,
      "-EvidenceRoot",
      path.join(evidenceDirectory, "protocol-cleanup"),
      "-RemoveOwnedProtocol",
    ]);
  });
  await mkdir(installRoot, { recursive: true });
  await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:MYOXUS_UPDATE_ZIP -DestinationPath $env:MYOXUS_UPDATE_EXTRACT_ROOT -Force",
    ],
    {
      env: {
        ...process.env,
        MYOXUS_UPDATE_ZIP: artifact,
        MYOXUS_UPDATE_EXTRACT_ROOT: installRoot,
      },
    },
  );
  const executable = (await allFiles(installRoot)).find(
    (candidate) => path.basename(candidate) === `${productName}.exe`,
  );
  if (!executable) throw new Error("Windows ZIP contains no Myoxus executable");
  return {
    asar: path.join(path.dirname(executable), "resources", "app.asar"),
    executable,
  };
}

async function removeKnownNativePredecessor(artifact) {
  const packageName = productName.toLowerCase();
  const deb = backend === "deb";
  const queryArgs = deb ? ["-W", packageName] : ["-q", packageName];
  const query = await runStatus(deb ? "dpkg-query" : "rpm", queryArgs);
  if (query === 1) return "absent";
  if (query !== 0)
    throw new Error("Could not establish installed native package identity");
  const installedVersion = (
    await capture(
      deb ? "dpkg-query" : "rpm",
      deb
        ? ["-W", "-f=${Version}", packageName]
        : ["-q", "--qf", "%{VERSION}-%{RELEASE}", packageName],
    )
  ).stdout.trim();
  const fixtureVersion = (
    await capture(
      deb ? "dpkg-deb" : "rpm",
      deb
        ? ["-f", artifact, "Version"]
        : ["-qp", "--qf", "%{VERSION}-%{RELEASE}", artifact],
    )
  ).stdout.trim();
  if (
    !fixtureVersion.startsWith("9000.") ||
    installedVersion !== fixtureVersion
  )
    throw new Error(
      `Refusing a foreign installed native package version: ${installedVersion}; fixture: ${fixtureVersion}`,
    );
  const asar = path.join("/opt", productName, "resources/app.asar");
  if ((await realpath(asar)) !== asar)
    throw new Error("Refusing an aliased predecessor ASAR");
  const running = await runStatus("pgrep", [
    "-f",
    `^/opt/${productName}/${productName}( |$)`,
  ]);
  if (running !== 1)
    throw new Error("Refusing active or unknown predecessor process state");
  // Read only the sealed ASAR from the already checksum-verified fixture. A
  // version label alone never authorizes removal of a host installation.
  const reference = (
    await capture("bash", [
      "-o",
      "pipefail",
      "-c",
      deb
        ? 'dpkg-deb --fsys-tarfile "$1" | tar -xOf - "$2" | sha256sum'
        : 'rpm2cpio "$1" | cpio --quiet -i --to-stdout "$2" | sha256sum',
      "fixture-asar",
      artifact,
      `./opt/${productName}/resources/app.asar`,
    ])
  ).stdout
    .trim()
    .split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(reference) || (await sha256(asar)) !== reference)
    throw new Error("Refusing changed or foreign predecessor package bytes");
  await run("sudo", [
    "-n",
    deb ? "apt-get" : "dnf",
    deb ? "purge" : "remove",
    "-y",
    packageName,
  ]);
  if ((await runStatus(deb ? "dpkg-query" : "rpm", queryArgs)) !== 1)
    throw new Error("Owned predecessor native package was not removed");
  return "removed";
}

async function installLinuxPackage(artifact, cleanup) {
  const packageName = productName.toLowerCase();
  const alreadyInstalled =
    backend === "deb"
      ? (await runStatus("dpkg-query", ["-W", "-f=${Status}", packageName])) ===
        0
      : (await runStatus("rpm", ["-q", packageName])) === 0;
  if (alreadyInstalled) {
    throw new Error(
      `Refusing to replace pre-existing host package ${packageName} (${await packageManagerIdentity()})`,
    );
  }
  cleanup.push(async () => {
    if (backend === "deb") {
      if (
        (await runStatus("dpkg-query", ["-W", "-f=${Status}", packageName])) !==
        0
      ) {
        return;
      }
      await run("sudo", ["-n", "apt-get", "purge", "-y", packageName]);
      return;
    }
    if ((await runStatus("rpm", ["-q", packageName])) !== 0) return;
    await run("sudo", ["-n", "dnf", "remove", "-y", packageName]);
  });
  await run("sudo", ["-n", "true"]);
  if (backend === "deb") {
    await run("sudo", [
      "-n",
      "apt-get",
      "install",
      "-y",
      "--allow-downgrades",
      artifact,
    ]);
  } else {
    await run("sudo", ["-n", "dnf", "install", "-y", artifact]);
  }
  return {
    asar: path.join("/opt", productName, "resources", "app.asar"),
    executable: path.join("/opt", productName, productName),
  };
}

async function installFlatpak(artifact, temporaryRoot, environment, cleanup) {
  const repository = path.join(temporaryRoot, "ostree");
  const remote = `myoxus-e2e-${channel}-${process.pid}`;
  const runtimeRemote = `myoxus-runtime-${channel}-${process.pid}`;
  await mkdir(repository, { recursive: true });
  await run("ostree", ["init", `--repo=${repository}`, "--mode=archive-z2"], {
    env: environment,
  });
  await run("flatpak", ["build-import-bundle", repository, artifact], {
    env: environment,
  });
  await run("flatpak", ["build-update-repo", repository], {
    env: environment,
  });
  cleanup.push(async () => {
    const names = (
      await capture("flatpak", ["--user", "remotes", "--columns=name"], {
        env: environment,
      })
    ).stdout
      .trim()
      .split("\n");
    for (const ownedRemote of [remote, runtimeRemote]) {
      if (names.includes(ownedRemote))
        await run(
          "flatpak",
          ["--user", "remote-delete", "--force", ownedRemote],
          { env: environment },
        );
    }
  });
  cleanup.push(async () => {
    if (
      (await runStatus("flatpak", ["--user", "info", appId], {
        env: environment,
      })) !== 0
    ) {
      return;
    }
    await run(
      "flatpak",
      ["--user", "uninstall", "--noninteractive", "--delete-data", appId],
      { env: environment },
    );
  });
  await run(
    "flatpak",
    ["--user", "remote-add", "--no-gpg-verify", remote, `file://${repository}`],
    { env: environment },
  );
  const metadata = (
    await capture(
      "flatpak",
      [
        "--user",
        "remote-info",
        "--show-metadata",
        remote,
        `${appId}//${channel}`,
      ],
      { env: environment },
    )
  ).stdout;
  const runtime = metadata.match(
    /^runtime=(org\.freedesktop\.Platform\/x86_64\/\d+\.\d+)$/m,
  )?.[1];
  if (!runtime)
    throw new Error("Flatpak fixture has no supported Freedesktop runtime");
  // The isolated user installation cannot see the build user's SDK/runtime.
  // Install only its declared signed runtime into this task-owned installation.
  await run(
    "flatpak",
    [
      "--user",
      "remote-add",
      "--from",
      runtimeRemote,
      "https://dl.flathub.org/repo/flathub.flatpakrepo",
    ],
    { env: environment },
  );
  await run(
    "flatpak",
    [
      "--user",
      "install",
      "--noninteractive",
      "--no-related",
      runtimeRemote,
      runtime,
    ],
    { env: environment },
  );
  await run(
    "flatpak",
    ["--user", "install", "--noninteractive", remote, `${appId}//${channel}`],
    { env: environment },
  );
  const wrapper = path.join(temporaryRoot, "flatpak-electron");
  const profile = path.join(temporaryRoot, "profile");
  const profileArguments = [
    `--filesystem=${profile}`,
    ...["CONFIG", "DATA", "CACHE"].map(
      (role) =>
        `--env=XDG_${role}_HOME=${path.join(profile, role.toLowerCase())}`,
    ),
  ]
    .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
    .join(" ");
  await writeFile(
    wrapper,
    `#!/usr/bin/env bash\nexec flatpak --user run ${profileArguments} ${appId} "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  return { remote, repository, wrapper };
}

async function updateFlatpak(artifact, installation, environment) {
  await run(
    "flatpak",
    ["build-import-bundle", installation.repository, artifact],
    { env: environment },
  );
  await run("flatpak", ["build-update-repo", installation.repository], {
    env: environment,
  });
  await run(
    "flatpak",
    [
      "--user",
      "update",
      "--noninteractive",
      "--no-related",
      `${appId}//${channel}`,
    ],
    { env: environment },
  );
}

async function flatpakCommit(environment, remote) {
  const installed = (
    await capture("flatpak", ["--user", "info", "--show-commit", appId], {
      env: environment,
    })
  ).stdout.trim();
  const available = (
    await capture(
      "flatpak",
      [
        "--user",
        "remote-info",
        "--show-commit",
        remote,
        `${appId}//${channel}`,
      ],
      { env: environment },
    )
  ).stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(installed) || !/^[0-9a-f]{64}$/.test(available)) {
    throw new Error(
      "Flatpak did not report valid installed and remote commits",
    );
  }
  if (installed !== available) {
    throw new Error(
      `Flatpak installed commit ${installed} differs from remote ${available}`,
    );
  }
  return installed;
}

async function packageManagerIdentity() {
  const packageName = productName.toLowerCase();
  if (backend === "deb") {
    return (
      await capture("dpkg-query", ["-W", "-f=${Version}", packageName])
    ).stdout.trim();
  }
  if (backend === "rpm") {
    return (
      await capture("rpm", ["-q", "--qf", "%{VERSION}-%{RELEASE}", packageName])
    ).stdout.trim();
  }
  return null;
}

async function runSpec({ artifact, executable, phase, profile, environment }) {
  const runtime = process.env.MYOXUS_UPDATE_E2E_PLAYWRIGHT_ROOT;
  // Playwright's case deadline cannot bound a stuck Electron/feed teardown.
  // Reuse the packaging owner's cross-platform process-tree cleanup outside it.
  await runProcess({
    command: process.execPath,
    args: [
      ...(runtime
        ? [path.join(runtime, "node_modules/playwright/cli.js")]
        : [
            path.join(repoRoot, ".yarn/releases/yarn-4.18.0.cjs"),
            "playwright",
          ]),
      "test",
      "tests/client/desktop/electron/e2e/update-lifecycle.spec.ts",
      "--config",
      "tests/client/desktop/electron/playwright.config.ts",
      "--reporter=list",
    ],
    cwd: repoRoot,
    timeoutMs: 180_000,
    env: {
      ...environment,
      ...(runtime ? { NODE_PATH: path.join(runtime, "node_modules") } : {}),
      MYOXUS_UPDATE_E2E_ARCH: arch,
      MYOXUS_UPDATE_E2E_ARTIFACT: artifact,
      MYOXUS_UPDATE_E2E_BACKEND: backend,
      MYOXUS_UPDATE_E2E_CHANNEL: channel,
      MYOXUS_UPDATE_E2E_EVIDENCE: evidenceDirectory,
      MYOXUS_UPDATE_E2E_EXECUTABLE: executable,
      MYOXUS_UPDATE_E2E_FEED_PORT: String(feedPort),
      MYOXUS_UPDATE_E2E_PHASE: phase,
      MYOXUS_UPDATE_E2E_PLATFORM: platform,
      MYOXUS_UPDATE_E2E_PROFILE: profile,
      MYOXUS_UPDATE_E2E_SOURCE_VERSION: sourceVersion,
      MYOXUS_UPDATE_E2E_TARGET_VERSION: targetVersion,
    },
  });
}

async function killRelaunchedApplication(profile, executable) {
  if (process.platform === "win32") {
    await run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$executable=$env:MYOXUS_UPDATE_OWNED_EXE;",
          "Get-CimInstance Win32_Process |",
          "Where-Object { $_.ExecutablePath -and [String]::Equals($_.ExecutablePath, $executable, [StringComparison]::OrdinalIgnoreCase) } |",
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
        ].join(" "),
      ],
      { env: { ...process.env, MYOXUS_UPDATE_OWNED_EXE: executable } },
    );
    return;
  }
  const { stdout } = await capture("ps", ["-eo", "pid=,args="]);
  const pids = stdout
    .split("\n")
    .filter((line) => line.includes(profile) || line.includes(executable))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  const remaining = new Set(pids);
  while (remaining.size > 0 && Date.now() < deadline) {
    for (const pid of remaining) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") remaining.delete(pid);
        else throw error;
      }
    }
    if (remaining.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  for (const pid of remaining) {
    process.kill(pid, "SIGKILL");
  }
}

const lockRoot = path.join(tmpdir(), "myoxus-electron-update-e2e-locks");
// Shared OS-package locks protect installation, not isolated fixture builds.
const lockKey = buildOnly
  ? `build-${cellId}`
  : platform === "windows"
    ? `windows-registration-${channel}`
    : backend === "deb"
      ? "debian-package-manager"
      : backend === "rpm"
        ? "rpm-package-manager"
        : cellId;
const lockDirectory = path.join(lockRoot, lockKey);
await mkdir(lockRoot, { recursive: true });
await acquireHostLock(lockDirectory);
let temporaryRoot;
let runtimeTemporaryRoot;
try {
  await assertPortAvailable(feedPort);
  temporaryRoot = await mkdtemp(
    path.join(temporaryBase, "myoxus-electron-update-e2e-"),
  );
  // Chromium binds AF_UNIX sockets below TMPDIR (limited to ~108 bytes on
  // Linux). Only this small runtime scratch belongs in short /tmp paths.
  if (process.platform === "linux") {
    runtimeTemporaryRoot = await mkdtemp("/tmp/myoxus-run-");
  }
  await rm(evidenceDirectory, { force: true, recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });
} catch (error) {
  if (runtimeTemporaryRoot)
    await rm(runtimeTemporaryRoot, { recursive: true, force: true });
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  await rm(lockDirectory, { force: true, recursive: true });
  throw error;
}
const sourceRoot = path.join(temporaryRoot, "source");
const runtimeEnvironment = {
  ...process.env,
  ...(process.platform === "win32"
    ? {
        APPDATA: path.join(temporaryRoot, "appdata", "roaming"),
        LOCALAPPDATA: path.join(temporaryRoot, "appdata", "local"),
        TEMP: path.join(temporaryRoot, "tmp"),
        TMP: path.join(temporaryRoot, "tmp"),
      }
    : {
        HOME: path.join(temporaryRoot, "home"),
        TMPDIR: runtimeTemporaryRoot ?? path.join(temporaryRoot, "tmp"),
      }),
  XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
  XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg-config"),
  XDG_DATA_HOME: path.join(temporaryRoot, "xdg-data"),
};
await Promise.all(
  [
    runtimeEnvironment.APPDATA,
    runtimeEnvironment.HOME,
    runtimeEnvironment.LOCALAPPDATA,
    runtimeEnvironment.TEMP,
    runtimeEnvironment.TMP,
    runtimeEnvironment.TMPDIR,
    runtimeEnvironment.XDG_CACHE_HOME,
    runtimeEnvironment.XDG_CONFIG_HOME,
    runtimeEnvironment.XDG_DATA_HOME,
  ]
    .filter(Boolean)
    .map((directory) => mkdir(directory, { recursive: true })),
);
let cleanupFailed = false;
const cleanup = [
  async () => {
    if (!keepTemporary && !cleanupFailed) {
      await rm(temporaryRoot, { force: true, recursive: true });
    } else if (cleanupFailed) {
      process.stderr.write(
        `Retained update fixture after failed native cleanup: ${temporaryRoot}\n`,
      );
    }
  },
  async () => {
    await rm(lockDirectory, { force: true, recursive: true });
  },
  async () => {
    if (runtimeTemporaryRoot && !keepTemporary && !cleanupFailed) {
      await rm(runtimeTemporaryRoot, { force: true, recursive: true });
    }
  },
];
let failure;
let electronZipDir;
try {
  if (
    platform === "linux" &&
    ["deb", "rpm"].includes(backend) &&
    !buildOnly &&
    !cleanupOnly
  ) {
    runtimeEnvironment.PATH = await nativeHeadlessPath(
      temporaryRoot,
      process.env.PATH ?? "",
    );
  }
  const { stdout: sourceCommitOutput } = await capture(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot },
  );
  const sourceCommit = sourceCommitOutput.trim();
  // Fail protected host conflicts before a cold two-version build, then check
  // again immediately before installation in case another owner changed state.
  if (platform === "windows")
    await preflightWindowsFixture(repoRoot, temporaryRoot);
  const homebrewFixture =
    backend === "homebrew"
      ? await prepareHomebrew(temporaryRoot, runtimeEnvironment)
      : null;
  const reuse = process.env.MYOXUS_UPDATE_E2E_REUSE_DIR;
  if (
    reuse &&
    backend !== "homebrew" &&
    !["deb", "rpm", "flatpak", "nsis", "zip"].includes(backend)
  )
    throw new Error("Unsupported retained update fixture backend");
  if (!reuse) {
    await run("git", [
      "clone",
      "--shared",
      "--no-checkout",
      repoRoot,
      sourceRoot,
    ]);
    await run("git", ["checkout", "--detach", sourceCommit], {
      cwd: sourceRoot,
    });
    await yarn(sourceRoot, ["install", "--immutable"], {
      ...process.env,
      ...buildTemporaryEnvironment,
    });
    if (backend === "homebrew")
      electronZipDir = await fetchMacRuntimes(sourceRoot);
  }
  const reusedFiles = reuse ? await allFiles(path.resolve(reuse)) : [];
  let nativeFixture = null;
  const retainedSource =
    reuse && (await pathExists(path.join(reuse, "fixture-source.json")))
      ? JSON.parse(
          await readFile(path.join(reuse, "fixture-source.json"), "utf8"),
        )
      : null;
  if (reuse && platform === "linux" && backend !== "flatpak") {
    const manifests = reusedFiles.filter(
      (file) => path.basename(file) === "fixture-build.json",
    );
    if (manifests.length !== 1)
      throw new Error("Expected one native fixture build manifest");
    nativeFixture = JSON.parse(await readFile(manifests[0], "utf8"));
  }
  if (
    nativeFixture &&
    (nativeFixture.schema !== "myoxus.electron-native-update-fixture.v1" ||
      nativeFixture.sourceCommit !==
        (retainedSource?.revision ?? sourceCommit) ||
      nativeFixture.channel !== channel ||
      nativeFixture.artifacts?.length !== 4)
  )
    throw new Error("Native fixture source/channel/inventory differs");
  const packageSource = nativeFixture
    ? (retainedSource ?? { revision: nativeFixture.sourceCommit })
    : reuse
      ? JSON.parse(
          await readFile(path.join(reuse, "fixture-source.json"), "utf8"),
        )
      : null;
  if (reuse && !/^[a-f0-9]{40}$/.test(packageSource?.revision))
    throw new Error("Retained fixture source identity is missing");
  const artifact = async (version, targetArch = arch) => {
    if (!reuse) return buildVersion(sourceRoot, version, targetArch);
    const expected = `myoxus-${version}-${channel}-${platform}-${targetArch}.${artifactFormat}`;
    const matching = reusedFiles.filter(
      (file) => path.basename(file) === expected,
    );
    if (matching.length !== 1)
      throw new Error(`Retained fixture missing ${expected}`);
    const destination = path.join(evidenceDirectory, "artifacts", expected);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(matching[0], destination);
    if (nativeFixture) {
      const recorded = nativeFixture.artifacts.find(
        (file) => file.name === expected,
      );
      const actual = await artifactEvidence(destination);
      if (
        !recorded ||
        actual.sha256 !== recorded.sha256 ||
        actual.size !== recorded.size
      )
        throw new Error(`Native fixture digest differs: ${expected}`);
    } else if (platform === "macos")
      await run("hdiutil", ["verify", destination]);
    return destination;
  };
  const sourceArtifact = await artifact(sourceVersion);
  const targetArtifact = await artifact(targetVersion);
  const armSource =
    backend === "homebrew" ? await artifact(sourceVersion, "arm64") : null;
  const armTarget =
    backend === "homebrew" ? await artifact(targetVersion, "arm64") : null;
  const artifacts = {
    source: await artifactEvidence(sourceArtifact),
    target: await artifactEvidence(targetArtifact),
    ...(backend === "homebrew"
      ? {
          armSource: await artifactEvidence(armSource),
          armTarget: await artifactEvidence(armTarget),
        }
      : {}),
  };
  if (reuse) {
    const scans = reusedFiles.filter(
      (file) => path.basename(file) === "production-bundle-scan.json",
    );
    if (
      scans.length !== 1 ||
      JSON.parse(await readFile(scans[0], "utf8")).result !== "absent"
    )
      throw new Error("Retained production control was not verified");
    await copyFile(
      scans[0],
      path.join(evidenceDirectory, "production-bundle-scan.json"),
    );
  } else await buildProductionControl(sourceRoot);

  if (cleanupOnly) {
    const status = await removeKnownNativePredecessor(sourceArtifact);
    await writeFile(
      path.join(evidenceDirectory, "cleanup.json"),
      JSON.stringify(
        {
          backend,
          channel,
          status,
          sourceCommit: packageSource?.revision ?? sourceCommit,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `Owned fixture cleanup: ${status}; no upgrade acceptance was performed`,
    );
  } else if (buildOnly) {
    await stageNativeFixtureRuntime(sourceCommit);
  } else {
    const profile = path.join(temporaryRoot, "profile");
    await mkdir(profile, { recursive: true });
    if (backend === "homebrew") {
      await runHomebrewLifecycle({
        sourceArtifact,
        targetArtifact,
        armSource,
        armTarget,
        temporaryRoot,
        profile,
        runtimeEnvironment,
        cleanup,
        homebrewFixture,
      });
    } else if (backend === "flatpak") {
      const installation = await installFlatpak(
        sourceArtifact,
        temporaryRoot,
        runtimeEnvironment,
        cleanup,
      );
      const sourceFlatpakCommit = await flatpakCommit(
        runtimeEnvironment,
        installation.remote,
      );
      await runSpec({
        executable: installation.wrapper,
        phase: "external-before",
        profile,
        environment: runtimeEnvironment,
      });
      await updateFlatpak(targetArtifact, installation, runtimeEnvironment);
      const targetFlatpakCommit = await flatpakCommit(
        runtimeEnvironment,
        installation.remote,
      );
      if (sourceFlatpakCommit === targetFlatpakCommit) {
        throw new Error("Flatpak N and N+1 resolved to the same OSTree commit");
      }
      await runSpec({
        executable: installation.wrapper,
        phase: "external-after",
        profile,
        environment: runtimeEnvironment,
      });
      await writeFile(
        path.join(evidenceDirectory, "flatpak-activation.json"),
        `${JSON.stringify(
          {
            appId,
            branch: channel,
            remote: installation.remote,
            sourceCommit: sourceFlatpakCommit,
            sourceVersion,
            targetCommit: targetFlatpakCommit,
            targetVersion,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const installed =
        backend === "nsis"
          ? await installWindowsNsis(sourceArtifact, temporaryRoot, cleanup)
          : backend === "zip"
            ? await extractWindowsZip(sourceArtifact, temporaryRoot, cleanup)
            : await installLinuxPackage(sourceArtifact, cleanup);
      await access(installed.executable);
      await access(installed.asar);
      const originalAsar = await sha256(installed.asar);
      const originalPackageIdentity = await packageManagerIdentity();
      await runSpec({
        artifact: targetArtifact,
        executable: installed.executable,
        phase: "update",
        profile,
        environment: runtimeEnvironment,
      });
      if (backend !== "zip") {
        await waitForAsarChange(installed.asar, originalAsar);
        const activatedAsar = await sha256(installed.asar);
        const activatedPackageIdentity = await packageManagerIdentity();
        if (
          originalPackageIdentity &&
          activatedPackageIdentity === originalPackageIdentity
        ) {
          throw new Error(
            `${backend} package identity did not change after activation`,
          );
        }
        await killRelaunchedApplication(profile, installed.executable);
        await runSpec({
          executable: installed.executable,
          phase: "verify",
          profile,
          environment: runtimeEnvironment,
        });
        await writeFile(
          path.join(evidenceDirectory, "installer-activation.json"),
          `${JSON.stringify(
            {
              activatedAsar,
              activatedPackageIdentity,
              backend,
              originalAsar,
              originalPackageIdentity,
              sourceVersion,
              targetVersion,
            },
            null,
            2,
          )}\n`,
        );
      }
    }
    await writeFile(
      path.join(evidenceDirectory, "owner.json"),
      `${JSON.stringify(
        {
          ...plan,
          artifacts,
          sourceCommit: packageSource?.revision ?? sourceCommit,
          ...(packageSource
            ? {
                harnessSourceCommit: sourceCommit,
                retainedFixture: packageSource,
              }
            : {}),
          status: "passed",
        },
        null,
        2,
      )}\n`,
    );
  }
} catch (error) {
  failure = error;
} finally {
  if (keepTemporary) {
    process.stderr.write(
      `Preserved temporary update E2E root: ${temporaryRoot}\n`,
    );
    if (runtimeTemporaryRoot)
      process.stderr.write(
        `Preserved runtime scratch: ${runtimeTemporaryRoot}\n`,
      );
  }
  const cleanupErrors = [];
  for (const action of cleanup.reverse()) {
    try {
      await action();
    } catch (error) {
      cleanupFailed = true;
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    const ownerPath = path.join(evidenceDirectory, "owner.json");
    if (await pathExists(ownerPath)) {
      const owner = JSON.parse(await readFile(ownerPath, "utf8"));
      await writeFile(
        ownerPath,
        JSON.stringify(
          { ...owner, status: "failed", cleanup: "failed" },
          null,
          2,
        ) + "\n",
      );
    }
    failure = new AggregateError(
      failure ? [failure, ...cleanupErrors] : cleanupErrors,
      `Update E2E cleanup failed for ${cellId}`,
    );
  }
}
if (failure) throw failure;
