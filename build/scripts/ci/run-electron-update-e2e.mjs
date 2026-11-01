// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const keepTemporary = args.has("--keep-temporary");

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
    platforms: ["arm64", "x64"],
    backends: ["macos"],
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

const versions = {
  stable: ["9000.0.0", "9000.0.1"],
  beta: ["9000.0.0-beta.1", "9000.0.0-beta.2"],
  internal: ["9000.0.0-internal.1", "9000.0.0-internal.2"],
};
const [sourceVersion, targetVersion] = versions[channel];
const cellId = `${platform}-${arch}-${backend}-${channel}`;
const channelIndex = ["stable", "beta", "internal"].indexOf(channel);
const feedCellIndex =
  platform === "linux"
    ? ["deb", "flatpak", "rpm"].indexOf(backend) * 3 + channelIndex
    : platform === "macos"
      ? 9 + ["arm64", "x64"].indexOf(arch) * 3 + channelIndex
      : 15 + ["nsis", "zip"].indexOf(backend) * 3 + channelIndex;
const feedPort = 44000 + feedCellIndex;
const feedUrl = `https://127.0.0.1:${feedPort}/api/v1/repos/myoxus/packages/releases?page=1&limit=50`;
const productName = channel === "stable" ? "Myoxus" : `Myoxus-${channel}`;
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
  sourceFormat: backend === "macos" ? "dmg" : backend,
  sourceVersion,
  targetFormat: backend === "macos" ? "zip" : backend,
  targetVersion,
  updateMode:
    backend === "flatpak"
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
if (
  platform === "macos" &&
  (!process.env.APPLE_SIGNING_IDENTITY ||
    !process.env.APPLE_ID ||
    !process.env.APPLE_PASSWORD ||
    !process.env.APPLE_TEAM_ID)
) {
  throw new Error(
    "macOS update E2E requires signing and notarization credentials for both N and N+1",
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
    throw new Error("Synthetic source clone is dirty before packaging");
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

async function buildVersion(sourceRoot, version) {
  await setSyntheticVersion(sourceRoot, version);
  const environment = {
    ...process.env,
    BUILD_TYPE: channel,
    DISTRIBUTION: "desktop",
    ELECTRON_E2E: "1",
    ELECTRON_E2E_UPDATE_FEED: feedUrl,
    NODE_ENV: "production",
    SKIP_WEB_BUILD: "1",
    ...(backend === "deb" || backend === "rpm" || backend === "nsis"
      ? { ELECTRON_E2E_PACKAGE_TYPE: backend }
      : {}),
  };
  await yarn(
    sourceRoot,
    ["workspace", "@myoxus/electron", "build"],
    environment,
  );
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
  const stage = path.join(
    sourceRoot,
    "client/apps/electron/out",
    channel,
    "stage",
    `${contract.packagingPlatform}-${arch}`,
    "app",
  );
  await assertTreeContains(stage, feedUrl);
  const packagedApp = path.join(
    sourceRoot,
    "client/apps/electron/out",
    channel,
    `${productName}-${contract.packagingPlatform}-${arch}`,
  );
  await assertTreeContains(packagedApp, feedUrl);
  await assertTreeContains(packagedApp, "electronE2e=true");

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
        arch,
      ],
      { ...environment, LINUX_TARGETS: backend },
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
        arch,
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
        arch,
      ],
      environment,
    );
  }

  const extension =
    backend === "macos"
      ? version === sourceVersion
        ? "dmg"
        : "zip"
      : backend === "nsis"
        ? "exe"
        : backend;
  const expected = `myoxus-${version}-${channel}-${platform}-${arch}.${extension}`;
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
  return destination;
}

async function buildProductionControl(sourceRoot) {
  const environment = {
    ...process.env,
    BUILD_TYPE: channel,
    DISTRIBUTION: "desktop",
    NODE_ENV: "production",
    SKIP_WEB_BUILD: "1",
  };
  delete environment.ELECTRON_E2E;
  delete environment.ELECTRON_E2E_PACKAGE_TYPE;
  delete environment.ELECTRON_E2E_UPDATE_FEED;
  await yarn(
    sourceRoot,
    ["workspace", "@myoxus/electron", "build"],
    environment,
  );
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
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
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
    await cp(path.join(mount, app), path.join(applications, app), {
      recursive: true,
    });
    const bundle = path.join(applications, app);
    return {
      asar: path.join(bundle, "Contents/Resources/app.asar"),
      executable: path.join(bundle, `Contents/MacOS/${productName}`),
    };
  } finally {
    await run("hdiutil", ["detach", mount]);
  }
}

async function installWindowsNsis(artifact, temporaryRoot, cleanup) {
  const installRoot = path.join(temporaryRoot, "installed");
  let installationCompleted = false;
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
    await run(uninstallers[0], ["/S"]);
  });
  await run(artifact, ["/S", `/D=${installRoot}`]);
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

async function extractWindowsZip(artifact, temporaryRoot) {
  const installRoot = path.join(temporaryRoot, "portable");
  await mkdir(installRoot, { recursive: true });
  await run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
    artifact,
    installRoot,
  ]);
  const executable = (await allFiles(installRoot)).find(
    (candidate) => path.basename(candidate) === `${productName}.exe`,
  );
  if (!executable) throw new Error("Windows ZIP contains no Myoxus executable");
  return {
    asar: path.join(path.dirname(executable), "resources", "app.asar"),
    executable,
  };
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
      `Refusing to replace pre-existing host package ${packageName}`,
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
    if (
      (await runStatus("flatpak", ["--user", "remote-ls", remote], {
        env: environment,
      })) !== 0
    ) {
      return;
    }
    await run("flatpak", ["--user", "remote-delete", "--force", remote], {
      env: environment,
    });
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
  await run(
    "flatpak",
    ["--user", "install", "--noninteractive", remote, `${appId}//${channel}`],
    { env: environment },
  );
  const wrapper = path.join(temporaryRoot, "flatpak-electron");
  await writeFile(
    wrapper,
    `#!/usr/bin/env bash\nexec flatpak --user run ${appId} "$@"\n`,
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
  await yarn(
    repoRoot,
    [
      "playwright",
      "test",
      "tests/client/desktop/electron/e2e/update-lifecycle.spec.ts",
      "--config",
      "tests/client/desktop/electron/playwright.config.ts",
      "--reporter=list",
    ],
    {
      ...environment,
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
  );
}

async function killRelaunchedApplication(profile, executable) {
  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$profile=$args[0]; $executable=$args[1];",
        "Get-CimInstance Win32_Process |",
        "Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($profile) -or $_.CommandLine.Contains($executable)) } |",
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ].join(" "),
      profile,
      executable,
    ]);
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
const lockKey =
  backend === "deb"
    ? "debian-package-manager"
    : backend === "rpm"
      ? "rpm-package-manager"
      : cellId;
const lockDirectory = path.join(lockRoot, lockKey);
await mkdir(lockRoot, { recursive: true });
await acquireHostLock(lockDirectory);
let temporaryRoot;
try {
  await assertPortAvailable(feedPort);
  temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "myoxus-electron-update-e2e-"),
  );
  await rm(evidenceDirectory, { force: true, recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });
} catch (error) {
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
        TMPDIR: path.join(temporaryRoot, "tmp"),
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
const cleanup = [
  async () => {
    if (!keepTemporary) {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  },
  async () => {
    await rm(lockDirectory, { force: true, recursive: true });
  },
];
let failure;
try {
  const { stdout: sourceCommitOutput } = await capture(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot },
  );
  const sourceCommit = sourceCommitOutput.trim();
  await run("git", [
    "clone",
    "--shared",
    "--no-checkout",
    repoRoot,
    sourceRoot,
  ]);
  await run("git", ["checkout", "--detach", sourceCommit], { cwd: sourceRoot });
  await yarn(sourceRoot, ["install", "--immutable"], process.env);
  await yarn(
    sourceRoot,
    ["run", "-T", "myoxus", "bundle", "-p", "@myoxus/electron-renderer"],
    { ...process.env, BUILD_TYPE: channel, NODE_ENV: "production" },
  );

  const sourceArtifact = await buildVersion(sourceRoot, sourceVersion);
  const targetArtifact = await buildVersion(sourceRoot, targetVersion);
  const artifacts = {
    source: await artifactEvidence(sourceArtifact),
    target: await artifactEvidence(targetArtifact),
  };
  await buildProductionControl(sourceRoot);

  const profile = path.join(temporaryRoot, "profile");
  await mkdir(profile, { recursive: true });
  if (backend === "flatpak") {
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
      backend === "macos"
        ? await installMacDmg(sourceArtifact, temporaryRoot)
        : backend === "nsis"
          ? await installWindowsNsis(sourceArtifact, temporaryRoot, cleanup)
          : backend === "zip"
            ? await extractWindowsZip(sourceArtifact, temporaryRoot)
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
        sourceCommit,
        status: "passed",
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  failure = error;
} finally {
  if (keepTemporary) {
    process.stderr.write(
      `Preserved temporary update E2E root: ${temporaryRoot}\n`,
    );
  }
  const cleanupErrors = [];
  for (const action of cleanup.reverse()) {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    failure = new AggregateError(
      failure ? [failure, ...cleanupErrors] : cleanupErrors,
      `Update E2E cleanup failed for ${cellId}`,
    );
  }
}
if (failure) throw failure;
