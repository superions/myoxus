#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import * as Y from "yjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fixtureRoot = path.join(
  repoRoot,
  "server/crates/workspace_import/tests/fixtures",
);
const invalidRoot = path.join(fixtureRoot, "invalid");
const fixedDate = new Date("2026-01-01T00:00:00.000Z");

const columns = [
  { id: "title", type: "title", name: "Name", data: {} },
  { id: "summary", type: "rich-text", name: "Summary", data: {} },
  { id: "estimate", type: "number", name: "Estimate", data: { decimal: 0 } },
  { id: "done", type: "checkbox", name: "Done", data: {} },
  { id: "due", type: "date", name: "Due", data: { includeTime: true } },
  {
    id: "status",
    type: "select",
    name: "Status",
    data: {
      options: [
        { id: "todo", value: "To do", color: "gray" },
        { id: "doing", value: "In progress", color: "blue" },
        { id: "done", value: "Done", color: "green" },
      ],
    },
  },
  {
    id: "tags",
    type: "multi-select",
    name: "Tags",
    data: {
      options: [
        { id: "backend", value: "Backend", color: "violet" },
        { id: "urgent", value: "Urgent", color: "red" },
      ],
    },
  },
  { id: "progress", type: "progress", name: "Progress", data: {} },
  { id: "image", type: "image", name: "Image", data: {} },
  { id: "link", type: "link", name: "Link", data: {} },
  { id: "created", type: "created-time", name: "Created", data: {} },
  { id: "files", type: "file", name: "Files", data: {} },
];

const views = [
  {
    id: "view-table",
    name: "Table",
    mode: "table",
    columns: columns.map(({ id }) => ({ id, hide: false })),
  },
  {
    id: "view-kanban",
    name: "Board",
    mode: "kanban",
    groupBy: { type: "groupBy", columnId: "status" },
    columns: columns.map(({ id }) => ({ id, hide: false })),
  },
];

const riskColumns = columns.slice(0, 6);
const riskViews = [
  {
    ...views[0],
    columns: riskColumns.map(({ id }) => ({ id, hide: false })),
  },
];

const cells = {
  "row-alpha": {
    summary: { columnId: "summary", value: "Server-owned migration" },
    estimate: { columnId: "estimate", value: 8 },
    done: { columnId: "done", value: false },
    due: { columnId: "due", value: "2026-07-20T09:30:00.000Z" },
    status: { columnId: "status", value: "doing" },
    tags: { columnId: "tags", value: ["backend", "urgent"] },
    progress: { columnId: "progress", value: 0.5 },
    image: { columnId: "image", value: ["asset-logo.png"] },
    link: { columnId: "link", value: "https://example.invalid/project" },
    files: { columnId: "files", value: ["asset-logo.png"] },
  },
  "row-beta": {
    summary: { columnId: "summary", value: "Reference-only embed" },
    estimate: { columnId: "estimate", value: 3 },
    done: { columnId: "done", value: true },
    due: { columnId: "due", value: "2026-07-18T12:00:00.000Z" },
    status: { columnId: "status", value: "done" },
    tags: { columnId: "tags", value: ["backend"] },
    progress: { columnId: "progress", value: 1 },
    image: { columnId: "image", value: [] },
    link: { columnId: "link", value: "https://example.invalid/embed" },
    files: { columnId: "files", value: [] },
  },
};

function insertBlock(blocks, id, flavour, props = {}, children = []) {
  const block = new Y.Map();
  blocks.set(id, block);
  // Virgultum resolves a block from both the map key and its canonical id.
  // Omitting sys:id produces a decodable Yjs update that the live editor
  // cannot materialize, so fixtures must preserve the same invariant as
  // documents created by the product runtime.
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  const childArray = new Y.Array();
  block.set("sys:children", childArray);
  if (children.length > 0) childArray.push(children);
  for (const [key, value] of Object.entries(props)) {
    const richText =
      (flavour === "affine:page" && key === "title") ||
      ([
        "affine:paragraph",
        "affine:list",
        "affine:code",
        "affine:callout",
      ].includes(flavour) &&
        key === "text");
    block.set(`prop:${key}`, richText ? new Y.Text(String(value)) : value);
  }
  return block;
}

function createYjsDocument({
  id,
  title,
  targetId,
  includeIndependentDatabase,
}) {
  const doc = new Y.Doc({ guid: id });
  doc.clientID = id === "doc-home" ? 1001 : 1002;
  const blocks = doc.getMap("blocks");

  doc.transact(() => {
    insertBlock(blocks, `${id}:page`, "affine:page", { title }, [
      `${id}:surface`,
      `${id}:note`,
    ]);
    // Page-mode documents still carry the Surface sibling used when the user
    // switches to Edgeless. A source without it decodes but cannot be opened in
    // Edgeless after import, so it is not a valid product fixture.
    insertBlock(blocks, `${id}:surface`, "affine:surface");
    insertBlock(
      blocks,
      `${id}:note`,
      "affine:note",
      { xywh: "[0, 0, 800, 92]" },
      [
        `${id}:paragraph`,
        `${id}:link`,
        `${id}:asset`,
        `${id}:database-projects`,
        ...(includeIndependentDatabase ? [`${id}:database-risks`] : []),
      ],
    );
    insertBlock(blocks, `${id}:paragraph`, "affine:paragraph", {
      text: `Synthetic content for ${title}`,
    });
    insertBlock(blocks, `${id}:link`, "affine:embed-linked-doc", {
      pageId: targetId,
    });
    insertBlock(blocks, `${id}:asset`, "affine:image", {
      sourceId: "asset-logo.png",
    });
    insertBlock(
      blocks,
      `${id}:database-projects`,
      "affine:database",
      {
        databaseId: "legacy-db-projects",
        title: "Projects",
        columns,
        views,
        cells,
      },
      [`${id}:row-alpha`, `${id}:row-beta`],
    );
    insertBlock(blocks, `${id}:row-alpha`, "affine:paragraph", {
      text: "Migration service",
      createdAt: "2026-07-01T08:00:00.000Z",
    });
    insertBlock(blocks, `${id}:row-beta`, "affine:paragraph", {
      text: "Embed shell",
      createdAt: "2026-07-02T08:00:00.000Z",
    });

    if (includeIndependentDatabase) {
      insertBlock(
        blocks,
        `${id}:database-risks`,
        "myoxus:database",
        {
          databaseId: "legacy-db-risks",
          title: "Risks",
          columns: riskColumns,
          views: riskViews,
          cells: {
            "risk-one": {
              summary: { columnId: "summary", value: "Invalid fallback" },
              estimate: { columnId: "estimate", value: 5 },
              done: { columnId: "done", value: false },
              status: { columnId: "status", value: "todo" },
            },
          },
        },
        [`${id}:risk-one`],
      );
      insertBlock(blocks, `${id}:risk-one`, "myoxus:paragraph", {
        text: "Permissive legacy fallback",
        createdAt: "2026-07-03T08:00:00.000Z",
      });
    }
  });

  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

function snapshotBlocks({ id, title, targetId, includeIndependentDatabase }) {
  const blocks = [
    {
      id: `${id}:page`,
      flavour: "affine:page",
      props: { title },
      children: [`${id}:surface`, `${id}:note`],
    },
    {
      id: `${id}:surface`,
      flavour: "affine:surface",
      props: {},
      children: [],
    },
    {
      id: `${id}:note`,
      flavour: "affine:note",
      props: { xywh: "[0, 0, 800, 92]" },
      children: [
        `${id}:paragraph`,
        `${id}:link`,
        `${id}:asset`,
        `${id}:database-projects`,
        ...(includeIndependentDatabase ? [`${id}:database-risks`] : []),
      ],
    },
    {
      id: `${id}:paragraph`,
      flavour: "affine:paragraph",
      props: { text: `Synthetic content for ${title}` },
      children: [],
    },
    {
      id: `${id}:link`,
      flavour: "affine:embed-linked-doc",
      props: { pageId: targetId },
      children: [],
    },
    {
      id: `${id}:asset`,
      flavour: "affine:image",
      props: { sourceId: "asset-logo.png" },
      children: [],
    },
    {
      id: `${id}:database-projects`,
      flavour: "affine:database",
      props: {
        databaseId: "legacy-db-projects",
        title: "Projects",
        columns,
        views,
        cells,
      },
      children: [`${id}:row-alpha`, `${id}:row-beta`],
    },
    {
      id: `${id}:row-alpha`,
      flavour: "affine:paragraph",
      props: {
        text: "Migration service",
        createdAt: "2026-07-01T08:00:00.000Z",
      },
      children: [],
    },
    {
      id: `${id}:row-beta`,
      flavour: "affine:paragraph",
      props: {
        text: "Embed shell",
        createdAt: "2026-07-02T08:00:00.000Z",
      },
      children: [],
    },
  ];

  if (includeIndependentDatabase) {
    blocks.push(
      {
        id: `${id}:database-risks`,
        flavour: "myoxus:database",
        props: {
          databaseId: "legacy-db-risks",
          title: "Risks",
          columns: riskColumns,
          views: riskViews,
          cells: {
            "risk-one": {
              summary: { columnId: "summary", value: "Invalid fallback" },
              estimate: { columnId: "estimate", value: 5 },
              done: { columnId: "done", value: false },
              status: { columnId: "status", value: "todo" },
            },
          },
        },
        children: [`${id}:risk-one`],
      },
      {
        id: `${id}:risk-one`,
        flavour: "myoxus:paragraph",
        props: {
          text: "Permissive legacy fallback",
          createdAt: "2026-07-03T08:00:00.000Z",
        },
        children: [],
      },
    );
  }
  return blocks;
}

const workspaceTags = [
  {
    id: "legacy-active",
    name: "Priority",
    colorRole: "tag.blue",
    description: "Active portable label",
  },
  {
    id: "legacy-archived",
    name: "Priority",
    colorRole: "unsupported-legacy-color",
    description: "Archived portable label",
    archived: true,
    archivedAt: "2024-01-02T03:04:05Z",
  },
];

const documents = [
  {
    id: "doc-home",
    tags: ["legacy-archived", "legacy-active"],
    title: "Imported workspace",
    targetId: "doc-projects",
    parentId: null,
    order: "a0",
    includeIndependentDatabase: true,
  },
  {
    id: "doc-projects",
    tags: [],
    title: "Projects overview",
    targetId: "doc-home",
    parentId: "doc-home",
    order: "a1",
    includeIndependentDatabase: false,
  },
];

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function addZipEntry(zip, name, value) {
  zip.file(name, value, { date: fixedDate, createFolders: false });
}

async function zipBuffer(entries) {
  const zip = new JSZip();
  for (const [name, value] of entries) addZipEntry(zip, name, value);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
  });
}

function snapshotJson(document, mutate = (value) => value) {
  return JSON.stringify(
    mutate({
      meta: {
        id: document.id,
        title: document.title,
        flavour: "affine:page",
        mode: "page",
        parentId: document.parentId,
        order: document.order,
        tags: document.tags,
      },
      blocks: snapshotBlocks(document),
    }),
    null,
    2,
  );
}

const infoJson = JSON.stringify(
  {
    id: "source-workspace-id-not-preserved",
    name: "Imported workspace",
    workspaceTags,
    version: 1,
  },
  null,
  2,
);

async function writeSnapshotFixture(output, overrides = {}) {
  const entries = [
    ["info.json", infoJson],
    ...documents.map((document) => [
      `workspace/${document.id}.snapshot.json`,
      snapshotJson(document, overrides[document.id]),
    ]),
    ["assets/asset-logo.png", png],
  ];
  writeFileSync(output, await zipBuffer(entries));
}

function writeSqliteFixture(output) {
  const payload = {
    workspace: {
      id: "source-workspace-id-not-preserved",
      title: "Imported workspace",
      workspaceTags,
      documents: documents.map(({ id, title, parentId, order, tags }) => ({
        tags,
        id,
        title,
        parentId,
        order,
        mode: "page",
      })),
    },
    updates: documents.map((document) => ({
      docId: document.id,
      data: createYjsDocument(document).toString("base64"),
    })),
    blobs: [{ key: "asset-logo.png", data: png.toString("base64") }],
  };
  const python = String.raw`
import base64, json, pathlib, sqlite3, sys

target = pathlib.Path(sys.argv[1])
payload = json.load(sys.stdin)
target.unlink(missing_ok=True)
connection = sqlite3.connect(target)
connection.executescript('''
CREATE TABLE updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data BLOB NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  doc_id TEXT
);
CREATE TABLE blobs (
  key TEXT PRIMARY KEY NOT NULL,
  data BLOB NOT NULL,
  timestamp TIMESTAMP NOT NULL
);
CREATE TABLE version_info (
  version NUMBER NOT NULL,
  timestamp TIMESTAMP NOT NULL
);
CREATE TABLE server_clock (
  key TEXT PRIMARY KEY NOT NULL,
  data BLOB NOT NULL,
  timestamp TIMESTAMP NOT NULL
);
CREATE TABLE sync_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  data BLOB NOT NULL,
  timestamp TIMESTAMP NOT NULL
);
''')
timestamp = '2026-01-01T00:00:00.000Z'
for update in payload['updates']:
    connection.execute(
        'INSERT INTO updates(data, timestamp, doc_id) VALUES (?, ?, ?)',
        (base64.b64decode(update['data']), timestamp, update['docId']),
    )
for blob in payload['blobs']:
    connection.execute(
        'INSERT INTO blobs(key, data, timestamp) VALUES (?, ?, ?)',
        (blob['key'], base64.b64decode(blob['data']), timestamp),
    )
connection.execute(
    'INSERT INTO version_info(version, timestamp) VALUES (?, ?)',
    (4, timestamp),
)
connection.execute(
    'INSERT INTO sync_metadata(key, data, timestamp) VALUES (?, ?, ?)',
    ('workspace:meta', json.dumps(payload['workspace'], sort_keys=True).encode(), timestamp),
)
connection.commit()
connection.execute('VACUUM')
connection.close()
`;
  const result = spawnSync("python3", ["-c", python, output], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`SQLite fixture generation failed: ${result.stderr}`);
  }
}

function runPython(source, args) {
  const result = spawnSync("python3", ["-c", source, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Fixture mutation failed: ${result.stderr}`);
  }
}

function writeUnsupportedSqliteSchema(output) {
  runPython(
    String.raw`
import pathlib, sqlite3, sys
target = pathlib.Path(sys.argv[1])
target.unlink(missing_ok=True)
connection = sqlite3.connect(target)
connection.execute('CREATE TABLE unrelated_payload (id TEXT PRIMARY KEY, value BLOB NOT NULL)')
connection.execute('INSERT INTO unrelated_payload(id, value) VALUES (?, ?)', ('not-a-workspace', b'data'))
connection.commit()
connection.execute('VACUUM')
connection.close()
`,
    [output],
  );
}

function corruptFirstYjsUpdate(output) {
  runPython(
    String.raw`
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("UPDATE updates SET data = X'00FFFF00' WHERE id = (SELECT MIN(id) FROM updates)")
connection.commit()
connection.close()
`,
    [output],
  );
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

function writeManifest(manifest) {
  manifest.files = Object.fromEntries(
    listFiles(fixtureRoot)
      .filter((file) => file !== path.join(fixtureRoot, "manifest.json"))
      .map((file) => [
        path.relative(fixtureRoot, file),
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      ]),
  );
  writeFileSync(
    path.join(fixtureRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

// Refresh inventory without rebuilding SQLite binaries with a different host version.
if (process.argv.includes("--manifest-only")) {
  writeManifest(
    JSON.parse(readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8")),
  );
  process.exit(0);
}

mkdirSync(fixtureRoot, { recursive: true });
for (const entry of readdirSync(fixtureRoot)) {
  rmSync(path.join(fixtureRoot, entry), { recursive: true, force: true });
}
mkdirSync(invalidRoot, { recursive: true });

await writeSnapshotFixture(
  path.join(fixtureRoot, "workspace-snapshot-valid.zip"),
);
writeSqliteFixture(path.join(fixtureRoot, "workspace-sqlite-v1-valid.myoxus"));

writeFileSync(
  path.join(invalidRoot, "format-unsupported.bin"),
  "not a workspace",
);
writeFileSync(path.join(invalidRoot, "upload-limit.bin"), "limit probe");
writeFileSync(
  path.join(invalidRoot, "archive-invalid.zip"),
  "PK\x03\x04truncated",
);
writeFileSync(
  path.join(invalidRoot, "sqlite-invalid.db"),
  "SQLite format 3\0truncated",
);
writeFileSync(
  path.join(invalidRoot, "document-invalid.zip"),
  await zipBuffer([
    [
      "workspace/doc.snapshot.json",
      JSON.stringify({ meta: { id: "doc" }, blocks: 42 }),
    ],
  ]),
);
writeFileSync(
  path.join(invalidRoot, "snapshot-invalid.zip"),
  await zipBuffer([["workspace/doc.snapshot.json", "{invalid-json"]]),
);
writeFileSync(
  path.join(invalidRoot, "asset-missing.zip"),
  await zipBuffer([
    [
      "workspace/doc.snapshot.json",
      JSON.stringify({
        meta: { id: "doc" },
        blocks: [
          {
            id: "image",
            flavour: "affine:image",
            props: { sourceId: "missing.png" },
          },
        ],
      }),
    ],
  ]),
);
writeFileSync(
  path.join(invalidRoot, "database-invalid.zip"),
  await zipBuffer([
    [
      "workspace/doc.snapshot.json",
      snapshotJson(documents[0], (value) => {
        value.blocks.find(
          (block) => block.flavour === "affine:database",
        ).props.columns = "invalid";
        return value;
      }),
    ],
    ["assets/asset-logo.png", png],
  ]),
);
writeFileSync(
  path.join(invalidRoot, "database-unsupported.zip"),
  await zipBuffer([
    [
      "workspace/doc.snapshot.json",
      snapshotJson(documents[0], (value) => {
        value.blocks.find(
          (block) => block.flavour === "affine:database",
        ).props.columns[0].type = "unsupported";
        return value;
      }),
    ],
    ["assets/asset-logo.png", png],
  ]),
);
writeFileSync(
  path.join(invalidRoot, "apply-blocked.zip"),
  readFileSync(path.join(invalidRoot, "database-invalid.zip")),
);
writeFileSync(
  path.join(invalidRoot, "archive-limit.zip"),
  await zipBuffer([
    ["workspace/doc.snapshot.json", snapshotJson(documents[0])],
    ["extra/one", "one"],
    ["extra/two", "two"],
  ]),
);
writeUnsupportedSqliteSchema(
  path.join(invalidRoot, "sqlite-schema-unsupported.db"),
);
writeFileSync(
  path.join(invalidRoot, "permission-denied.zip"),
  readFileSync(path.join(fixtureRoot, "workspace-snapshot-valid.zip")),
);
writeFileSync(
  path.join(invalidRoot, "cancelled.zip"),
  readFileSync(path.join(fixtureRoot, "workspace-snapshot-valid.zip")),
);
writeFileSync(
  path.join(invalidRoot, "cleanup-required.zip"),
  readFileSync(path.join(fixtureRoot, "workspace-snapshot-valid.zip")),
);
writeFileSync(
  path.join(invalidRoot, "expired.zip"),
  readFileSync(path.join(fixtureRoot, "workspace-snapshot-valid.zip")),
);
writeFileSync(
  path.join(invalidRoot, "yjs-invalid.myoxus"),
  readFileSync(path.join(fixtureRoot, "workspace-sqlite-v1-valid.myoxus")),
);
corruptFirstYjsUpdate(path.join(invalidRoot, "yjs-invalid.myoxus"));

const diagnosticFixtures = {
  MIX_WORKSPACE_IMPORT_FORMAT_UNSUPPORTED: "invalid/format-unsupported.bin",
  MIX_WORKSPACE_IMPORT_UPLOAD_LIMIT: "invalid/upload-limit.bin",
  MIX_WORKSPACE_IMPORT_ARCHIVE_INVALID: "invalid/archive-invalid.zip",
  MIX_WORKSPACE_IMPORT_ARCHIVE_LIMIT: "invalid/archive-limit.zip",
  MIX_WORKSPACE_IMPORT_SQLITE_INVALID: "invalid/sqlite-invalid.db",
  MIX_WORKSPACE_IMPORT_SQLITE_SCHEMA_UNSUPPORTED:
    "invalid/sqlite-schema-unsupported.db",
  MIX_WORKSPACE_IMPORT_SNAPSHOT_INVALID: "invalid/snapshot-invalid.zip",
  MIX_WORKSPACE_IMPORT_ASSET_MISSING: "invalid/asset-missing.zip",
  MIX_WORKSPACE_IMPORT_DOCUMENT_INVALID: "invalid/document-invalid.zip",
  MIX_WORKSPACE_IMPORT_DATABASE_INVALID: "invalid/database-invalid.zip",
  MIX_WORKSPACE_IMPORT_DATABASE_UNSUPPORTED: "invalid/database-unsupported.zip",
  MIX_WORKSPACE_IMPORT_APPLY_BLOCKED: "invalid/apply-blocked.zip",
  MIX_WORKSPACE_IMPORT_PERMISSION_DENIED: "invalid/permission-denied.zip",
  MIX_WORKSPACE_IMPORT_CANCELLED: "invalid/cancelled.zip",
  MIX_WORKSPACE_IMPORT_CLEANUP_REQUIRED: "invalid/cleanup-required.zip",
  MIX_WORKSPACE_IMPORT_EXPIRED: "invalid/expired.zip",
};

const manifest = {
  schemaVersion: 1,
  generatedBy: "build/scripts/test/generate-workspace-import-fixtures.mjs",
  expected: {
    documents: 2,
    assets: 1,
    sourceDatabases: 2,
    databaseReferences: 3,
    rows: 3,
    views: 3,
  },
  diagnosticFixtures,
  supplementalFixtures: {
    malformedYjs: "invalid/yjs-invalid.myoxus",
  },
  files: {},
};
writeManifest(manifest);

console.log(
  `Generated ${Object.keys(manifest.files).length} workspace import fixtures.`,
);
