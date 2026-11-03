#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { readZip } from "../zip-archive.mjs";
import * as Y from "yjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fixtureRoot = path.join(
  repoRoot,
  "server/crates/workspace_import/tests/fixtures",
);
const manifest = JSON.parse(
  readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"),
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sqliteInventory(file) {
  const source = String.raw`
import base64, json, sqlite3, sys
connection = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
updates = []
if 'updates' in tables:
    updates = [
        {'docId': row[0], 'data': base64.b64encode(row[1]).decode()}
        for row in connection.execute('SELECT doc_id, data FROM updates ORDER BY id')
    ]
blob_count = connection.execute('SELECT COUNT(*) FROM blobs').fetchone()[0] if 'blobs' in tables else 0
print(json.dumps({'tables': tables, 'updates': updates, 'blobCount': blob_count}))
connection.close()
`;
  const result = spawnSync("python3", ["-c", source, file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`failed to inspect SQLite fixture: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function yjsDatabaseInventory(updates) {
  const sourceDatabaseIds = new Set();
  let references = 0;
  for (const update of updates) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(update.data, "base64"));
    for (const [, value] of doc.getMap("blocks")) {
      if (!(value instanceof Y.Map)) continue;
      const flavour = value.get("sys:flavour");
      if (flavour !== "affine:database" && flavour !== "myoxus:database") {
        continue;
      }
      references += 1;
      sourceDatabaseIds.add(value.get("prop:databaseId"));
    }
  }
  return { references, sourceDatabaseIds };
}

for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
  const absolutePath = path.join(fixtureRoot, relativePath);
  invariant(existsSync(absolutePath), `missing fixture ${relativePath}`);
  const actualHash = createHash("sha256")
    .update(readFileSync(absolutePath))
    .digest("hex");
  invariant(actualHash === expectedHash, `fixture hash drift: ${relativePath}`);
}

const expectedDiagnostics = [
  "MIX_WORKSPACE_IMPORT_FORMAT_UNSUPPORTED",
  "MIX_WORKSPACE_IMPORT_UPLOAD_LIMIT",
  "MIX_WORKSPACE_IMPORT_ARCHIVE_INVALID",
  "MIX_WORKSPACE_IMPORT_ARCHIVE_LIMIT",
  "MIX_WORKSPACE_IMPORT_SQLITE_INVALID",
  "MIX_WORKSPACE_IMPORT_SQLITE_SCHEMA_UNSUPPORTED",
  "MIX_WORKSPACE_IMPORT_SNAPSHOT_INVALID",
  "MIX_WORKSPACE_IMPORT_ASSET_MISSING",
  "MIX_WORKSPACE_IMPORT_DOCUMENT_INVALID",
  "MIX_WORKSPACE_IMPORT_DATABASE_INVALID",
  "MIX_WORKSPACE_IMPORT_DATABASE_UNSUPPORTED",
  "MIX_WORKSPACE_IMPORT_APPLY_BLOCKED",
  "MIX_WORKSPACE_IMPORT_PERMISSION_DENIED",
  "MIX_WORKSPACE_IMPORT_CANCELLED",
  "MIX_WORKSPACE_IMPORT_CLEANUP_REQUIRED",
  "MIX_WORKSPACE_IMPORT_EXPIRED",
];
invariant(
  JSON.stringify(Object.keys(manifest.diagnosticFixtures).sort()) ===
    JSON.stringify(expectedDiagnostics.sort()),
  "fixture manifest must own every stable blocking diagnostic",
);

const sqlitePath = path.join(fixtureRoot, "workspace-sqlite-v1-valid.myoxus");
invariant(
  readFileSync(sqlitePath).subarray(0, 16).toString("binary") ===
    "SQLite format 3\0",
  "valid SQLite fixture must use the SQLite content signature",
);
const sqlite = sqliteInventory(sqlitePath);
for (const table of [
  "updates",
  "blobs",
  "version_info",
  "server_clock",
  "sync_metadata",
]) {
  invariant(
    sqlite.tables.includes(table),
    `valid SQLite fixture lacks ${table}`,
  );
}
invariant(
  sqlite.updates.length === manifest.expected.documents,
  "SQLite fixture document count drift",
);
invariant(
  sqlite.blobCount === manifest.expected.assets,
  "SQLite fixture asset count drift",
);
const sqliteDatabases = yjsDatabaseInventory(sqlite.updates);
invariant(
  sqliteDatabases.references === manifest.expected.databaseReferences,
  "SQLite fixture Database reference count drift",
);
invariant(
  sqliteDatabases.sourceDatabaseIds.size === manifest.expected.sourceDatabases,
  "SQLite fixture stable Database identity count drift",
);

const invalidYjs = sqliteInventory(
  path.join(fixtureRoot, manifest.supplementalFixtures.malformedYjs),
);
let invalidYjsRejected = false;
try {
  Y.applyUpdate(new Y.Doc(), Buffer.from(invalidYjs.updates[0].data, "base64"));
} catch {
  invalidYjsRejected = true;
}
invariant(invalidYjsRejected, "malformed Yjs fixture must fail decoding");

const unsupportedSqlite = sqliteInventory(
  path.join(
    fixtureRoot,
    manifest.diagnosticFixtures.MIX_WORKSPACE_IMPORT_SQLITE_SCHEMA_UNSUPPORTED,
  ),
);
invariant(
  !unsupportedSqlite.tables.includes("updates") &&
    !unsupportedSqlite.tables.includes("snapshots"),
  "unsupported SQLite fixture accidentally matches an accepted schema",
);

const snapshotBytes = readFileSync(
  path.join(fixtureRoot, "workspace-snapshot-valid.zip"),
);
invariant(
  snapshotBytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  "valid snapshot fixture must use the ZIP content signature",
);
const archive = await readZip(snapshotBytes);
const names = [...archive.keys()].sort();
invariant(
  names.every((name) => !name.includes("..") && !name.startsWith("/")),
  "valid ZIP contains unsafe paths",
);
const snapshotNames = names.filter((name) => name.endsWith(".snapshot.json"));
invariant(
  snapshotNames.length === manifest.expected.documents,
  "snapshot ZIP document count drift",
);
invariant(
  names.filter((name) => name.startsWith("assets/") && !name.endsWith("/"))
    .length === manifest.expected.assets,
  "snapshot ZIP asset count drift",
);
const snapshotDatabaseIds = new Set();
let snapshotReferences = 0;
for (const name of snapshotNames) {
  const value = JSON.parse(archive.get(name).data.toString("utf8"));
  for (const block of value.blocks) {
    if (
      block.flavour !== "affine:database" &&
      block.flavour !== "myoxus:database"
    ) {
      continue;
    }
    snapshotReferences += 1;
    snapshotDatabaseIds.add(block.props.databaseId);
  }
}
invariant(
  snapshotReferences === manifest.expected.databaseReferences,
  "snapshot ZIP Database reference count drift",
);
invariant(
  snapshotDatabaseIds.size === manifest.expected.sourceDatabases,
  "snapshot ZIP stable Database identity count drift",
);

console.log("Workspace import fixture contract passed.");
