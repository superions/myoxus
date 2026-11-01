#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditBundleLinks,
  parseMachOLoadCommands,
  verifyMachODependencies,
} from "./verify-macos-bundle-closure.mjs";

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "myoxus-bundle-closure-")),
  );
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const images = new Map();
  async function image(
    relative,
    dependencies = [],
    rpaths = [],
    executable = false,
  ) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "fixture");
    images.set(file, { dependencies, rpaths, executable });
    return file;
  }
  const mainExecutable = await image(
    "Contents/MacOS/Myoxus",
    [],
    ["@executable_path/../Frameworks"],
    true,
  );
  return { root, images, image, mainExecutable };
}

test("relative framework links survive relocation and deletion of the source", async (t) => {
  const f = await fixture(t);
  await f.image("Contents/Frameworks/Electron.framework/Versions/A/Electron");
  const framework = path.join(f.root, "Contents/Frameworks/Electron.framework");
  await fs.symlink("A", path.join(framework, "Versions/Current"));
  await fs.symlink(
    "Versions/Current/Electron",
    path.join(framework, "Electron"),
  );
  const destination = `${f.root}-copy`;
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  await fs.cp(f.root, destination, { recursive: true, verbatimSymlinks: true });
  await fs.rm(f.root, { recursive: true });
  await auditBundleLinks(destination);
  assert.equal(
    await fs.readFile(
      path.join(destination, "Contents/Frameworks/Electron.framework/Electron"),
      "utf8",
    ),
    "fixture",
  );
});

test("default fs.cp reproduces the original absolute-link defect while source still exists", async (t) => {
  const f = await fixture(t);
  await fs.symlink("Myoxus", path.join(f.root, "Contents/MacOS/alias"));
  const destination = `${f.root}-bad-copy`;
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  await fs.cp(f.root, destination, { recursive: true });
  await assert.rejects(auditBundleLinks(destination), /absolute symlink/);
});

for (const [name, target, pattern] of [
  ["absolute even inside app", "/absolute", /absolute symlink/],
  ["outside app", "../../../../outside", /escaping symlink/],
  ["missing", "missing", /broken\/cyclic/],
  ["cyclic", "bad", /broken\/cyclic/],
])
  test(`rejects ${name} symlinks`, async (t) => {
    const f = await fixture(t);
    await fs.symlink(
      target === "/absolute" ? f.mainExecutable : target,
      path.join(f.root, "Contents/MacOS/bad"),
    );
    await assert.rejects(auditBundleLinks(f.root), pattern);
  });

test("parses strong, weak and re-exported dependencies without treating LC_ID_DYLIB as an import", () => {
  const value = parseMachOLoadCommands(
    `image:\nLoad command 0\n cmd LC_ID_DYLIB\n name self (offset 24)\nLoad command 1\n cmd LC_RPATH\n path @loader_path/../Frameworks (offset 12)\nLoad command 2\n cmd LC_LOAD_DYLIB\n name @rpath/Electron Framework.framework/Electron Framework (offset 24)\nLoad command 3\n cmd LC_LOAD_WEAK_DYLIB\n name /System/Library/Frameworks/Optional.framework/Optional (offset 24)\nLoad command 4\n cmd LC_REEXPORT_DYLIB\n name @loader_path/libchild.dylib (offset 24)\nLoad command 5\n cmd LC_MAIN\n entryoff 123`,
  );
  assert.equal(value.executable, true);
  assert.deepEqual(value.rpaths, ["@loader_path/../Frameworks"]);
  assert.equal(value.dependencies.length, 3);
  assert.ok(!value.dependencies.includes("self"));
  assert.throws(
    () =>
      parseMachOLoadCommands("Load command 0\n cmd LC_LOAD_DYLIB\n malformed"),
    /Cannot parse/,
  );
});

test("resolves transitive loader/rpath chains and permits shared-cache OS libraries", async (t) => {
  const f = await fixture(t);
  f.images
    .get(f.mainExecutable)
    .dependencies.push(
      "@rpath/Electron.framework/Electron",
      "/usr/lib/libSystem.B.dylib",
    );
  await f.image(
    "Contents/Frameworks/Electron.framework/Electron",
    ["@rpath/libchild.dylib"],
    ["@loader_path/Libraries"],
  );
  await f.image(
    "Contents/Frameworks/Electron.framework/Libraries/libchild.dylib",
    ["/System/Library/Frameworks/AppKit.framework/AppKit"],
  );
  await f.image("Contents/Resources/addon.node", ["/usr/lib/libc++.1.dylib"]);
  assert.equal(await verifyMachODependencies(f), 4);
});

test("missing framework binary fails despite its directory existing", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(
    path.join(f.root, "Contents/Frameworks/Electron.framework/Versions/A"),
    { recursive: true },
  );
  f.images
    .get(f.mainExecutable)
    .dependencies.push("@rpath/Electron.framework/Electron");
  await assert.rejects(
    verifyMachODependencies(f),
    /Unresolved dependency.*Electron/,
  );
});

test("does not borrow a different executable's rpaths", async (t) => {
  const f = await fixture(t);
  f.images
    .get(f.mainExecutable)
    .dependencies.push("@rpath/libonly-helper.dylib");
  await f.image(
    "Contents/Helpers/Helper",
    [],
    ["@loader_path/Libraries"],
    true,
  );
  await f.image("Contents/Helpers/Libraries/libonly-helper.dylib");
  await assert.rejects(
    verifyMachODependencies(f),
    /Unresolved dependency.*libonly-helper/,
  );
});

for (const dependency of [
  "/opt/homebrew/lib/libbad.dylib",
  "/usr/local/lib/libbad.dylib",
  "/usr/lib/../../opt/libbad.dylib",
  "@loader_path/../../../outside.dylib",
  "librelative.dylib",
]) {
  test(`rejects non-bundled native binding dependency ${dependency}`, async (t) => {
    const f = await fixture(t);
    await f.image("Contents/Resources/addon.node", [dependency]);
    await assert.rejects(verifyMachODependencies(f), /External|escapes/);
  });
}

test("checks unused unsafe LC_RPATH and missing transitive dependencies", async (t) => {
  const f = await fixture(t);
  const addon = await f.image(
    "Contents/Resources/addon.node",
    [],
    ["/opt/homebrew/lib"],
  );
  await assert.rejects(verifyMachODependencies(f), /External/);
  f.images.get(addon).rpaths = [];
  f.images.get(addon).dependencies = ["@loader_path/missing.dylib"];
  await assert.rejects(verifyMachODependencies(f), /Unresolved dependency/);
});
