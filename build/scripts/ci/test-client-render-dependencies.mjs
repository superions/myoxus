// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import assert from "node:assert/strict";

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import katex from "katex";

const require = createRequire(import.meta.url);

test("Electron updater retains metadata identity and validates persistent cache bytes", async () => {
  const updaterRequire = createRequire(
    require.resolve("electron-updater/package.json"),
  );
  const { DownloadedUpdateHelper } = updaterRequire(
    "./out/DownloadedUpdateHelper.js",
  );
  const directory = mkdtempSync(join(tmpdir(), "myoxus-updater-equality-"));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  try {
    const file = join(directory, "fixture.exe");
    const contents = Buffer.from("controlled updater fixture");
    writeFileSync(file, contents);
    const sha512 = createHash("sha512").update(contents).digest("base64");
    const info = {
      version: "0.41.28",
      files: [{ url: "fixture.exe", sha512, size: contents.length }],
      path: "fixture.exe",
      sha512,
      releaseDate: "2026-10-11T00:00:00.000Z",
      releaseName: "Fixture",
      releaseNotes: "Notes",
    };
    const resolved = {
      url: new URL("https://example.invalid/fixture.exe"),
      info: info.files[0],
    };
    const current = new DownloadedUpdateHelper(directory);
    await current.setDownloadedFile(
      file,
      null,
      info,
      resolved,
      "fixture.exe",
      false,
    );
    // Myoxus's validated feed contains plain records and positive file sizes.
    // Object key order is irrelevant; every identity-bearing edit must reject reuse.
    assert.equal(
      await current.validateDownloadedPath(
        file,
        structuredClone(info),
        {
          ...resolved,
          info: structuredClone(resolved.info),
        },
        logger,
      ),
      file,
    );
    assert.equal(
      await current.validateDownloadedPath(
        file,
        Object.fromEntries(Object.entries(info).reverse()),
        resolved,
        logger,
      ),
      file,
    );
    for (const [field, value] of [
      ["version", "0.41.29"],
      ["releaseDate", "2026-10-12T00:00:00.000Z"],
      ["releaseNotes", "Changed"],
    ]) {
      assert.equal(
        await current.validateDownloadedPath(
          file,
          { ...info, [field]: value },
          resolved,
          logger,
        ),
        null,
        field,
      );
    }
    for (const [field, value] of [
      ["sha512", "changed"],
      ["size", 1024],
      ["url", "other.exe"],
      ["isAdminRightsRequired", true],
    ]) {
      assert.equal(
        await current.validateDownloadedPath(
          file,
          info,
          { ...resolved, info: { ...resolved.info, [field]: value } },
          logger,
        ),
        null,
        field,
      );
    }
    rmSync(file);
    assert.equal(
      await current.validateDownloadedPath(file, info, resolved, logger),
      null,
    );
    const pending = join(directory, "pending");
    mkdirSync(pending);
    const pendingFile = join(pending, "fixture.exe");
    writeFileSync(pendingFile, contents);
    await current.setDownloadedFile(
      pendingFile,
      null,
      info,
      resolved,
      "fixture.exe",
      true,
    );
    assert.equal(
      await new DownloadedUpdateHelper(directory).validateDownloadedPath(
        pendingFile,
        info,
        resolved,
        logger,
      ),
      pendingFile,
    );
    writeFileSync(pendingFile, Buffer.from("tampered"));
    assert.equal(
      await new DownloadedUpdateHelper(directory).validateDownloadedPath(
        pendingFile,
        info,
        resolved,
        logger,
      ),
      null,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("KaTeX rejects inherited trust but preserves explicit trusted options", () => {
  const formula = String.raw`\href{javascript:alert(1)}{x}`;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "trust");
  try {
    // Pollution is an attacker prerequisite in GHSA-238p-pmpm-9mq7, not a
    // behavior caused by KaTeX itself. Exercise the default caller boundary.
    Object.defineProperty(Object.prototype, "trust", {
      configurable: true,
      writable: true,
      value: true,
    });
    assert.doesNotMatch(katex.renderToString(formula), /href="javascript:/);
    assert.match(
      katex.renderToString(formula, { trust: true }),
      /href="javascript:/,
    );
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "trust", previous);
    else delete Object.prototype.trust;
  }
});
