import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { universalId } from "@myoxus/storage";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

// @myoxus/local-store is a NAPI-RS native addon — stub it so tests run
// without a compiled .node binary in the test environment.
//
// DocStoragePool must stub ALL methods that handlers.ts binds at module load
// time (lines 24-61 of storage/handlers.ts). Missing methods are `undefined`,
// and `undefined.bind(POOL)` throws before any test runs.
vi.mock("@myoxus/local-store", () => {
  const noop = async () => {};
  const noopNull = async () => null;
  const noopArr = async () => [];

  class DocStoragePool {
    async connect(_id: string, _path?: string) {}
    async disconnect(_id: string) {}
    async setSpaceId(_id: string, _spaceId: string) {}
    async checkpoint(_id: string) {}
    async get(_id: string) {
      return null;
    }
    async destroy() {}
    // --- methods bound by storage/handlers.ts ---
    pushUpdate = noop;
    getDocSnapshot = noopNull;
    setDocSnapshot = noop;
    getDocUpdates = noopArr;
    markUpdatesMerged = noop;
    deleteDoc = noop;
    getDocClocks = noopArr;
    getDocClock = noopNull;
    getDocIndexedClock = noopNull;
    setDocIndexedClock = noop;
    clearDocIndexedClock = noop;
    getBlob = noopNull;
    setBlob = noop;
    deleteBlob = noop;
    releaseBlobs = noop;
    listBlobs = noopArr;
    getPeerRemoteClocks = noopArr;
    getPeerRemoteClock = noopNull;
    setPeerRemoteClock = noop;
    getPeerPulledRemoteClocks = noopArr;
    getPeerPulledRemoteClock = noopNull;
    setPeerPulledRemoteClock = noop;
    getPeerPushedClocks = noopArr;
    getPeerPushedClock = noopNull;
    setPeerPushedClock = noop;
    clearClocks = noop;
    setBlobUploadedAt = noop;
    getBlobUploadedAt = noopNull;
    crawlDocData = noopNull;
    ftsAddDocument = noop;
    ftsDeleteDocument = noop;
    ftsSearch = noopArr;
    ftsGetDocument = noopNull;
    ftsGetMatches = noopArr;
    ftsFlushIndex = noop;
    ftsIndexState = async () => "ready";
    ftsCompleteRebuild = noop;
    ftsFailRebuild = noop;
    ftsIndexVersion = async () => 0;
  }

  class DocStorage {
    constructor(_path: string) {}
    async connect() {}
    async disconnect() {}
    async validate() {
      return false;
    } // no real .node binary → not valid
    async getDoc(_id: string) {
      return null;
    }
    async pushDocUpdate(_id: string, _update: Uint8Array) {}
    async deleteDoc(_id: string) {}
    async destroy() {}
  }

  return { DocStorage, DocStoragePool };
});

const tmpDir = path.join(__dirname, "tmp");
const appDataPath = path.join(tmpDir, "app-data");

async function pathExists(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

vi.doMock("@myoxus/electron/helper/db/ensure-db", () => ({
  ensureSQLiteDB: async () => ({
    destroy: () => {},
  }),
}));

vi.doMock("@myoxus/electron/helper/main-rpc", () => ({
  mainRPC: {
    getPath: async () => appDataPath,
  },
}));

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  vi.doUnmock("@myoxus/electron/helper/main-rpc");
});

describe("workspace db management", () => {
  test("list local workspace ids", async () => {
    const { listLocalWorkspaceIds } =
      await import("@myoxus/electron/helper/workspace/handlers");
    const validWorkspaceId = "00000000-0000-4000-8000-000000000001";
    const noDbWorkspaceId = "00000000-0000-4000-8000-000000000002";
    const deletedWorkspaceId = "00000000-0000-4000-8000-000000000003";
    const fileEntry = "README.txt";

    const validWorkspacePath = path.join(
      appDataPath,
      "workspaces",
      "local",
      validWorkspaceId,
    );
    const noDbWorkspacePath = path.join(
      appDataPath,
      "workspaces",
      "local",
      noDbWorkspaceId,
    );
    const deletedWorkspacePath = path.join(
      appDataPath,
      "workspaces",
      "local",
      deletedWorkspaceId,
    );
    const deletedWorkspaceTrashPath = path.join(
      appDataPath,
      "deleted-workspaces",
      deletedWorkspaceId,
    );
    const nonDirectoryPath = path.join(
      appDataPath,
      "workspaces",
      "local",
      fileEntry,
    );

    await mkdir(validWorkspacePath, { recursive: true });
    await writeFile(path.join(validWorkspacePath, "storage.db"), "");
    await mkdir(noDbWorkspacePath, { recursive: true });
    await mkdir(deletedWorkspacePath, { recursive: true });
    await writeFile(path.join(deletedWorkspacePath, "storage.db"), "");
    await mkdir(deletedWorkspaceTrashPath, { recursive: true });
    await writeFile(nonDirectoryPath, "not-a-workspace");

    const ids = await listLocalWorkspaceIds();
    expect(ids).toContain(validWorkspaceId);
    expect(ids).not.toContain(noDbWorkspaceId);
    expect(ids).not.toContain(deletedWorkspaceId);
    expect(ids).not.toContain(fileEntry);
  });

  test("trash workspace", async () => {
    const { trashWorkspace } =
      await import("@myoxus/electron/helper/workspace/handlers");
    const workspaceId = "00000000-0000-4000-8000-000000000004";
    const workspacePath = path.join(
      appDataPath,
      "workspaces",
      "local",
      workspaceId,
    );
    await mkdir(workspacePath, { recursive: true });
    await trashWorkspace(
      universalId({ peer: "local", type: "workspace", id: workspaceId }),
    );
    expect(await pathExists(workspacePath)).toBe(false);
    // removed workspace will be moved to deleted-workspaces
    expect(
      await pathExists(
        path.join(appDataPath, "deleted-workspaces", workspaceId),
      ),
    ).toBe(true);
  });

  test("delete workspace", async () => {
    const { deleteWorkspace } =
      await import("@myoxus/electron/helper/workspace/handlers");
    const workspaceId = "00000000-0000-4000-8000-000000000005";
    const workspacePath = path.join(
      appDataPath,
      "workspaces",
      "local",
      workspaceId,
    );
    await mkdir(workspacePath, { recursive: true });
    await deleteWorkspace(
      universalId({ peer: "local", type: "workspace", id: workspaceId }),
    );
    expect(await pathExists(workspacePath)).toBe(false);
    // deleted workspace will remove it permanently
    expect(
      await pathExists(
        path.join(appDataPath, "deleted-workspaces", workspaceId),
      ),
    ).toBe(false);
  });

  test("reports a failed permanent delete to its caller", async () => {
    const { deleteWorkspace } =
      await import("@myoxus/electron/helper/workspace/handlers");

    await expect(
      deleteWorkspace(
        universalId({
          peer: "local",
          type: "workspace",
          id: "00000000-0000-4000-8000-000000000006",
        }),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
