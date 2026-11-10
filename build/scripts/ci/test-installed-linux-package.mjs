// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { deflateSync } from "node:zlib";
import {
  fatalRendererEvent,
  ready,
  startupProbe,
  verifyPackage,
  paintedScreenshot,
  rpmInstallAction,
} from "./verify-installed-linux-package.mjs";

test("RPM probes replace equal versions and install the exact changed artifact", () => {
  assert.equal(rpmInstallAction("0.41.22-1", null), "install");
  assert.equal(rpmInstallAction("0.41.22-1", "0.41.19-1"), "install");
  assert.equal(rpmInstallAction("0.41.22-1", "0.41.22-1"), "reinstall");
  assert.equal(
    rpmInstallAction("0.41.22-0.beta.2", "0.41.22-0.beta.1"),
    "install",
  );
});

test("owned native recovery proves version, bytes and inactivity before removal", async () => {
  const source = fs.readFileSync(
    new URL("./run-electron-update-e2e.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function removeKnownNativePredecessor(");
  const end = source.indexOf("\nasync function installLinuxPackage(", start);
  assert.ok(start >= 0 && end > start);
  // The CLI module performs host operations at top level. Isolate its actual
  // ownership guard, not the package manager, inside the existing VM fixture.
  async function exercise(backend, overrides = {}) {
    const fixture = {
      version: backend === "deb" ? "9000.0.0~beta.1" : "9000.0.0-0.beta.1",
      hash: "a".repeat(64),
      running: 1,
      query: 0,
      alias: false,
      ...overrides,
    };
    let removed = false;
    const writes = [];
    const cleanup = vm.runInNewContext(
      `${source.slice(start, end)}\nremoveKnownNativePredecessor`,
      {
        path: path.posix,
        productName: "Myoxus-beta",
        backend,
        realpath: async (file) => (fixture.alias ? `${file}.foreign` : file),
        sha256: async () => fixture.hash,
        runStatus: async (command) =>
          command === "pgrep" ? fixture.running : removed ? 1 : fixture.query,
        capture: async (command, args) => ({
          stdout:
            command === "bash"
              ? `${"a".repeat(64)}  -\n`
              : command === "dpkg-deb" ||
                  (command === "rpm" && args[0] === "-qp")
                ? backend === "deb"
                  ? "9000.0.0~beta.1"
                  : "9000.0.0-0.beta.1"
                : fixture.version,
        }),
        run: async (command, args) => {
          writes.push([command, ...args]);
          removed = true;
        },
      },
    );
    return { result: cleanup("/owned/fixture.deb"), writes };
  }
  for (const backend of ["deb", "rpm"]) {
    for (const foreign of [
      { version: "0.41.23" },
      { hash: "b".repeat(64) },
      { running: 0 },
      { running: 2 },
      { query: 2 },
      { alias: true },
    ]) {
      const { result, writes } = await exercise(backend, foreign);
      await assert.rejects(result, /Refusing|Could not/);
      assert.deepEqual(writes, []);
    }
    const owned = await exercise(backend);
    assert.equal(await owned.result, "removed");
    assert.deepEqual(
      owned.writes.map((row) => Array.from(row)),
      [
        [
          "sudo",
          "-n",
          backend === "deb" ? "apt-get" : "dnf",
          backend === "deb" ? "purge" : "remove",
          "-y",
          "myoxus-beta",
        ],
      ],
    );
  }
});

test("blank compositor frames never qualify as screenshot evidence", () => {
  function png(pixels) {
    const header = Buffer.alloc(33);
    header.writeUInt32BE(1, 16);
    header.writeUInt32BE(2, 20);
    header[24] = 8;
    header[25] = 2;
    header.writeUInt32BE(13, 8);
    const data = deflateSync(Buffer.from(pixels));
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write("IDAT", 4);
    data.copy(chunk, 8);
    return Buffer.concat([header, chunk]);
  }
  assert.equal(
    paintedScreenshot(png([0, 242, 243, 245, 0, 242, 243, 245])),
    false,
  );
  assert.equal(paintedScreenshot(png([0, 242, 243, 245, 2, 0, 0, 0])), false);
  assert.equal(paintedScreenshot(png([0, 242, 243, 245, 2, 1, 0, 0])), true);
});

async function probe({
  main = true,
  active = true,
  controls = true,
  hidden = false,
  error = false,
} = {}) {
  const element = {
    closest: () => false,
    getBoundingClientRect: () => ({ width: 120, height: 30 }),
  };
  const view = JSON.parse(
    await vm.runInNewContext(startupProbe, {
      window: {
        __appInfo: { windowName: main ? "main" : "shell", viewId: "app-test" },
        __apis: { ui: { isActiveTab: async () => active } },
      },
      document: {
        title: "Myoxus",
        querySelectorAll: (selector) =>
          selector.includes("error-detail")
            ? error
              ? [element]
              : []
            : controls
              ? [element]
              : [],
      },
      location: { href: "assets://app/index.html" },
      getComputedStyle: () => ({
        display: hidden ? "none" : "block",
        visibility: "visible",
        opacity: "1",
      }),
    }),
  );
  return view;
}

test("actual probe accepts active product controls, not text or a shell", async () => {
  assert.equal(ready(await probe()), true);
  for (const fixture of [
    { main: false },
    { active: false },
    { controls: false },
    { hidden: true },
    { error: true },
  ])
    assert.equal(ready(await probe(fixture)), false, JSON.stringify(fixture));
  assert.equal(ready({ main: true, text: "A fatal error occurred" }), false);
  assert.equal(
    ready({ ...(await probe()), url: "http://localhost:8080" }),
    false,
  );
});

test("renderer exceptions and error events cannot be mistaken for successful startup", () => {
  for (const event of [
    { method: "Runtime.exceptionThrown" },
    { method: "Log.entryAdded", params: { entry: { level: "error" } } },
    { method: "Runtime.consoleAPICalled", params: { type: "error" } },
  ])
    assert.equal(fatalRendererEvent(event), true);
  assert.equal(
    fatalRendererEvent({
      method: "Log.entryAdded",
      params: { entry: { level: "warning" } },
    }),
    false,
  );
});

test("installed startup preserves sandbox attachment and screenshot prerequisites", () => {
  const source = fs.readFileSync(
    new URL("./verify-installed-linux-package.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes('await request("Page.enable")'));
  assert.ok(source.includes("Date.now() - seen < 1000"));
  assert.ok(source.includes("process.kill(-child.pid, signal)"));
  assert.ok(
    source.includes('"--kill-after=10s", "300s"') ||
      /"--kill-after=10s",\s*"300s"/.test(source),
  );
  assert.ok(!source.includes('"--no-sandbox"'));
});

test("only the exact checksum-bound format/version/channel artifact is installable", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "myoxus-package-contract-"),
  );
  try {
    fs.mkdirSync(path.join(root, "linux"));
    const relative = "linux/myoxus-0.41.19-stable-linux-x64.deb";
    fs.writeFileSync(path.join(root, relative), "test package bytes");
    const hash = createHash("sha256")
      .update("test package bytes")
      .digest("hex");
    const checksum = `${hash}  ${relative}\n`;
    fs.writeFileSync(path.join(root, "SHA256SUMS"), checksum);
    assert.equal(verifyPackage(root, "deb", "0.41.19", "stable").sha256, hash);
    assert.throws(() => verifyPackage(root, "rpm", "0.41.19", "stable"));
    assert.throws(() => verifyPackage(root, "deb", "../bad", "stable"));
    assert.throws(() => verifyPackage(root, "deb", "0.41.19", "bogus"));
    fs.writeFileSync(path.join(root, "SHA256SUMS"), checksum + checksum);
    assert.throws(
      () => verifyPackage(root, "deb", "0.41.19", "stable"),
      /duplicate/,
    );
    fs.writeFileSync(path.join(root, "SHA256SUMS"), checksum);
    fs.writeFileSync(path.join(root, relative), "tampered bytes");
    assert.throws(
      () => verifyPackage(root, "deb", "0.41.19", "stable"),
      /checksum/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
