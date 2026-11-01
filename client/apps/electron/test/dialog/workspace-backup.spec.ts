// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocStoragePool } from "@myoxus/local-store";
import * as Y from "yjs";

import {
  readFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  containsEditorLocalDatabasePayload,
  isFileWithinDirectory,
  writeWorkspaceBackup,
} from "../../src/helper/dialog/workspace-backup";

const tempDirs: string[] = [];

async function tempFile(content: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "myoxus-backup-contract-"));
  tempDirs.push(dir);
  const file = join(dir, "storage.db");
  await writeFile(file, content);
  return file;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

describe("local workspace backup boundary", () => {
  test("accepts only real files contained by the backup directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "myoxus-backup-path-"));
    tempDirs.push(root);
    const backups = join(root, "backups");
    const outside = join(root, "outside.db");
    const internal = join(backups, "workspace", "storage.db");
    const escapingLink = join(backups, "workspace", "escape.db");
    await mkdir(join(backups, "workspace"), { recursive: true });
    await Promise.all([
      writeFile(internal, "internal"),
      writeFile(outside, "outside"),
    ]);
    await symlink(outside, escapingLink);

    await expect(isFileWithinDirectory(internal, backups)).resolves.toBe(true);
    await expect(isFileWithinDirectory(outside, backups)).resolves.toBe(false);
    await expect(isFileWithinDirectory(escapingLink, backups)).resolves.toBe(
      false,
    );
  });

  test("accepts current backup bytes without editor-local Database markers", async () => {
    const file = await tempFile(
      Buffer.from("SQLite format 3\0myoxus:paragraph"),
    );
    await expect(containsEditorLocalDatabasePayload(file)).resolves.toBe(false);
  });

  test.each(["myoxus:database", "affine:database"])(
    "rejects a persisted %s payload",
    async (marker) => {
      const file = await tempFile(
        Buffer.concat([Buffer.alloc(65_530, 1), Buffer.from(marker)]),
      );
      await expect(containsEditorLocalDatabasePayload(file)).resolves.toBe(
        true,
      );
    },
  );
});

test("remote backup projects exact SQL labels into a real detached SQLite copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "myoxus-label-backup-"));
  tempDirs.push(dir);
  const source = join(dir, "source.db");
  const output = join(dir, "output.db");
  const pool = new DocStoragePool();
  const root = new Y.Doc();
  const workspaceId = "label-backup-workspace";
  const meta = root.getMap("meta");
  meta.set("properties", {
    unrelated: "preserved",
    tags: { options: [{ id: "stale", value: "Stale", color: "tag.red" }] },
  });
  const pages = new Y.Array();
  meta.set("pages", pages);
  pages.push([
    {
      id: "source-doc",
      title: "Preserved title",
      tags: ["stale"],
      trash: true,
    },
  ]);
  await pool.connect("source", source);
  try {
    await pool.pushUpdate("source", workspaceId, Y.encodeStateAsUpdate(root));
    await pool.pushUpdate(
      "source",
      "source-doc",
      Y.encodeStateAsUpdate(new Y.Doc()),
    );
    await pool.pushUpdate("source", "db$folders", new Uint8Array([0, 0]));
    await pool.checkpoint("source");
  } finally {
    await pool.disconnect("source");
    root.destroy();
  }
  const before = await readFile(source);
  const labels = {
    workspaceTags: [
      {
        id: "archived",
        name: "Same",
        colorRole: "tag.blue",
        description: "Archived description",
        archived: true,
        archivedAt: "2024-01-02T03:04:05+00:00",
      },
      {
        id: "active",
        name: "Same",
        colorRole: "tag.green",
        description: null,
        archived: false,
        archivedAt: null,
      },
    ],
    documents: [
      {
        sourceId: "source-doc",
        externalId: "source-doc",
        tags: ["archived", "active"],
      },
    ],
  };
  await writeWorkspaceBackup(source, output, workspaceId, labels);
  expect(await readFile(source)).toEqual(before);
  const exported = new Y.Doc();
  await pool.connect("output", output);
  try {
    const snapshot = await pool.getDocSnapshot("output", workspaceId);
    if (snapshot) Y.applyUpdate(exported, snapshot.bin);
    for (const update of await pool.getDocUpdates("output", workspaceId))
      Y.applyUpdate(exported, update.bin);
    expect((await pool.getDocUpdates("output", "db$folders"))[0].bin).toEqual(
      new Uint8Array([0, 0]),
    );
    const projected = exported.getMap("meta").toJSON();
    expect(projected.properties.unrelated).toBe("preserved");
    expect(projected.properties.tags.options).toEqual(
      labels.workspaceTags.map((tag) => ({
        id: tag.id,
        value: tag.name,
        color: tag.colorRole,
        description: tag.description,
        archived: tag.archived,
        archivedAt: tag.archivedAt,
      })),
    );
    expect(projected.pages).toEqual([
      {
        id: "source-doc",
        title: "Preserved title",
        tags: ["archived", "active"],
        trash: true,
      },
    ]);
  } finally {
    exported.destroy();
    await pool.disconnect("output");
  }
  const accepted = await readFile(output);
  await expect(
    writeWorkspaceBackup(source, output, workspaceId, {
      ...labels,
      documents: [],
    }),
  ).rejects.toThrow("outside the canonical label projection");
  expect(await readFile(output)).toEqual(accepted);
  const local = join(dir, "local.db");
  await writeWorkspaceBackup(source, local, workspaceId);
  expect(await readFile(local)).toEqual(before);
  expect(await readFile(source)).toEqual(before);
});
