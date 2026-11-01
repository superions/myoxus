#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const runtime = process.argv[2];
if (!runtime) {
  // Separate module registries prevent CJS/ESM double-import state from hiding
  // a defect in a published entry point. These are tiny listener checks, not
  // allocator or load probes.
  for (const entry of ["cjs", "esm", "source"]) {
    const result = spawnSync(process.execPath, [import.meta.filename, entry], {
      stdio: "inherit",
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${entry} runtime contract failed`);
  }
} else {
  const files = {
    cjs: "dist/yjs.cjs",
    esm: "dist/yjs.mjs",
    source: "src/index.js",
  };
  assert.ok(Object.hasOwn(files, runtime), `Unknown runtime: ${runtime}`);
  const root =
    process.env.YJS_RUNTIME_BASELINE_DIR ??
    path.dirname(require.resolve("yjs/package.json"));
  const originalRandomValues = webcrypto.getRandomValues;
  let high = 1;
  let low = 5;
  // lib0 captures getRandomValues at import time. Seed before importing the
  // actual published entry point, so reverting uint53 to uint32 must fail.
  webcrypto.getRandomValues = (array) => {
    array.fill(0);
    array[0] = high;
    if (array.length > 1) array[1] = low;
    return array;
  };
  try {
    const file = path.resolve(root, files[runtime]);
    const Y =
      runtime === "cjs"
        ? require(file)
        : await import(pathToFileURL(file).href);
    for (const [hi, lo, expected] of [
      [1, 5, 4294967301],
      [0x1fffff, 0xffffffff, Number.MAX_SAFE_INTEGER],
      [0, 0, 0],
    ]) {
      high = hi;
      low = lo;
      const doc = new Y.Doc({ guid: "deterministic-client-id" });
      assert.equal(doc.clientID, expected, `${runtime}: uint53 generation`);
      doc.destroy();
    }
    const doc = new Y.Doc({ guid: "surviving-document" });
    let destroyed = 0;
    doc.on("destroy", () => {
      destroyed++;
    });
    doc.on("afterTransaction", () => {});
    const listeners = (event) => doc._observers.get(event)?.size ?? 0;
    const baseline = ["destroy", "afterTransaction"].map(listeners);
    const text = doc.getText("text");
    try {
      for (let i = 0; i < 64; i++) {
        const manager = new Y.UndoManager(text);
        assert.deepEqual(
          ["destroy", "afterTransaction"].map(listeners),
          baseline.map((n) => n + 1),
        );
        manager.destroy();
        assert.deepEqual(
          ["destroy", "afterTransaction"].map(listeners),
          baseline,
          `${runtime}: disposed manager retains Doc listeners at cycle ${i}`,
        );
      }
      text.insert(0, "surviving content 😀");
      assert.equal(text.toString(), "surviving content 😀");
    } finally {
      doc.destroy();
    }
    assert.equal(
      destroyed,
      1,
      "Unrelated document listeners must survive manager disposal",
    );
    console.log(
      `[PASS] ${runtime}: deterministic uint53 and 64 manager lifecycles`,
    );
  } finally {
    webcrypto.getRandomValues = originalRandomValues;
  }
}
