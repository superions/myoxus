#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

// CDP emits 8-bit RGB/RGBA PNGs. Reject a uniform unpainted compositor frame
// without adding a package dependency to the installation runner.
export function paintedScreenshot(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 2 ? 3 : png[25] === 6 ? 4 : 0;
  if (
    !channels ||
    png[24] !== 8 ||
    png[28] !== 0 ||
    width > 4096 ||
    height > 4096
  )
    throw new Error("Unexpected CDP screenshot format");
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
      chunks.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const stride = width * channels;
  const bytes = inflateSync(Buffer.concat(chunks), {
    maxOutputLength: (stride + 1) * height,
  });
  if (bytes.length !== (stride + 1) * height)
    throw new Error("Truncated CDP screenshot");
  let previous = new Uint8Array(stride);
  let first;
  for (let y = 0; y < height; y++) {
    const filter = bytes[y * (stride + 1)];
    if (filter > 4) throw new Error("Unknown PNG filter");
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const diagonal = x >= channels ? previous[x - channels] : 0;
      const p = left + up - diagonal;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) &&
        Math.abs(p - left) <= Math.abs(p - diagonal)
          ? left
          : Math.abs(p - up) <= Math.abs(p - diagonal)
            ? up
            : diagonal;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][
        filter
      ];
      row[x] = bytes[y * (stride + 1) + 1 + x] + predictor;
      if (x % channels === 2) {
        const color = row[x - 2] * 65536 + row[x - 1] * 256 + row[x];
        first ??= color;
        if (color !== first) return true;
      }
    }
    previous = row;
  }
  return false;
}

// Probe the active application view, not the Electron shell or an error page.
// An empty profile legitimately starts at server selection; no login is needed.
export const startupProbe = `(async () => {
  const visible = element => {
    if (!element || element.closest('[inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const has = selector => [...document.querySelectorAll(selector)].some(visible);
  return JSON.stringify({
    main: window.__appInfo?.windowName === 'main' &&
      window.__appInfo?.viewId?.startsWith('app-') === true,
    active: await window.__apis?.ui?.isActiveTab() === true,
    controls: has('[data-testid="connect-standalone-button"], [data-testid="continue-login-button"]') &&
      has('input:not([disabled]):not([type="hidden"])') ||
      has('[data-testid="main-container"]') &&
      has('[data-testid="sidebar-new-page-button"]:not([disabled])'),
    error: has('[data-testid="error-detail"], [data-testid="not-found"], [data-myoxus-error-status]'),
    title: document.title,
    url: location.href,
  });
})()`;

export function ready(view) {
  return (
    view.main === true &&
    view.active === true &&
    view.controls === true &&
    view.error === false &&
    view.url?.startsWith("assets://") === true
  );
}

export function fatalRendererEvent(message) {
  return (
    message.method === "Runtime.exceptionThrown" ||
    (message.method === "Log.entryAdded" &&
      message.params.entry.level === "error") ||
    (message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error")
  );
}

export function verifyPackage(root, kind, version, channel) {
  if (
    !["deb", "rpm"].includes(kind) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? "") ||
    !["stable", "beta", "internal"].includes(channel)
  ) {
    throw new Error("Expected a Linux format, release version and channel");
  }
  const relative = `linux/myoxus-${version}-${channel}-linux-x64.${kind}`;
  const artifact = path.join(root, relative);
  if (!fs.lstatSync(artifact).isFile())
    throw new Error("Package must be a regular file");
  const entries = fs
    .readFileSync(path.join(root, "SHA256SUMS"), "utf8")
    .split("\n")
    .map((line) => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/))
    .filter((entry) => entry?.[2] === relative);
  const sha256 = createHash("sha256")
    .update(fs.readFileSync(artifact))
    .digest("hex");
  if (entries.length !== 1 || entries[0][1] !== sha256) {
    throw new Error(
      `Package checksum mismatch or duplicate entry: ${relative}`,
    );
  }
  return { relative, artifact, sha256 };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 320_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }
  return result.stdout.trim();
}

export function rpmInstallAction(artifactVersion, installedVersion) {
  // DNF reinstall only accepts an already installed version; install performs
  // the upgrade to a different checksum-bound artifact.
  return installedVersion === artifactVersion ? "reinstall" : "install";
}

async function main() {
  const [directory, kind] = process.argv.slice(2);
  if (!directory)
    throw new Error(
      "Usage: verify-installed-linux-package.mjs <release-dir> <deb|rpm>",
    );
  const version = process.env.MYOXUS_RELEASE_VERSION;
  const channel = process.env.BUILD_TYPE ?? "stable";
  if (process.getuid() === 0)
    throw new Error("Run as the unprivileged installation runner");
  const operatingSystem = fs.readFileSync("/etc/os-release", "utf8");
  const distribution = operatingSystem.match(/^ID="?([^"\n]+)"?$/m)?.[1];
  if (distribution !== (kind === "deb" ? "ubuntu" : "fedora")) {
    throw new Error(`Unexpected installation distribution: ${distribution}`);
  }
  const { relative, artifact, sha256 } = verifyPackage(
    path.resolve(directory),
    kind,
    version,
    channel,
  );
  const evidence = path.resolve(
    process.env.MYOXUS_INSTALL_EVIDENCE ?? `output/linux-install-${kind}`,
  );
  fs.mkdirSync(evidence, { recursive: true });
  for (const file of ["startup.json", "startup.png", "failure.json"])
    fs.rmSync(path.join(evidence, file), { force: true });
  const expectedName = channel === "stable" ? "myoxus" : `myoxus-${channel}`;
  const packageName =
    kind === "deb"
      ? run("dpkg-deb", ["-f", artifact, "Package"])
      : run("rpm", ["-qp", "--qf", "%{NAME}", artifact]);
  if (packageName !== expectedName)
    throw new Error(`Unexpected package name: ${packageName}`);
  const packageVersion =
    kind === "deb"
      ? run("dpkg-deb", ["-f", artifact, "Version"])
      : run("rpm", ["-qp", "--qf", "%{VERSION}-%{RELEASE}", artifact]);
  console.log(`Installing checksum-bound ${relative} (${sha256})`);
  const installedRpm =
    kind === "rpm"
      ? spawnSync("rpm", ["-q", "--qf", "%{VERSION}-%{RELEASE}", packageName], {
          timeout: 10_000,
        })
      : undefined;
  if (installedRpm?.error) throw installedRpm.error;
  if (installedRpm && ![0, 1].includes(installedRpm.status))
    throw new Error("Cannot query installed RPM identity");
  // Timeout runs as root too, so package-manager descendants are killable.
  // Force replacement when this version already exists; a no-op install does
  // not prove the installed files came from the checksum-bound artifact.
  const install =
    kind === "deb"
      ? [
          "env",
          "DEBIAN_FRONTEND=noninteractive",
          "apt-get",
          "install",
          "-y",
          "--reinstall",
          "--no-install-recommends",
          artifact,
        ]
      : [
          "dnf",
          rpmInstallAction(
            packageVersion,
            installedRpm.status === 0
              ? installedRpm.stdout.toString().trim()
              : null,
          ),
          "-y",
          artifact,
        ];
  try {
    const output = run("sudo", [
      "-n",
      "timeout",
      "--kill-after=10s",
      "300s",
      ...install,
    ]);
    fs.writeFileSync(path.join(evidence, "installation.log"), output + "\n");
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, "installation.log"),
      error.message + "\n",
    );
    throw error;
  }
  const installedVersion =
    kind === "deb"
      ? run("dpkg-query", ["-W", "-f=${Version}", packageName])
      : run("rpm", ["-q", "--qf", "%{VERSION}-%{RELEASE}", packageName]);
  if (installedVersion !== packageVersion)
    throw new Error(
      "Installed package version differs from the checked artifact",
    );
  const files =
    kind === "deb"
      ? run("dpkg", ["-L", packageName])
      : run("rpm", ["-ql", packageName]);
  const productName = channel === "stable" ? "Myoxus" : `Myoxus-${channel}`;
  const executable = files
    .split("\n")
    .find(
      (file) =>
        file.startsWith("/opt/") &&
        [productName, expectedName].includes(path.basename(file)) &&
        fs.existsSync(file) &&
        fs.statSync(file).isFile(),
    );
  if (!executable)
    throw new Error("Installed package has no application executable");
  const runtime = fs.mkdtempSync(
    path.join(os.tmpdir(), "myoxus-installed-package-"),
  );
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    SKIP_ONBOARDING: "1",
  };
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "DEV_SERVER_URL",
    "BUILD_TYPE",
    "BUILD_TYPE_OVERRIDE",
  ])
    delete environment[name];
  for (const [name, suffix] of [
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_CACHE_HOME", "cache"],
    ["XDG_DATA_HOME", "data"],
  ])
    environment[name] = path.join(runtime, suffix);
  const log = fs.createWriteStream(path.join(evidence, "application.log"));
  // Own one process group for Xvfb, D-Bus and Electron, including crash paths.
  const child = spawn(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1280x900x24",
      "dbus-run-session",
      "--",
      executable,
      "--remote-debugging-port=0",
      `--user-data-dir=${path.join(runtime, "profile")}`,
      "--no-first-run",
    ],
    { detached: true, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let endpoint;
  let launchError;
  let output = "";
  child.on("error", (error) => {
    launchError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      log.write(chunk);
      output = (output + String(chunk)).slice(-16_384);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) endpoint = new URL(match[1]);
    });
  let socket;
  let sequence = 0;
  const requests = new Map();
  const errors = [];
  function rejectRequests(error) {
    for (const pending of requests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    requests.clear();
  }
  let cleanupPromise;
  function cleanup() {
    cleanupPromise ??= (async () => {
      rejectRequests(new Error("Application probe stopped"));
      socket?.close();
      for (const signal of child.pid ? ["SIGTERM", "SIGKILL"] : []) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        if (signal === "SIGTERM") await delay(1000);
      }
      await new Promise((resolve) => log.end(resolve));
      fs.rmSync(runtime, { recursive: true, force: true });
    })();
    return cleanupPromise;
  }
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ])
    process.once(signal, () => {
      void cleanup().then(() => process.exit(code));
    });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10_000);
      requests.set(id, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        rejectRequests(error);
      }
    });
  }
  function assertAlive() {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Application exited during startup");
    if (errors.length)
      throw new Error(`Renderer startup failure: ${JSON.stringify(errors)}`);
  }
  const deadline = Date.now() + 90_000;
  const firstSeen = new Map();
  let lastView;
  try {
    while (!endpoint && Date.now() < deadline) {
      assertAlive();
      await delay(200);
    }
    if (!endpoint) throw new Error("Application did not expose its renderer");
    let result;
    while (Date.now() < deadline && !result) {
      assertAlive();
      const response = await fetch(`http://${endpoint.host}/json/list`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new Error(`Renderer inventory failed: ${response.status}`);
      const targets = await response.json();
      for (const target of targets.filter(
        (target) =>
          target.type === "page" &&
          target.url?.startsWith("assets://") &&
          !new URL(target.url).pathname.endsWith("/shell.html") &&
          target.webSocketDebuggerUrl,
      )) {
        const seen = firstSeen.get(target.id) ?? Date.now();
        firstSeen.set(target.id, seen);
        // Match packaged-runtime.ts: early Runtime attachment can initialize
        // Electron's sandbox before preload startupData exists and break it.
        if (Date.now() - seen < 1000) continue;
        socket = new WebSocket(target.webSocketDebuggerUrl);
        const connection = socket;
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (fatalRendererEvent(message)) {
            errors.push(message);
          }
          const pending = requests.get(message.id);
          if (!pending) return;
          requests.delete(message.id);
          clearTimeout(pending.timeout);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        });
        socket.addEventListener("close", () => {
          if (socket === connection)
            rejectRequests(new Error("Renderer connection closed"));
        });
        socket.addEventListener("error", () => {
          if (socket === connection)
            rejectRequests(new Error("Renderer connection failed"));
        });
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Renderer connection timed out")),
            5000,
          );
          socket.addEventListener(
            "open",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
          socket.addEventListener(
            "error",
            () => {
              clearTimeout(timeout);
              reject(new Error("Renderer connection failed"));
            },
            { once: true },
          );
        });
        await request("Runtime.enable");
        await request("Page.enable");
        await request("Log.enable");
        const probe = async () => {
          const evaluated = await request("Runtime.evaluate", {
            expression: startupProbe,
            returnByValue: true,
            awaitPromise: true,
          });
          if (evaluated.exceptionDetails)
            throw new Error("Renderer startup probe threw an exception");
          lastView = JSON.parse(evaluated.result.value);
          if (lastView.error)
            throw new Error("Application rendered its error boundary");
          assertAlive();
          return ready(lastView);
        };
        if (await probe()) {
          await delay(1000);
          if (await probe()) {
            const screenshot = await request("Page.captureScreenshot", {
              format: "png",
              captureBeyondViewport: false,
              fromSurface: true,
            });
            assertAlive();
            const pixels = Buffer.from(screenshot.data, "base64");
            if (!paintedScreenshot(pixels)) {
              socket.close();
              socket = undefined;
              await delay(300);
              continue;
            }
            fs.writeFileSync(path.join(evidence, "startup.png"), pixels);
            result = {
              package: relative,
              sha256,
              packageVersion,
              distribution,
              executable,
              sandbox: true,
              ...lastView,
            };
          }
        }
        socket.close();
        socket = undefined;
        if (result) break;
      }
      if (!result) await delay(300);
    }
    if (!result)
      throw new Error(
        `No active product controls rendered: ${JSON.stringify(lastView)}`,
      );
    fs.writeFileSync(
      path.join(evidence, "startup.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      `[PASS] ${relative}: active installed UI, sandbox enabled, no renderer errors`,
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, "failure.json"),
      JSON.stringify({ error: error.message, lastView, errors }, null, 2) +
        "\n",
    );
    throw error;
  } finally {
    await cleanup();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
