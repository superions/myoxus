// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkspaceLabelExport } from "@myoxus/desktop-api-contract";
import { DocStoragePool } from "@myoxus/local-store";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";

import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

export async function isFileWithinDirectory(
  candidate: string,
  directory: string,
): Promise<boolean> {
  let resolvedCandidate: string;
  let resolvedDirectory: string;
  try {
    [resolvedCandidate, resolvedDirectory] = await Promise.all([
      realpath(candidate),
      realpath(directory),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const child = relative(resolvedDirectory, resolvedCandidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

const EDITOR_LOCAL_DATABASE_MARKERS = [
  Buffer.from("myoxus:database"),
  Buffer.from("affine:database"),
] as const;
const MARKER_OVERLAP =
  Math.max(...EDITOR_LOCAL_DATABASE_MARKERS.map((marker) => marker.length)) - 1;

/**
 * Rejects current-format local backups whose raw Yjs updates still contain a
 * Database block. Such blocks require the server migration planner and must
 * never be opened through local recovery as an unusable fallback.
 */
export async function containsEditorLocalDatabasePayload(filePath: string) {
  let overlap = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.concat([overlap, Buffer.from(chunk)]);
    if (
      EDITOR_LOCAL_DATABASE_MARKERS.some((marker) => bytes.includes(marker))
    ) {
      return true;
    }
    overlap = bytes.subarray(Math.max(0, bytes.length - MARKER_OVERLAP));
  }
  return false;
}

/** Open only the detached backup. The original pool/cache is never a write target. */
async function projectBackupLabels(
  filePath: string,
  workspaceId: string,
  labels: WorkspaceLabelExport,
): Promise<void> {
  const pool = new DocStoragePool();
  const key = `label-export-${randomUUID()}`;
  await pool.connect(key, filePath);
  const root = new Y.Doc();
  try {
    const assignments = new Map(
      labels.documents.map((doc) => [doc.externalId, doc.tags]),
    );
    const catalog = new Set(labels.workspaceTags.map((tag) => tag.id));
    if (
      assignments.size !== labels.documents.length ||
      catalog.size !== labels.workspaceTags.length ||
      labels.documents.some(
        (doc) =>
          doc.sourceId !== doc.externalId ||
          doc.tags.some((id) => !catalog.has(id)),
      )
    ) {
      throw new Error("Invalid canonical backup label projection");
    }
    const clocks = await pool.getDocClocks(key);
    if (
      clocks.some(
        // These reserved helper IDs carry organizer/user cache state, not
        // document labels. Preserve their bytes without requiring assignments.
        (doc) =>
          doc.docId !== workspaceId &&
          !doc.docId.startsWith("db$") &&
          !doc.docId.startsWith("userdata$") &&
          !assignments.has(doc.docId),
      )
    ) {
      throw new Error(
        "Backup contains documents outside the canonical label projection",
      );
    }
    const snapshot = await pool.getDocSnapshot(key, workspaceId);
    const updates = await pool.getDocUpdates(key, workspaceId);
    if (!snapshot && !updates.length)
      throw new Error("Backup workspace root is unavailable");
    if (snapshot) Y.applyUpdate(root, snapshot.bin);
    for (const update of updates) Y.applyUpdate(root, update.bin);
    const vector = Y.encodeStateVector(root);
    const meta = root.getMap("meta");
    const pages = meta.get("pages");
    if (!(pages instanceof Y.Array))
      throw new Error("Backup workspace pages are unavailable");
    root.transact(() => {
      const options = labels.workspaceTags.map((tag) => ({
        id: tag.id,
        value: tag.name,
        color: tag.colorRole,
        description: tag.description,
        archived: tag.archived,
        archivedAt: tag.archivedAt,
      }));
      const properties = meta.get("properties") as
        Y.Map<unknown> | { tags?: Record<string, unknown> } | undefined;
      if (properties instanceof Y.Map) {
        const tags = properties.get("tags");
        if (tags instanceof Y.Map) tags.set("options", options);
        else
          properties.set("tags", {
            ...(tags as Record<string, unknown> | undefined),
            options,
          });
      } else {
        meta.set("properties", {
          ...properties,
          tags: { ...properties?.tags, options },
        });
      }
      for (let index = 0; index < pages.length; index++) {
        const page = pages.get(index);
        const id = page instanceof Y.Map ? page.get("id") : page?.id;
        const tags = assignments.get(id);
        if (!tags)
          throw new Error("Backup page has no canonical label assignment");
        if (page instanceof Y.Map) page.set("tags", [...tags]);
        else {
          pages.delete(index, 1);
          pages.insert(index, [{ ...page, tags: [...tags] }]);
        }
      }
    });
    await pool.pushUpdate(
      key,
      workspaceId,
      Y.encodeStateAsUpdate(root, vector),
    );
    await pool.checkpoint(key);
  } finally {
    root.destroy();
    await pool.disconnect(key);
  }
}

/** Publish only a completely projected copy; an existing destination survives
 * projection failure. Local backups omit the canonical label envelope. */
export async function writeWorkspaceBackup(
  source: string,
  destination: string,
  workspaceId: string,
  labels?: WorkspaceLabelExport,
): Promise<void> {
  const temporary = await mkdtemp(
    join(dirname(destination), ".myoxus-export-"),
  );
  try {
    const detached = join(temporary, "storage.db");
    await copyFile(source, detached);
    if (labels) await projectBackupLabels(detached, workspaceId, labels);
    await rename(detached, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
