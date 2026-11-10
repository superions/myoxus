// SPDX-License-Identifier: AGPL-3.0-or-later

import { UserFriendlyError } from "@myoxus/error";
import { Framework, LiveData } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

// Exercise the real registration while replacing the workspace entity factory;
// cache tests do not materialize an editor or start its worker-backed engine.
vi.mock("../../workspace/services/workspace", async () => {
  const { createIdentifier } = await import("@myoxus/infra");
  return {
    WorkspaceService: createIdentifier("WorkspaceForMetadataCacheTest"),
  };
});

import { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import { WorkspaceServerService } from "../../server/services/workspace-server";
import { WorkspaceService } from "../../workspace/services/workspace";
import { WorkspaceScope } from "../../workspace/scopes/workspace";
import { GuardService } from "../../permissions/services/guard";
import { TagStore } from "../../tag/stores/tag";
import { configureDocumentMetadataModule } from "../module";
import type { DocumentMetadataModel } from "../types";
import {
  DocumentMetadataCacheService,
  DocumentMetadataCacheStore,
} from "./document-metadata-cache";

function model(
  docId: string,
  metadataRevision: number,
  projectionVersion = "v2",
): DocumentMetadataModel {
  return {
    metadata: {
      docId,
      workspaceId: "workspace-1",
      metadataRevision,
      projectionVersion,
    },
    state: {},
    definitions: [],
    lookup: {
      statusValues: [],
      documentTypes: [],
      workspaceMembers: [],
      valueDefinitions: {
        classification: [],
        language: [],
        audience: [],
        retentionPolicy: [],
      },
    },
    validation: {},
  } as unknown as DocumentMetadataModel;
}

function createStore() {
  const framework = new Framework();
  framework.store(DocumentMetadataCacheStore);
  return framework.provider().get(DocumentMetadataCacheStore);
}

function metadata(docId: string, metadataRevision = 1) {
  return {
    docId,
    workspaceId: "workspace-1",
    projectionVersion: "v2",
    metadataRevision,
    metadataUpdatedAt: null,
    metadataUpdatedBy: null,
    system: {
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
      createdBy: null,
      updatedBy: null,
      metadataUpdatedAt: null,
      metadataUpdatedBy: null,
    },
    fields: [],
    audience: [],
    template: null,
    journal: { journalDate: null },
    presentation: null,
    integration: null,
    policy: { locks: [] },
    legacy: {},
  };
}

function responseFor(op: string, variables?: Record<string, unknown>) {
  switch (op) {
    case "documentMetadataIndex":
      return { documentMetadataIndex: [] };
    case "documentMetadata":
      return { documentMetadata: metadata(String(variables?.docId)) };
    case "documentMetadataValidation":
      return {
        documentMetadataValidation: {
          valid: true,
          missingRequiredMetadataFields: [],
          blockedActions: [],
          errors: [],
          warnings: [],
        },
      };
    case "documentMetadataFieldDefinitions":
      return { documentMetadataFieldDefinitions: [] };
    case "documentTypes":
      return { documentTypes: [] };
    case "workspaceDocumentSettings":
      return { workspaceDocumentSettings: { statusSchemaId: "schema-1" } };
    case "documentStatusSchemas":
      return {
        documentStatusSchemas: [{ id: "schema-1", key: "default" }],
      };
    case "documentStatusValues":
      return { documentStatusValues: [] };
    case "getMembersByWorkspaceId":
      return { workspace: { members: [] } };
    case "documentMetadataValueDefinitions":
      return { documentMetadataValueDefinitions: [] };
    default:
      throw new Error(`Unexpected GraphQL operation: ${op}`);
  }
}

function createService(
  responseOverride?: (
    op: string,
    variables?: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown,
  flavour = "affine-cloud",
) {
  const calls: Array<{ op: string; variables?: Record<string, unknown> }> = [];
  const gql = vi.fn(
    async (request: {
      query: { op: string };
      variables?: Record<string, unknown>;
      context?: { signal?: AbortSignal };
    }) => {
      calls.push({ op: request.query.op, variables: request.variables });
      return responseOverride
        ? await responseOverride(
            request.query.op,
            request.variables,
            request.context?.signal,
          )
        : responseFor(request.query.op, request.variables);
    },
  );
  const framework = new Framework();
  const primeIndexedDocPermissions = vi.fn();
  const primeInventory = vi.fn();
  const syncState = new LiveData({ synced: false });
  const testFramework = framework as any;
  testFramework.service(WorkspaceServerService, { server: { gql } });
  testFramework.service(WorkspaceService, {
    workspace: {
      id: "workspace-1",
      flavour,
      engine: { doc: { docState$: () => syncState } },
    },
  });
  testFramework.service(GuardService, { primeIndexedDocPermissions });
  testFramework.service(TagStore, { inventoryRevision: 0, primeInventory });
  framework.scope(WorkspaceScope).store(DocumentLifecycleStore);
  configureDocumentMetadataModule(framework);
  const provider = framework.provider().createScope(WorkspaceScope, {
    openOptions: { metadata: { id: "workspace-1", flavour } },
    engineWorkerInitOptions: { local: {}, remotes: {} },
  });
  return {
    calls,
    provider,
    primeInventory,
    service: provider.get(DocumentMetadataCacheService),
    store: provider.get(DocumentMetadataCacheStore),
    lifecycle: provider.get(DocumentLifecycleStore),
    syncState,
    primeIndexedDocPermissions,
  };
}

function count(calls: Array<{ op: string }>, op: string) {
  return calls.filter((call) => call.op === op).length;
}

describe("DocumentMetadataCacheStore runtime ownership", () => {
  test("keeps models only in workspace memory and ignores stale revisions", () => {
    const store = createStore();
    const current = model("doc-1", 7);
    const stale = model("doc-1", 6);

    expect(store.getModel("doc-1")).toBeNull();
    store.writeModel(current, "documentMetadata");
    expect(store.getModel("doc-1")).toBe(current);
    expect(store.watchModel("doc-1").value).toBe(current);

    store.writeModel(stale, "refresh");
    expect(store.getModel("doc-1")).toBe(current);
  });

  test("lets only acknowledged writes lead the list until an index generation is accepted", () => {
    const store = createStore();
    const opened = model("doc-1", 7);
    const acknowledged = model("doc-1", 8);
    const overrides$ = store.watchListModelOverrides();

    store.writeModel(opened, "documentMetadata");
    expect(store.getListModelOverride("doc-1")).toBeNull();

    store.writeModel(acknowledged, "setDocumentMetadata");
    expect(store.getListModelOverride("doc-1")).toBe(acknowledged);
    expect(overrides$.value.get("doc-1")).toBe(acknowledged);

    store.writeIndexRows("workspace-1", [
      { docId: "doc-1" } as ReturnType<typeof store.getIndexRows>[number],
    ]);
    expect(store.getListModelOverride("doc-1")).toBeNull();
    expect(overrides$.value.size).toBe(0);
  });

  test("clears model, index, lookups and reactive values on workspace disposal", () => {
    const store = createStore();
    const cached = model("doc-1", 7);
    const model$ = store.watchModel("doc-1");
    const index$ = store.watchIndexRows("workspace-1");
    const lookups$ = store.watchIndexLookups("workspace-1");

    store.writeModel(cached, "documentMetadata");
    store.writeIndexRows("workspace-1", [
      { docId: "doc-1" } as ReturnType<typeof store.getIndexRows>[number],
    ]);
    store.writeIndexLookups("workspace-1", {
      statusLabels: { active: "Active" },
      documentTypeLabels: {},
      classificationLabels: {},
      versionLabels: {},
      hydratedKeys: { status: true },
    });

    store.dispose();

    expect(store.getModel("doc-1")).toBeNull();
    expect(store.getIndexRows("workspace-1")).toEqual([]);
    expect(store.getIndexLookups("workspace-1").statusLabels).toEqual({});
    expect(model$.value).toBeNull();
    expect(index$.value).toEqual([]);
    expect(lookups$.value.statusLabels).toEqual({});
  });

  test("normalizes each accepted index snapshot once for canonical and external reads", () => {
    const store = createStore();
    let canonicalReads = 0;
    let externalReads = 0;
    const rows = Array.from({ length: 2 }, (_, index) => {
      const canonicalId = `canonical-${index}`;
      const externalId = `external-${index}`;
      return {
        get docId() {
          canonicalReads += 1;
          return canonicalId;
        },
        get externalId() {
          externalReads += 1;
          return externalId;
        },
      } as ReturnType<typeof store.getIndexRows>[number];
    });

    store.writeIndexRows("workspace-1", rows);

    expect(canonicalReads).toBe(2);
    expect(externalReads).toBe(2);
    for (let index = 0; index < rows.length; index += 1) {
      expect(
        store.getIndexRowByCanonicalId("workspace-1", `canonical-${index}`),
      ).toBe(rows[index]);
      expect(
        store.getIndexRowByExternalId("workspace-1", `external-${index}`),
      ).toBe(rows[index]);
    }
    expect(canonicalReads).toBe(2);
    expect(externalReads).toBe(2);

    const replacement = {
      docId: "replacement-canonical",
      externalId: "replacement-external",
    } as ReturnType<typeof store.getIndexRows>[number];
    const canonicalCollision = {
      docId: "replacement-external",
      externalId: null,
    } as ReturnType<typeof store.getIndexRows>[number];
    store.writeIndexRows("workspace-1", [replacement, canonicalCollision]);

    expect(
      store.getIndexRowByExternalId("workspace-1", "external-0"),
    ).toBeUndefined();
    expect(
      store.getIndexRowByCanonicalId("workspace-1", "replacement-canonical"),
    ).toBe(replacement);
    expect(
      store.getIndexRowByCanonicalId("workspace-1", "replacement-external"),
    ).toBe(canonicalCollision);
    expect(
      store.getIndexRowByExternalId("workspace-1", "replacement-external"),
    ).toBe(replacement);
    store.clearIndexRows("workspace-1");
    expect(
      store.getIndexRowByExternalId("workspace-1", "replacement-external"),
    ).toBeUndefined();
  });
});

describe("DocumentMetadataCacheService hydration", () => {
  test("field metadata waits for creation and stops waiting when cancelled", async () => {
    const { calls, lifecycle, service } = createService();
    lifecycle.beginCreating("doc-1");
    const attempt = new AbortController();
    const pending = service.hydrateMetadataWhenAvailable(
      "doc-1",
      attempt.signal,
    );
    await Promise.resolve();
    expect(count(calls, "documentMetadata")).toBe(0);
    lifecycle.beginAvailableLifecycle("doc-1", "created");
    expect((await pending).docId).toBe("doc-1");
    expect(count(calls, "documentMetadata")).toBe(1);

    lifecycle.beginCreating("doc-2");
    const cancelled = new AbortController();
    const waiting = service.hydrateMetadataWhenAvailable(
      "doc-2",
      cancelled.signal,
    );
    cancelled.abort();
    await expect(waiting).rejects.toThrow();
    expect(count(calls, "documentMetadata")).toBe(1);
  });

  test("shares one workspace index request across concurrent list consumers", async () => {
    const { calls, primeIndexedDocPermissions, primeInventory, service } =
      createService();

    await Promise.all(Array.from({ length: 10 }, () => service.hydrateIndex()));

    expect(count(calls, "documentMetadataIndex")).toBe(1);
    expect(count(calls, "documentMetadata")).toBe(0);
    expect(count(calls, "documentMetadataValidation")).toBe(0);
    expect(primeIndexedDocPermissions).toHaveBeenCalledWith([]);
    expect(primeInventory).toHaveBeenCalledTimes(1);
    expect(primeInventory.mock.invocationCallOrder[0]).toBeLessThan(
      primeIndexedDocPermissions.mock.invocationCallOrder[0],
    );
  });

  test("metadata-only refresh revalidates current read access without fetching members or lookups", async () => {
    let readable = true;
    const failure = new Error("document no longer readable");
    const { calls, service } = createService((op, variables) => {
      if (op === "documentMetadata" && !readable) throw failure;
      return responseFor(op, variables);
    });
    const first = await service.hydrateMetadata("parent");
    readable = false;
    expect(await service.hydrateMetadata("parent")).toBe(first);
    expect(count(calls, "documentMetadata")).toBe(1);
    await expect(
      service.hydrateMetadata("parent", undefined, { refresh: true }),
    ).rejects.toBe(failure);
    expect(count(calls, "documentMetadata")).toBe(2);
    expect(calls.every((call) => call.op === "documentMetadata")).toBe(true);
  });

  test("notifies a lightweight metadata observer without requiring the editor lookup model", async () => {
    const { calls, service } = createService((op) => {
      if (op === "documentMetadata")
        return { documentMetadata: metadata("canonical-doc") };
      return responseFor(op);
    });
    await service.hydrateMetadata("editor-doc");
    const changed = vi.fn();
    const subscription = service
      .watchMetadataChanges("editor-doc")
      .subscribe(changed);
    service.writeMetadata(
      metadata("canonical-doc", 2) as never,
      "setDocumentMetadata",
      "editor-doc",
    );
    expect(changed).toHaveBeenCalledTimes(1);
    service.writeMetadata(
      metadata("canonical-doc", 2) as never,
      "setDocumentMetadata",
      "editor-doc",
    );
    service.writeMetadata(
      metadata("other-doc", 3) as never,
      "setDocumentMetadata",
      "other-doc",
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(calls.every((call) => call.op === "documentMetadata")).toBe(true);
    subscription.unsubscribe();
  });

  test("keeps colliding editor route and SQL identities distinct through updates and deletion", async () => {
    const { service, lifecycle } = createService((op, variables) => {
      if (op === "documentMetadata")
        return {
          documentMetadata: metadata(
            variables?.docId === "moved-route"
              ? "occupied-route"
              : "destination-sql",
          ),
        };
      return responseFor(op, variables);
    });
    const moved = service.watchModel("moved-route");
    const destination = service.watchModel("occupied-route");
    await service.hydrateModel("moved-route");
    await service.hydrateModel("occupied-route");
    expect(moved.value?.metadata.docId).toBe("occupied-route");
    expect(destination.value?.metadata.docId).toBe("destination-sql");
    service.writeMetadata(
      metadata("occupied-route", 2) as never,
      "setDocumentMetadata",
    );
    expect(moved.value?.metadata.metadataRevision).toBe(2);
    expect(destination.value?.metadata.metadataRevision).toBe(1);
    lifecycle.markNotFound("occupied-route");
    expect(destination.value).toBeNull();
    expect(service.getModel("occupied-route")).toBeNull();
    expect(moved.value?.metadata.docId).toBe("occupied-route");
    service.writeMetadata(
      metadata("occupied-route", 3) as never,
      "setDocumentMetadata",
      "moved-route",
    );
    expect(moved.value?.metadata.metadataRevision).toBe(3);
    expect(destination.value).toBeNull();
    lifecycle.markNotFound("moved-route");
    expect(moved.value).toBeNull();
  });

  test("projects canonical metadata updates through the requested editor document ID", async () => {
    const { lifecycle, service, store } = createService((op, variables) => {
      if (op === "documentMetadata") {
        return { documentMetadata: metadata("canonical-doc") };
      }
      return responseFor(op, variables);
    });
    const aliasModel$ = service.watchModel("editor-doc");

    await service.hydrateModel("editor-doc");

    expect(aliasModel$.value?.metadata.docId).toBe("canonical-doc");
    expect(service.getModel("editor-doc")).toBe(
      store.getCanonicalModel("canonical-doc"),
    );

    service.writeMetadata(
      metadata("canonical-doc", 2) as never,
      "setDocumentMetadata",
    );
    expect(aliasModel$.value?.metadata.metadataRevision).toBe(2);

    lifecycle.markNotFound("editor-doc");
    expect(service.getModel("editor-doc")).toBeNull();
    expect(aliasModel$.value).toBeNull();
  });

  test("hydrates a cold editor alias from its acknowledged mutation metadata", async () => {
    const { calls, service, store } = createService((op, variables) => {
      if (op === "documentMetadata") {
        return { documentMetadata: metadata("canonical-doc") };
      }
      return responseFor(op, variables);
    });
    const aliasModel$ = service.watchModel("editor-doc");
    const acknowledged = {
      ...metadata("canonical-doc", 7),
      presentation: { primaryMode: "edgeless" },
    };

    await service.writeMetadataForDocument(
      "editor-doc",
      acknowledged as never,
      "setDocumentMetadata",
    );

    expect(count(calls, "documentMetadata")).toBe(1);
    expect(aliasModel$.value?.metadata).toMatchObject({
      docId: "canonical-doc",
      metadataRevision: 7,
      presentation: { primaryMode: "edgeless" },
    });
    expect(service.getModel("editor-doc")).toBe(
      store.getCanonicalModel("canonical-doc"),
    );
    expect(service.getListModelOverride("editor-doc")).toBe(
      store.getCanonicalModel("canonical-doc"),
    );
  });

  test("rejects local workspace hydration before any GraphQL request", async () => {
    const { calls, service } = createService(undefined, "local");

    await expect(service.hydrateModel("doc-1")).rejects.toThrow(
      "Native document metadata is unavailable in local workspaces",
    );
    await expect(service.hydrateIndex()).rejects.toThrow(
      "Native document metadata is unavailable in local workspaces",
    );
    expect(calls).toEqual([]);
  });

  test("deduplicates ten concurrent consumers and permits an explicit refresh", async () => {
    const { calls, service } = createService();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.hydrateModel("doc-1")),
    );

    expect(results.every((result) => result === results[0])).toBe(true);
    expect(count(calls, "documentMetadata")).toBe(1);
    expect(count(calls, "documentMetadataValidation")).toBe(1);

    await service.hydrateModel("doc-1", { refresh: true });
    expect(count(calls, "documentMetadata")).toBe(2);
    expect(count(calls, "documentMetadataValidation")).toBe(2);
    expect(count(calls, "documentMetadataFieldDefinitions")).toBe(1);
    expect(count(calls, "getMembersByWorkspaceId")).toBe(1);
  });

  test("does not invalidate canonical metadata when document sync state changes", async () => {
    const { calls, service, syncState } = createService();

    const first = await service.hydrateModel("doc-1");
    const stop = service.observeSyncedVersionHead("doc-1");
    syncState.next({ synced: true });
    const second = await service.hydrateModel("doc-1");

    expect(second).toBe(first);
    expect(count(calls, "documentMetadata")).toBe(1);
    expect(count(calls, "documentMetadataValidation")).toBe(1);
    stop();
  });

  test("refreshes a clean named head only after ACK and stops reading once canonical state is dirty", async () => {
    let dirty = false;
    const { calls, service, syncState } = createService((op, variables) => {
      if (op !== "documentMetadata") return responseFor(op, variables);
      return {
        documentMetadata: {
          ...metadata("doc-1", dirty ? 2 : 1),
          fields: [
            {
              key: "version",
              source: "DOCUMENT",
              textValue: dirty ? "dirty" : "show",
              reference: {
                id: "version-1",
                key: "version-1",
                label: "A",
                isActive: true,
              },
              timestampValue: null,
              dateValue: null,
              userId: null,
            },
          ],
        },
      };
    });
    await service.hydrateModel("doc-1");
    const stop = service.observeSyncedVersionHead("doc-1");
    dirty = true;
    syncState.next({ synced: false });
    expect(service.getModel("doc-1")?.state.dirtySinceCurrentVersion).toBe(
      false,
    );
    expect(count(calls, "documentMetadata")).toBe(1);

    syncState.next({ synced: true });
    await vi.waitFor(() =>
      expect(service.getModel("doc-1")?.state).toMatchObject({
        currentVersionId: "version-1",
        currentVersionLabel: "A",
        dirtySinceCurrentVersion: true,
      }),
    );
    syncState.next({ synced: false });
    syncState.next({ synced: true });
    expect(count(calls, "documentMetadata")).toBe(2);
    expect(count(calls, "documentMetadataValidation")).toBe(1);
    stop();
  });

  test("removes a failed in-flight entry and retries only on a new explicit call", async () => {
    let metadataCalls = 0;
    const failure = new Error("metadata unavailable");
    const { calls, service } = createService((op, variables) => {
      if (op === "documentMetadata" && metadataCalls++ === 0) throw failure;
      return responseFor(op, variables);
    });

    await expect(service.hydrateModel("doc-1")).rejects.toBe(failure);
    expect(count(calls, "documentMetadata")).toBe(1);

    await expect(service.hydrateModel("doc-1")).resolves.toMatchObject({
      metadata: { docId: "doc-1" },
    });
    expect(count(calls, "documentMetadata")).toBe(2);
  });

  test("keeps a newer mutation response when it races the initial hydration", async () => {
    let releaseDocument!: () => void;
    const documentGate = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    const initialMetadata = metadata("doc-1", 1);
    const { calls, service } = createService(async (op, variables) => {
      if (op === "documentMetadata") {
        await documentGate;
        return { documentMetadata: initialMetadata };
      }
      return responseFor(op, variables);
    });

    const hydration = service.hydrateModel("doc-1");
    await vi.waitFor(() => {
      expect(count(calls, "documentMetadata")).toBe(1);
    });
    service.writeMetadata(metadata("doc-1", 7) as never, "setDocumentMetadata");
    service.writeMetadata(metadata("doc-1", 6) as never, "setDocumentMetadata");
    releaseDocument();

    await expect(hydration).resolves.toMatchObject({
      metadata: { metadataRevision: 7 },
    });
    expect(initialMetadata.metadataRevision).toBe(1);
    expect(service.getModel("doc-1")?.metadata.metadataRevision).toBe(7);
  });

  test("does not repopulate the workspace after an in-flight index request is cleared", async () => {
    let releaseIndex!: () => void;
    const indexGate = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    const { calls, service, primeInventory } = createService(
      async (op, variables) => {
        if (op === "documentMetadataIndex") {
          await indexGate;
          return { documentMetadataIndex: [{ docId: "stale-doc" }] };
        }
        return responseFor(op, variables);
      },
    );

    const hydration = service.hydrateIndex();
    await vi.waitFor(() => {
      expect(count(calls, "documentMetadataIndex")).toBe(1);
    });
    service.clearWorkspace();
    releaseIndex();
    await hydration;

    expect(service.getIndexRows()).toEqual([]);
    expect(primeInventory).not.toHaveBeenCalled();
  });

  test("fences an invalidated in-flight index and schedules exactly one replacement", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let indexCalls = 0;
    const { calls, service } = createService(async (op, variables) => {
      if (op !== "documentMetadataIndex") return responseFor(op, variables);
      indexCalls += 1;
      if (indexCalls === 1) {
        await firstGate;
        return { documentMetadataIndex: [{ docId: "obsolete-doc" }] };
      }
      return { documentMetadataIndex: [{ docId: "current-doc" }] };
    });

    const readyDocIds: string[] = [];
    const stateSubscription = service.watchIndexState().subscribe((state) => {
      if (state.phase === "ready") {
        readyDocIds.push(...state.rows.map((row) => String(row.docId)));
      }
    });
    const first = service.hydrateIndex();
    await vi.waitFor(() => {
      expect(count(calls, "documentMetadataIndex")).toBe(1);
    });
    service.invalidateIndex("test-write");
    releaseFirst();
    await first;

    await vi.waitFor(() => {
      expect(service.getIndexRows()).toEqual([{ docId: "current-doc" }]);
    });
    expect(count(calls, "documentMetadataIndex")).toBe(2);
    expect(readyDocIds).toEqual(["current-doc"]);
    expect(service.getIndexState()).toMatchObject({
      phase: "ready",
      generation: 1,
    });
    stateSubscription.unsubscribe();
  });

  test("replaces an invalidated in-flight index even when the obsolete request fails", async () => {
    let rejectFirst!: (error: Error) => void;
    const firstGate = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const failure = new Error("obsolete request failed");
    let indexCalls = 0;
    const { calls, service } = createService(async (op, variables) => {
      if (op !== "documentMetadataIndex") return responseFor(op, variables);
      indexCalls += 1;
      if (indexCalls === 1) return firstGate;
      return { documentMetadataIndex: [{ docId: "replacement-doc" }] };
    });

    const first = service.hydrateIndex();
    await vi.waitFor(() => {
      expect(count(calls, "documentMetadataIndex")).toBe(1);
    });
    service.invalidateIndex("test-write");
    rejectFirst(failure);
    await expect(first).rejects.toBe(failure);

    await vi.waitFor(() => {
      expect(service.getIndexRows()).toEqual([{ docId: "replacement-doc" }]);
    });
    expect(count(calls, "documentMetadataIndex")).toBe(2);
    expect(service.getIndexState()).toMatchObject({
      phase: "ready",
      generation: 1,
    });
  });

  test("retains confirmed index rows and exposes an error when refresh fails", async () => {
    let fail = false;
    const failure = new Error("index unavailable");
    const { service } = createService((op, variables) => {
      if (op !== "documentMetadataIndex") return responseFor(op, variables);
      if (fail) throw failure;
      return { documentMetadataIndex: [{ docId: "confirmed-doc" }] };
    });

    await service.hydrateIndex();
    fail = true;
    service.invalidateIndex("test-refresh");
    await expect(service.hydrateIndex()).rejects.toBe(failure);

    expect(service.getIndexRows()).toEqual([{ docId: "confirmed-doc" }]);
    expect(service.getIndexState()).toMatchObject({
      phase: "error",
      rows: [{ docId: "confirmed-doc" }],
      error: failure,
    });
  });

  test("does not repopulate a cleared workspace from an in-flight document hydration", async () => {
    let releaseDocument!: () => void;
    const documentGate = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    const { calls, service } = createService(async (op, variables) => {
      if (op === "documentMetadata") {
        await documentGate;
      }
      return responseFor(op, variables);
    });

    const hydration = service.hydrateModel("doc-1");
    const clearedHydration = expect(hydration).rejects.toThrow(
      "Document metadata workspace lifecycle cleared",
    );
    await vi.waitFor(() => {
      expect(count(calls, "documentMetadata")).toBe(1);
    });
    service.clearWorkspace();
    releaseDocument();
    await clearedHydration;

    expect(service.getModel("doc-1")).toBeNull();
    expect(service.watchModel("doc-1").value).toBeNull();
  });

  test("shares field definitions and members across two document loads", async () => {
    const { calls, service } = createService();

    await Promise.all([
      service.hydrateModel("doc-1"),
      service.hydrateModel("doc-2"),
    ]);
    await service.hydrateIndexLookups();

    expect(count(calls, "documentMetadata")).toBe(2);
    expect(count(calls, "documentMetadataValidation")).toBe(2);
    expect(count(calls, "documentMetadataFieldDefinitions")).toBe(1);
    expect(count(calls, "getMembersByWorkspaceId")).toBe(1);
    for (const op of [
      "documentTypes",
      "workspaceDocumentSettings",
      "documentStatusSchemas",
      "documentStatusValues",
    ]) {
      expect(count(calls, op), op).toBe(2);
    }
    expect(count(calls, "documentMetadataValueDefinitions")).toBe(5);
  });

  test("limits multi-document hydration to eight active metadata GraphQL requests", async () => {
    let active = 0;
    let maxActive = 0;
    const { calls, service } = createService(async (op, variables) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return responseFor(op, variables);
    });
    const ids = Array.from({ length: 12 }, (_, index) => `doc-${index}`);

    await service.hydrateModels([...ids, "doc-1", "doc-2"]);

    expect(maxActive).toBeLessThanOrEqual(8);
    expect(count(calls, "documentMetadata")).toBe(12);
    expect(
      new Set(
        calls
          .filter((call) => call.op === "documentMetadata")
          .map((call) => call.variables?.docId),
      ).size,
    ).toBe(12);
  });

  test("terminates only the missing document and issues no later metadata requests", async () => {
    let docOneMissing = false;
    const notFound = new UserFriendlyError({
      status: 404,
      code: "DOC_NOT_FOUND",
      type: "NOT_FOUND",
      name: "DOC_NOT_FOUND",
      message: "not found: document",
    });
    const { calls, lifecycle, service } = createService((op, variables) => {
      if (
        op === "documentMetadata" &&
        variables?.docId === "doc-1" &&
        docOneMissing
      ) {
        throw notFound;
      }
      return responseFor(op, variables);
    });

    await Promise.all([
      service.hydrateModel("doc-1"),
      service.hydrateModel("doc-2"),
    ]);
    docOneMissing = true;
    await expect(service.hydrateModel("doc-1", { refresh: true })).rejects.toBe(
      notFound,
    );

    expect(lifecycle.state("doc-1")).toBe("not-found");
    expect(lifecycle.state("doc-2")).toBe("available");
    expect(service.getModel("doc-1")).toBeNull();
    const terminalRequestCount = count(calls, "documentMetadata");

    await expect(service.hydrateModel("doc-1")).rejects.toThrow(
      "Document lifecycle is not available",
    );
    expect(count(calls, "documentMetadata")).toBe(terminalRequestCount);
    await expect(
      service.hydrateModel("doc-2", { refresh: true }),
    ).resolves.toMatchObject({ metadata: { docId: "doc-2" } });
    expect(count(calls, "documentMetadata")).toBe(terminalRequestCount + 1);
  });

  test("aborts the sibling metadata request when either response is terminal", async () => {
    const terminal = new UserFriendlyError({
      status: 404,
      code: "DOC_NOT_FOUND",
      type: "NOT_FOUND",
      name: "DOC_NOT_FOUND",
      message: "not found: document",
    });
    let validationAborted = false;
    const { lifecycle, service } = createService((op, variables, signal) => {
      if (op === "documentMetadata" && variables?.docId === "doc-1") {
        throw terminal;
      }
      if (op === "documentMetadataValidation" && variables?.docId === "doc-1") {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              validationAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      return responseFor(op, variables);
    });

    await expect(service.hydrateModel("doc-1")).rejects.toBe(terminal);

    expect(lifecycle.state("doc-1")).toBe("not-found");
    expect(validationAborted).toBe(true);
  });

  test("clears a cached model when another document consumer terminates it", async () => {
    const { calls, lifecycle, service } = createService();
    await service.hydrateModel("doc-1");
    expect(service.getModel("doc-1")).not.toBeNull();

    lifecycle.markNotFound("doc-1");

    expect(service.getModel("doc-1")).toBeNull();
    const requests = count(calls, "documentMetadata");
    await expect(service.hydrateModel("doc-1")).rejects.toThrow(
      "Document lifecycle is not available",
    );
    expect(count(calls, "documentMetadata")).toBe(requests);
  });

  test("rejects late model and mutation projections after terminal state", async () => {
    const { lifecycle, service } = createService();
    lifecycle.markNotFound("doc-1");

    expect(service.writeModel(model("doc-1", 8), "refresh")).toBe(false);
    expect(
      service.writeMetadata(
        metadata("doc-1", 9) as never,
        "setDocumentMetadata",
      ),
    ).toBeNull();
    expect(service.getModel("doc-1")).toBeNull();
  });

  test("multi-document hydration omits a terminal id without hiding peer results", async () => {
    const { lifecycle, service } = createService();
    lifecycle.markNotFound("doc-1");

    const models = await service.hydrateModels(["doc-1", "doc-2"]);

    expect(models.has("doc-1")).toBe(false);
    expect(models.get("doc-2")?.metadata.docId).toBe("doc-2");
  });

  test("omits a document that becomes terminal during bulk hydration", async () => {
    const { lifecycle, service } = createService((op, variables) => {
      if (op === "documentMetadata" && variables?.docId === "deleted-doc") {
        throw new Error("not found: document");
      }
      return responseFor(op, variables);
    });

    const models = await service.hydrateModels([
      "doc-1",
      "deleted-doc",
      "doc-2",
    ]);

    expect([...models.keys()]).toEqual(["doc-1", "doc-2"]);
    expect(lifecycle.state("deleted-doc")).toBe("not-found");
  });

  test("propagates non-document failures from bulk hydration", async () => {
    const { service } = createService((op, variables) => {
      if (op === "documentMetadata" && variables?.docId === "unavailable-doc") {
        throw new Error("metadata service unavailable");
      }
      return responseFor(op, variables);
    });

    await expect(
      service.hydrateModels(["doc-1", "unavailable-doc"]),
    ).rejects.toThrow("Document metadata hydration failed");
  });
});
