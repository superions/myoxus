import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { DocStorage } from "@myoxus/local-store";
import {
  parseUniversalId,
  universalId as generateUniversalId,
} from "@myoxus/storage";
import { applyUpdate, Doc as YDoc } from "yjs";

import { logger } from "../logger";
import { getDocStoragePool } from "../storage";
import {
  getDeletedWorkspacesBasePath,
  getSpaceBasePath,
  getSpaceDBPath,
} from "./meta";

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readDirectoryIfPresent(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/**
 * Permanently delete the workspace data
 */
export async function deleteWorkspace(universalId: string) {
  const { peer, type, id } = parseUniversalId(universalId);
  const dbPath = await getSpaceDBPath(peer, type, id);
  try {
    await getDocStoragePool().disconnect(universalId);
    await rm(path.dirname(dbPath), { recursive: true });
  } catch (e) {
    logger.error("deleteWorkspace", e);
    throw e;
  }
}

/**
 * Move the workspace folder to `deleted-workspaces`
 */
export async function trashWorkspace(universalId: string) {
  const { peer, type, id } = parseUniversalId(universalId);
  const dbPath = await getSpaceDBPath(peer, type, id);
  const basePath = await getDeletedWorkspacesBasePath();
  const movedPath = path.join(basePath, `${id}`);
  try {
    const storage = new DocStorage(dbPath);
    if (await storage.validate()) {
      const pool = getDocStoragePool();
      await pool.checkpoint(universalId);
      await pool.disconnect(universalId);
    }
    await mkdir(movedPath, { recursive: true });
    // todo(@pengx17): it seems the db file is still being used at the point
    // on windows so that it cannot be moved. we will fallback to copy the dir instead.
    await cp(path.dirname(dbPath), movedPath, {
      force: true,
      recursive: true,
    });
    await rm(path.dirname(dbPath), { recursive: true });
  } catch (error) {
    logger.error("trashWorkspace", error);
    throw error;
  }
}

export async function listLocalWorkspaceIds(): Promise<string[]> {
  const localWorkspaceBasePath = path.join(
    await getSpaceBasePath("workspace"),
    "local",
  );
  if (!(await pathExists(localWorkspaceBasePath))) {
    return [];
  }

  const deletedWorkspaceBasePath = await getDeletedWorkspacesBasePath();
  const deletedWorkspaceIds = new Set<string>(
    (await readDirectoryIfPresent(deletedWorkspaceBasePath)).filter(Boolean),
  );

  const entries = await readdir(localWorkspaceBasePath);
  const ids = await Promise.all(
    entries.map(async (entry) => {
      if (deletedWorkspaceIds.has(entry)) {
        return null;
      }
      const workspacePath = path.join(localWorkspaceBasePath, entry);
      let workspaceStat;
      try {
        workspaceStat = await stat(workspacePath);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      if (!workspaceStat.isDirectory()) {
        return null;
      }
      if (!(await pathExists(path.join(workspacePath, "storage.db")))) {
        return null;
      }
      return entry;
    }),
  );

  return ids.filter((id): id is string => typeof id === "string");
}

type WorkspaceDocMeta = {
  id: string;
  name: string;
  avatar: Uint8Array | null;
  fileSize: number;
  updatedAt: Date;
  createdAt: Date;
  docCount: number;
  dbPath: string;
};

async function getWorkspaceDocMeta(
  workspaceId: string,
  dbPath: string,
): Promise<WorkspaceDocMeta | null> {
  const pool = getDocStoragePool();
  const universalId = generateUniversalId({
    peer: "deleted-local",
    type: "workspace",
    id: workspaceId,
  });
  try {
    await pool.connect(universalId, dbPath);
    await pool.checkpoint(universalId);
    const snapshot = await pool.getDocSnapshot(universalId, workspaceId);
    const pendingUpdates = await pool.getDocUpdates(universalId, workspaceId);
    if (snapshot) {
      const updates = snapshot.bin;
      const ydoc = new YDoc();
      applyUpdate(ydoc, updates);
      pendingUpdates.forEach((update) => {
        applyUpdate(ydoc, update.bin);
      });
      const meta = ydoc.getMap("meta").toJSON();
      const dbFileStat = await stat(dbPath);
      const blob = meta.avatar
        ? await pool.getBlob(universalId, meta.avatar)
        : null;
      return {
        id: workspaceId,
        name: meta.name,
        avatar: blob ? blob.data : null,
        fileSize: dbFileStat.size,
        updatedAt: dbFileStat.mtime,
        createdAt: dbFileStat.birthtime,
        docCount: meta.pages.length,
        dbPath,
      };
    }
  } catch (error) {
    logger.warn("getWorkspaceDocMeta", { workspaceId, error });
  } finally {
    await pool.disconnect(universalId);
  }
  return null;
}

export async function getDeletedWorkspaces() {
  const basePath = await getDeletedWorkspacesBasePath();
  const directories = await readdir(basePath);
  const workspaceEntries = await Promise.all(
    directories.map(async (dir) => {
      const stats = await stat(path.join(basePath, dir));
      if (!stats.isDirectory()) {
        return null;
      }
      const dbfileStats = await stat(path.join(basePath, dir, "storage.db"));
      return {
        id: dir,
        mtime: new Date(dbfileStats.mtime),
      };
    }),
  );

  const workspaceIds = workspaceEntries
    .filter((v) => v !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .map((entry) => entry.id);

  const items: WorkspaceDocMeta[] = [];

  // todo(@pengx17): add cursor based pagination
  for (const id of workspaceIds) {
    const meta = await getWorkspaceDocMeta(
      id,
      path.join(basePath, id, "storage.db"),
    );
    if (meta) {
      items.push(meta);
    } else {
      logger.warn("getDeletedWorkspaces", `No meta found for ${id}`);
    }
  }

  return {
    items: items,
  };
}

export async function deleteBackupWorkspace(id: string) {
  const basePath = await getDeletedWorkspacesBasePath();
  const workspacePath = path.join(basePath, id);
  await rm(workspacePath, { recursive: true });
  logger.info(
    "deleteBackupWorkspace",
    `Deleted backup workspace: ${workspacePath}`,
  );
}
