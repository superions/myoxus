/**
 * @vitest-environment happy-dom
 */

import { Framework } from "@myoxus/infra";
import { firstValueFrom } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

import type { DocProperties } from "../../db/schema/schema";
import { WorkspaceDBService } from "../../db/services/db";
import { WorkspaceService } from "../../workspace/services/workspace";
import { DocPropertiesStore } from "./doc-properties";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createStore() {
  const doc = new Y.Doc({ guid: "db$docProperties" });
  const create = vi.fn((row: { id: string }) =>
    doc.getMap("rows").set(row.id, row),
  );
  const saved = vi.fn(async (_id: string, _bytes: Uint8Array) => {});
  const loaded = vi.fn(async () => {});
  const framework = new Framework();
  const testFramework = framework as any;
  testFramework.service(WorkspaceService, {
    workspace: {
      flavour: "local",
      engine: {
        doc: {
          saveCapturedUpdateAndWaitForSaved: saved,
          waitForDocLoaded: loaded,
        },
      },
    },
  });
  testFramework.service(WorkspaceDBService, {
    db: {
      docProperties: {
        create,
      },
    },
    getWorkspaceDbDoc: () => doc,
  });
  framework.store(DocPropertiesStore, [WorkspaceService, WorkspaceDBService]);

  const provider = framework.provider();
  cleanups.push(() => {
    provider.dispose();
    doc.destroy();
  });
  return { create, saved, loaded, store: provider.get(DocPropertiesStore) };
}

function createServerBackedStore() {
  const dbAccess = vi.fn(() => {
    throw new Error("server-backed DocPropertiesStore touched WorkspaceDB");
  });
  const rootYDocAccess = vi.fn(() => {
    throw new Error("server-backed DocPropertiesStore touched root Yjs");
  });
  const framework = new Framework();
  const testFramework = framework as any;
  testFramework.service(WorkspaceService, {
    workspace: {
      flavour: "cloud",
      get rootYDoc() {
        return rootYDocAccess();
      },
    },
  });
  testFramework.service(WorkspaceDBService, {
    get db() {
      return dbAccess();
    },
  });
  framework.store(DocPropertiesStore, [WorkspaceService, WorkspaceDBService]);
  return {
    dbAccess,
    rootYDocAccess,
    store: framework.provider().get(DocPropertiesStore),
  };
}

describe("DocPropertiesStore invariants", () => {
  test("server-backed workspaces never read or write local/Yjs properties", async () => {
    const { dbAccess, rootYDocAccess, store } = createServerBackedStore();

    expect(store.getDocProperties("doc-1")).toEqual({ id: "doc-1" });
    expect(await firstValueFrom(store.watchDocProperties("doc-1"))).toEqual({
      id: "doc-1",
    });
    expect(
      store.updateDocProperties("doc-1", {
        createdBy: "server-owned",
        "custom:topic": "not-a-legacy-fallback",
      }),
    ).toBeUndefined();
    expect(
      await firstValueFrom(store.watchPropertyAllValues("createdBy")),
    ).toEqual(new Map());
    expect(() =>
      store.applyOfflineSubsystemProjection("doc-1", {
        journal: "",
        isTemplate: false,
        primaryMode: "page",
        pageWidth: "",
        edgelessColorTheme: "system",
        integrationType: undefined,
      }),
    ).toThrow("only available in local workspaces");
    expect(dbAccess).not.toHaveBeenCalled();
    expect(rootYDocAccess).not.toHaveBeenCalled();
  });

  test("normal updates cannot author server-owned system or subsystem facts", () => {
    const { create, store } = createStore();

    store.updateDocProperties("doc-1", {
      createdBy: "local-user",
      updatedBy: "local-updater",
      pageWidth: "standard",
      journal: "2056-01-20",
      isTemplate: true,
      primaryMode: "edgeless",
      edgelessColorTheme: "dark",
      integrationType: "readwise",
      "custom:topic": "kept",
    } as Partial<DocProperties>);

    expect(create).toHaveBeenCalledExactlyOnceWith({
      id: "doc-1",
      "custom:topic": "kept",
    });
  });

  test("offline subsystem projection can acknowledge the actual property-table bytes", async () => {
    const { create, saved, loaded, store } = createStore();
    let load!: () => void;
    loaded.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          load = resolve;
        }),
    );
    let finish!: () => void;
    saved.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const pending = Promise.resolve(
      store.applyOfflineSubsystemProjection(
        "doc-1",
        {
          journal: "2056-01-20",
          isTemplate: false,
          primaryMode: "page",
          pageWidth: "",
          edgelessColorTheme: "system",
          integrationType: undefined,
        },
        true,
      ),
    );
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    load();
    await Promise.resolve();
    const persisted = new Y.Doc();
    try {
      expect(saved.mock.calls[0][0]).toBe("db$docProperties");
      Y.applyUpdate(persisted, saved.mock.calls[0][1]);
      expect(persisted.getMap("rows").get("doc-1")).toMatchObject({
        primaryMode: "page",
      });
    } finally {
      persisted.destroy();
    }
    finish();
    await pending;

    expect(create).toHaveBeenCalledExactlyOnceWith({
      id: "doc-1",
      journal: "2056-01-20",
      isTemplate: false,
      primaryMode: "page",
      pageWidth: "",
      edgelessColorTheme: "system",
      integrationType: undefined,
    });
  });
});
