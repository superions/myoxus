import type { WorkspaceLabelExport } from "@myoxus/desktop-api-contract";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, parse } from "node:path";

import { DocStorage } from "@myoxus/local-store";
import { parseUniversalId } from "@myoxus/storage";

import { createWorkspaceImportId } from "../../shared/ids";
import { logger } from "../logger";
import { mainRPC } from "../main-rpc";
import { getDocStoragePool } from "../storage";
import {
  getDeletedWorkspacesBasePath,
  getSpaceDBPath,
  getWorkspacesBasePath,
} from "../workspace/meta";
import {
  containsEditorLocalDatabasePayload,
  isFileWithinDirectory,
  writeWorkspaceBackup,
} from "./workspace-backup";

export type ErrorMessage =
  | "DB_FILE_PATH_INVALID"
  | "DB_FILE_INVALID"
  | "DB_FILE_DATABASE_UNSUPPORTED"
  | "UNKNOWN_ERROR";

export interface LoadDBFileResult {
  workspaceId?: string;
  error?: ErrorMessage;
  canceled?: boolean;
}

export interface SaveDBFileResult {
  filePath?: string;
  canceled?: boolean;
  error?: ErrorMessage;
}

export interface SelectDBFileLocationResult {
  filePath?: string;
  error?: ErrorMessage;
  canceled?: boolean;
}

// provide a backdoor to set dialog path for testing in playwright
export interface FakeDialogResult {
  canceled?: boolean;
  filePath?: string;
  filePaths?: string[];
}

// result will be used in the next call to showOpenDialog
// if it is being read once, it will be reset to undefined
let fakeDialogResult: FakeDialogResult | undefined = undefined;

function getFakedResult() {
  const result = fakeDialogResult;
  fakeDialogResult = undefined;
  return result;
}

export function setFakeDialogResult(result: FakeDialogResult | undefined) {
  fakeDialogResult = result;
  // for convenience, we will fill filePaths with filePath if it is not set
  if (result?.filePaths === undefined && result?.filePath !== undefined) {
    result.filePaths = [result.filePath];
  }
}

const extension = "myoxus";

function logFileOperationFailure(operation: string, error: unknown): void {
  const fileError = error as NodeJS.ErrnoException;
  logger.error(operation, {
    code: typeof fileError?.code === "string" ? fileError.code : "UNKNOWN",
    name: error instanceof Error ? error.name : "UnknownError",
  });
}

function getDefaultDBFileName(name: string, id: string) {
  const fileName = `${name}_${id}.${extension}`;
  // make sure fileName is a valid file name
  return fileName.replace(/[/\\?%*:|"<>]/g, "-");
}

/**
 * This function is called when the user clicks the "Save" button in the "Save Workspace" dialog.
 *
 * Remote SQL labels are projected into a temporary copy before atomic publication.
 */
export async function saveDBFileAs(
  universalId: string,
  name: string,
  labels?: WorkspaceLabelExport,
): Promise<SaveDBFileResult> {
  try {
    const { peer, type, id } = parseUniversalId(universalId);
    if (peer !== "local" && !labels) {
      throw new Error(
        "Canonical labels are required for a remote workspace backup",
      );
    }
    const dbPath = await getSpaceDBPath(peer, type, id);

    // connect to the pool and make sure all changes (WAL) are written to db
    const pool = getDocStoragePool();
    await pool.connect(universalId, dbPath);
    await pool.checkpoint(universalId); // make sure all changes (WAL) are written to db

    const fakedResult = getFakedResult();
    if (!dbPath) {
      return {
        error: "DB_FILE_PATH_INVALID",
      };
    }

    const ret =
      fakedResult ??
      (await mainRPC.showSaveDialog({
        properties: ["showOverwriteConfirmation"],
        title: "Save Workspace",
        showsTagField: false,
        buttonLabel: "Save",
        filters: [
          {
            extensions: [extension],
            name: "",
          },
        ],
        defaultPath: getDefaultDBFileName(name, id),
        message: "Save Workspace as a SQLite Database file",
      }));

    const filePath = ret.filePath;
    if (ret.canceled || !filePath) {
      return {
        canceled: true,
      };
    }

    await writeWorkspaceBackup(
      dbPath,
      filePath,
      id,
      peer !== "local" ? labels : undefined,
    );
    logger.info("saveDBFileAs: workspace export completed");
    if (!fakedResult) {
      mainRPC.showItemInFolder(filePath).catch((error) => {
        logFileOperationFailure("saveDBFileAs: reveal export failed", error);
      });
    }
    return { filePath };
  } catch (err) {
    logFileOperationFailure("saveDBFileAs", err);
    return {
      error: "UNKNOWN_ERROR",
    };
  }
}

export async function selectDBFileLocation(): Promise<SelectDBFileLocationResult> {
  try {
    const ret =
      getFakedResult() ??
      (await mainRPC.showOpenDialog({
        properties: ["openDirectory"],
        title: "Set Workspace Storage Location",
        buttonLabel: "Select",
        defaultPath: await mainRPC.getPath("documents"),
        message: "Select a location to store the workspace's database file",
      }));
    const dir = ret.filePaths?.[0];
    if (ret.canceled || !dir) {
      return {
        canceled: true,
      };
    }
    return { filePath: dir };
  } catch (err) {
    logFileOperationFailure("selectDBFileLocation", err);
    return {
      error: "UNKNOWN_ERROR",
    };
  }
}

/**
 * This function is called when the user clicks the "Load" button in the "Load Workspace" dialog.
 *
 * It will
 * - symlink the source db file to a new workspace id to app-data
 * - return the new workspace id
 *
 * eg, it will create a new folder in app-data:
 * <app-data>/<app-name>/<workspaces|userspaces>/<peer>/<workspace-id>/storage.db
 *
 * On the renderer side, after the UI got a new workspace id, it will
 * update the local workspace id list and then connect to it.
 *
 */
export async function loadDBFile(
  dbFilePath?: string,
): Promise<LoadDBFileResult> {
  try {
    // Renderer-supplied paths are reserved for recovery entries returned by
    // getBackupWorkspaces. Interactive imports must go through the native file
    // chooser so Flatpak receives a document-portal grant and compromised
    // renderer content cannot turn this helper into an arbitrary file reader.
    if (
      dbFilePath &&
      (basename(dbFilePath) !== "storage.db" ||
        !(await isFileWithinDirectory(
          dbFilePath,
          await getDeletedWorkspacesBasePath(),
        )))
    ) {
      logger.warn("loadDBFile: rejected non-backup supplied path");
      return { error: "DB_FILE_PATH_INVALID" };
    }
    const provided =
      getFakedResult() ??
      (dbFilePath
        ? {
            filePath: dbFilePath,
            filePaths: [dbFilePath],
            canceled: false,
          }
        : undefined);
    const ret =
      provided ??
      (await mainRPC.showOpenDialog({
        properties: ["openFile"],
        title: "Load Workspace",
        buttonLabel: "Load",
        filters: [
          {
            name: "SQLite Database",
            // do we want to support other file format?
            extensions: ["db", "myoxus"],
          },
        ],
        message: "Load Workspace from a Myoxus file",
      }));
    const originalPath = ret.filePaths?.[0];
    if (ret.canceled || !originalPath) {
      logger.info("loadDBFile canceled");
      return { canceled: true };
    }

    // the imported file should not be in app data dir
    if (originalPath.startsWith(await getWorkspacesBasePath())) {
      logger.warn("loadDBFile: db file in app data dir");
      return { error: "DB_FILE_PATH_INVALID" };
    }

    const workspaceId = createWorkspaceImportId();
    let storage = new DocStorage(originalPath);

    // Local recovery accepts only current backups. Legacy SQLite workspaces
    // belong to the server-backed import/migration flow.
    if (!(await storage.validate())) {
      return { error: "DB_FILE_INVALID" };
    }
    if (await containsEditorLocalDatabasePayload(originalPath)) {
      return { error: "DB_FILE_DATABASE_UNSUPPORTED" };
    }

    // Current backup import path; no legacy local-workspace format is retained.
    const internalFilePath = await getSpaceDBPath(
      "local",
      "workspace",
      workspaceId,
    );
    await mkdir(parse(internalFilePath).dir, { recursive: true });
    await copyFile(originalPath, internalFilePath);
    logger.info("loadDBFile: copied workspace into internal storage", {
      workspaceId,
    });

    storage = new DocStorage(internalFilePath);
    await storage.setSpaceId(workspaceId);

    return {
      workspaceId,
    };
  } catch (err) {
    logFileOperationFailure("loadDBFile", err);
    return {
      error: "UNKNOWN_ERROR",
    };
  }
}
