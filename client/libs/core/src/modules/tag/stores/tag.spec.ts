// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import {
  archiveWorkspaceTagMutation,
  bootstrapWorkspaceTagsMutation,
  createWorkspaceTagMutation,
  deleteWorkspaceTagPermanentlyMutation,
  recolorWorkspaceTagMutation,
  renameWorkspaceTagMutation,
  restoreWorkspaceTagMutation,
  setDocumentWorkspaceTagsMutation,
  updateWorkspaceTagDescriptionMutation,
  workspaceTagCatalogQuery,
  workspaceTagsQuery,
  documentWorkspaceTagAssignmentsQuery,
  workspaceTagDocumentUsagesQuery,
  workspaceTagDatabaseRowUsagesQuery,
} from "@myoxus/graphql";
import { Framework } from "@myoxus/infra";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { GraphQLService, WorkspaceServerService } from "../../server";
import { WorkspaceService } from "../../workspace";
import { WorkspaceMetaImpl } from "../../workspace/impls/meta";
import { Subject } from "rxjs";
import { TagStore } from "./tag";
const workspaceId = "10000000-0000-4000-8000-000000000001";
const serverTagId = "20000000-0000-4000-8000-000000000001";
const createdTagId = "20000000-0000-4000-8000-000000000002";
const cleanups: (() => void)[] = [];
let online = true;
let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  online = true;
  visibility = "visible";
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const settle = () => vi.advanceTimersByTimeAsync(0);
function serverTag(
  overrides: Partial<{
    id: string;
    name: string;
    slug: string;
    colorRole: string;
    description: string | null;
    archived: boolean;
  }> = {},
) {
  return {
    id: overrides.id ?? serverTagId,
    workspaceId,
    name: overrides.name ?? "Project",
    slug: overrides.slug ?? "project",
    colorRole: overrides.colorRole ?? "tag.blue",
    description:
      overrides.description === undefined
        ? "Canonical project description"
        : overrides.description,
    archived: overrides.archived ?? false,
    archivedAt: overrides.archived ? "2026-07-10T12:00:00Z" : null,
    createdAt: "2026-07-10T10:00:00Z",
    updatedAt: "2026-07-10T11:00:00Z",
  };
}

function createHarness({
  local = false,
  serverTags = [serverTag()],
}: { local?: boolean; serverTags?: ReturnType<typeof serverTag>[] } = {}) {
  const root = new YDoc();
  const meta = new WorkspaceMetaImpl(root);
  meta.initialize();
  meta.setProperties({
    tags: {
      options: [
        { id: "legacy-project", value: "Legacy project", color: "tag.blue" },
      ],
    },
  });
  meta.addDocMeta({
    id: "legacy-doc",
    title: "Preserved document",
    createDate: 1,
    tags: ["legacy-project"],
  });
  const docs = new Map([
    [
      "legacy-doc",
      {
        id: "legacy-doc",
        get meta() {
          return meta.getDocMeta("legacy-doc");
        },
      },
    ],
  ]);
  const original = encodeStateAsUpdate(root);
  let catalog = [...serverTags];
  const assignments = new Map<string, string[] | null>([
    ["legacy-doc", [serverTagId]],
  ]);
  let failedRead: string | null = null;
  let deleteError: unknown = null;
  let holdAssignment: (() => Promise<void>) | null = null;
  let readConcurrency = 0,
    maxReadConcurrency = 0;
  const queries = new Set([
    workspaceTagCatalogQuery,
    workspaceTagsQuery,
    documentWorkspaceTagAssignmentsQuery,
    workspaceTagDocumentUsagesQuery,
    workspaceTagDatabaseRowUsagesQuery,
  ]);
  const usageOffsets: number[] = [];
  let usagePages: Record<
    number,
    {
      items: { externalId: string; title: string }[];
      nextOffset: number | null;
    }
  > = {
    0: {
      items: [{ externalId: "legacy-doc", title: "Preserved document" }],
      nextOffset: null,
    },
  };
  const gql = vi.fn(async ({ query, variables }) => {
    if (local) throw new Error("Local workspace must never contact GraphQL");
    const read = queries.has(query);
    if (read) {
      readConcurrency++;
      maxReadConcurrency = Math.max(maxReadConcurrency, readConcurrency);
    }
    try {
      if (failedRead === query.id) throw new Error("Read unavailable");
      if (query === workspaceTagsQuery)
        return { workspace: { workspaceTags: catalog } };
      if (query === workspaceTagCatalogQuery)
        return {
          workspace: {
            workspaceTagCatalog: catalog.map((tag) => ({
              tag,
              documentCount: [...assignments.values()].filter((ids) =>
                ids?.includes(tag.id),
              ).length,
              databaseRowCount: 0,
            })),
          },
        };
      if (query === documentWorkspaceTagAssignmentsQuery) {
        const rows = variables.externalIds.map((id: string) => ({
          externalId: id,
          tagIds: assignments.get(id) ?? null,
        }));
        const hold = holdAssignment;
        holdAssignment = null;
        if (hold) await hold();
        return {
          workspace: { id: workspaceId, documentWorkspaceTagAssignments: rows },
        };
      }
      if (query === workspaceTagDocumentUsagesQuery) {
        usageOffsets.push(variables.offset);
        return {
          workspace: {
            id: workspaceId,
            workspaceTagDocumentUsages: usagePages[variables.offset],
          },
        };
      }
      if (query === workspaceTagDatabaseRowUsagesQuery)
        return { workspace: { workspaceTagDatabaseRowUsages: [] } };
      if (query === bootstrapWorkspaceTagsMutation)
        throw new Error("Retired bootstrap called");
      if (query === setDocumentWorkspaceTagsMutation) {
        assignments.set(variables.input.docId, [...variables.input.tagIds]);
        return { setDocumentWorkspaceTags: [...variables.input.tagIds] };
      }
      if (query === createWorkspaceTagMutation) {
        const tag = serverTag({
          id: createdTagId,
          name: variables.input.name,
          colorRole: variables.input.colorRole,
          description: variables.input.description,
        });
        catalog.push(tag);
        return { createWorkspaceTag: tag };
      }
      if (query === deleteWorkspaceTagPermanentlyMutation) {
        if (deleteError) throw deleteError;
        catalog = catalog.filter((tag) => tag.id !== variables.input.tagId);
        for (const [id, ids] of assignments)
          if (ids)
            assignments.set(
              id,
              ids.filter((tag) => tag !== variables.input.tagId),
            );
        return { deleteWorkspaceTagPermanently: true };
      }
      const lifecycle = [
        [
          renameWorkspaceTagMutation,
          "renameWorkspaceTag",
          { name: variables.input.name },
        ],
        [
          recolorWorkspaceTagMutation,
          "recolorWorkspaceTag",
          { colorRole: variables.input.colorRole },
        ],
        [
          updateWorkspaceTagDescriptionMutation,
          "updateWorkspaceTagDescription",
          { description: variables.input.description },
        ],
        [
          archiveWorkspaceTagMutation,
          "archiveWorkspaceTag",
          { archived: true },
        ],
        [
          restoreWorkspaceTagMutation,
          "restoreWorkspaceTag",
          { archived: false },
        ],
      ] as const;
      const operation = lifecycle.find(([candidate]) => candidate === query);
      if (!operation)
        throw new Error(`Unexpected GraphQL operation ${query.id}`);
      const current = catalog.find((tag) => tag.id === variables.input.tagId)!;
      const tag = { ...current, ...operation[2] };
      catalog = catalog.map((item) => (item.id === tag.id ? tag : item));
      return { [operation[1]]: tag };
    } finally {
      if (read) readConcurrency--;
    }
  });
  const framework = new Framework();
  const fixture = framework as any;
  fixture.service(WorkspaceService, {
    workspace: {
      id: workspaceId,
      flavour: local ? "local" : "cloud",
      rootYDoc: root,
      docCollection: {
        meta,
        docs,
        doc: root,
        slots: { docListUpdated: new Subject() },
      },
    },
  });
  fixture.service(WorkspaceServerService, {
    server: {
      scope: {
        get: (token: unknown) => {
          expect(token).toBe(GraphQLService);
          return { gql };
        },
      },
    },
  });
  framework.store(TagStore, [WorkspaceService, WorkspaceServerService]);
  const store = framework.provider().get(TagStore);
  cleanups.push(() => {
    store.dispose();
    root.destroy();
  });
  return {
    store,
    gql,
    root,
    meta,
    original,
    assignments,
    usageOffsets,
    setCatalog: (next: ReturnType<typeof serverTag>[]) => {
      catalog = next;
    },
    failRead: (query: { id: string } | null) => {
      failedRead = query?.id ?? null;
    },
    failDelete: (error: unknown) => {
      deleteError = error;
    },
    holdAssignment: (wait: () => Promise<void>) => {
      holdAssignment = wait;
    },
    usagePages: (pages: typeof usagePages) => {
      usagePages = pages;
    },
    maxReadConcurrency: () => maxReadConcurrency,
  };
}

describe("TagStore canonical authority", () => {
  test("a newer list projection fences an older standalone assignment response", async () => {
    const h = createHarness();
    let release!: () => void;
    h.holdAssignment(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const state = h.store.pageTagState$("legacy-doc");
    const sub = state.subscribe();
    await settle();
    h.assignments.set("legacy-doc", []);
    h.store.primeInventory(
      {
        workspace: { id: workspaceId, workspaceTags: [serverTag()] },
        documentMetadataIndex: [
          { docId: "canonical", externalId: "legacy-doc", tagIds: [] },
        ],
      } as never,
      h.store.inventoryRevision,
    );
    const observed: (string[] | null)[] = [];
    const afterPrime = state.subscribe((value) => observed.push(value.ids));
    release();
    await settle();
    expect(state.value).toMatchObject({ status: "ready", ids: [] });
    expect(observed.every((ids) => ids !== null && ids.length === 0)).toBe(
      true,
    );
    afterPrime.unsubscribe();
    sub.unsubscribe();
  });

  test("publishes indexed labels synchronously for 300 rows without assignment or count reads", async () => {
    const h = createHarness();
    h.store.primeInventory(
      {
        workspace: { id: workspaceId, workspaceTags: [serverTag()] },
        documentMetadataIndex: Array.from({ length: 300 }, (_, i) => ({
          docId: `canonical-${i}`,
          externalId: `doc-${i}`,
          tagIds: i % 2 ? [] : [serverTagId],
        })),
      } as never,
      h.store.inventoryRevision,
    );
    const states = Array.from({ length: 300 }, (_, i) =>
      h.store.pageTagState$(`doc-${i}`),
    );
    expect(states[0].value).toMatchObject({
      status: "ready",
      ids: [serverTagId],
    });
    expect(states[1].value).toMatchObject({ status: "ready", ids: [] });
    const subscriptions = states.map((state) => state.subscribe());
    const catalog = h.store.catalogState$.subscribe();
    await settle();
    expect(h.gql).not.toHaveBeenCalled();
    const counts = h.store.catalogWithCountsState$.subscribe();
    await settle();
    expect(
      h.gql.mock.calls.filter(
        ([call]) => call.query === workspaceTagCatalogQuery,
      ),
    ).toHaveLength(1);
    expect(h.store.catalogWithCountsState$.value.tags[0].documentCount).toBe(1);
    expect(
      h.gql.mock.calls.filter(
        ([call]) => call.query === documentWorkspaceTagAssignmentsQuery,
      ),
    ).toHaveLength(0);
    counts.unsubscribe();
    catalog.unsubscribe();
    subscriptions.forEach((sub) => sub.unsubscribe());
  });

  test("a newly mounted row does not reread fresh assignments or usage totals", async () => {
    const h = createHarness();
    const first = h.store.pageTagState$("legacy-doc").subscribe();
    await settle();
    h.assignments.set("new-doc", []);
    const second = h.store.pageTagState$("new-doc").subscribe();
    await settle();
    expect(
      h.gql.mock.calls.filter(([call]) => call.query === workspaceTagsQuery),
    ).toHaveLength(1);
    expect(
      h.gql.mock.calls.filter(
        ([call]) => call.query === workspaceTagCatalogQuery,
      ),
    ).toHaveLength(0);
    expect(
      h.gql.mock.calls
        .filter(([call]) => call.query === documentWorkspaceTagAssignmentsQuery)
        .map(([call]) => call.variables.externalIds),
    ).toEqual([["legacy-doc"], ["new-doc"]]);
    first.unsubscribe();
    second.unsubscribe();
  });

  test("an index begun before a Tag write cannot overwrite the acknowledged assignment", async () => {
    const h = createHarness();
    await h.store.waitUntilReady();
    const revision = h.store.inventoryRevision;
    await h.store.setPageTags("legacy-doc", []);
    h.store.primeInventory(
      {
        workspace: { id: workspaceId, workspaceTags: [serverTag()] },
        documentMetadataIndex: [
          {
            docId: "canonical",
            externalId: "legacy-doc",
            tagIds: [serverTagId],
          },
        ],
      } as never,
      revision,
    );
    expect(h.store.pageTagState$("legacy-doc").value.ids).toEqual([]);
  });

  test("distinguishes loading, confirmed empty, and unavailable without reading or projecting legacy metadata", async () => {
    const h = createHarness({ serverTags: [] });
    h.assignments.set("legacy-doc", []);
    const state = h.store.pageTagState$("legacy-doc");
    expect(state.value).toMatchObject({ status: "loading", ids: null });
    const sub = state.subscribe();
    await settle();
    expect(h.store.catalogState$.value).toMatchObject({
      status: "ready",
      tags: [],
    });
    expect(state.value).toMatchObject({ status: "ready", ids: [] });
    h.assignments.set("legacy-doc", null);
    await h.store.refresh();
    expect(state.value).toMatchObject({ status: "error", ids: [] });
    expect(encodeStateAsUpdate(h.root)).toEqual(h.original);
    expect(
      h.gql.mock.calls.every(
        ([call]) => call.query !== bootstrapWorkspaceTagsMutation,
      ),
    ).toBe(true);
    sub.unsubscribe();
  });

  test("observes external writes in one five-second cycle and ignores pure Yjs replay", async () => {
    const h = createHarness({
      serverTags: [
        serverTag(),
        serverTag({ id: createdTagId, name: "External", archived: true }),
      ],
    });
    const ids = h.store.watchPageTags("legacy-doc");
    const sub = ids.subscribe();
    await settle();
    expect(ids.value).toEqual([serverTagId]);
    h.meta.setDocMeta("legacy-doc", { tags: ["stale-yjs"] });
    h.meta.setProperties({ tags: { options: [] } });
    expect(ids.value).toEqual([serverTagId]);
    h.assignments.set("legacy-doc", [createdTagId, serverTagId]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ids.value).toEqual([createdTagId, serverTagId]);
    expect(h.meta.getDocMeta("legacy-doc")?.tags).toEqual(["stale-yjs"]);
    expect(
      h.gql.mock.calls.every(([call]) => queriesReadOnly(call.query)),
    ).toBe(true);
    sub.unsubscribe();
  });

  test("deduplicates consumers and bounded assignment batches, then stops unobserved work", async () => {
    const h = createHarness();
    const subs = [];
    for (let i = 0; i < 201; i++) {
      const id = `doc-${i}`;
      h.assignments.set(id, []);
      subs.push(
        h.store.pageTagState$(id).subscribe(),
        h.store.pageTagState$(id).subscribe(),
      );
    }
    await settle();
    const reads = h.gql.mock.calls.filter(
      ([call]) => call.query === documentWorkspaceTagAssignmentsQuery,
    );
    expect(reads.map(([call]) => call.variables.externalIds.length)).toEqual([
      200, 1,
    ]);
    expect(
      new Set(reads.flatMap(([call]) => call.variables.externalIds)).size,
    ).toBe(201);
    expect(h.maxReadConcurrency()).toBe(1);
    subs.forEach((sub) => sub.unsubscribe());
    const count = h.gql.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.gql).toHaveBeenCalledTimes(count);
  });

  test("suspends hidden/offline reads and writes, retains confirmed values and refreshes on focus/reconnect", async () => {
    const h = createHarness();
    const state = h.store.pageTagState$("legacy-doc");
    const sub = state.subscribe();
    await settle();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    const before = h.gql.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.gql).toHaveBeenCalledTimes(before);
    online = false;
    window.dispatchEvent(new Event("offline"));
    expect(state.value).toMatchObject({ status: "error", ids: [serverTagId] });
    await expect(h.store.setPageTags("legacy-doc", [])).rejects.toThrow(
      "offline",
    );
    h.assignments.set("legacy-doc", []);
    visibility = "visible";
    online = true;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(state.value).toMatchObject({ status: "ready", ids: [] });
    h.assignments.set("legacy-doc", [serverTagId]);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(state.value.ids).toEqual([serverTagId]);
    sub.unsubscribe();
    h.store.dispose();
    const calls = h.gql.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.gql).toHaveBeenCalledTimes(calls);
  });

  test("keeps the last confirmed catalog/assignment on failures and recovers without a poisoned readiness promise", async () => {
    const h = createHarness();
    h.failRead(workspaceTagsQuery);
    await expect(h.store.waitUntilReady()).rejects.toThrow("Read unavailable");
    h.failRead(null);
    await h.store.retry();
    const state = h.store.pageTagState$("legacy-doc");
    const sub = state.subscribe();
    await settle();
    h.failRead(documentWorkspaceTagAssignmentsQuery);
    await h.store.refresh();
    expect(state.value).toMatchObject({ status: "error", ids: [serverTagId] });
    h.failRead(null);
    await h.store.retry();
    expect(state.value.status).toBe("ready");
    h.setCatalog([serverTag({ colorRole: "unknown" })]);
    await h.store.refresh();
    expect(h.store.catalogState$.value).toMatchObject({
      status: "error",
      tags: [expect.objectContaining({ id: serverTagId, color: "tag.blue" })],
    });
    sub.unsubscribe();
  });

  test("does not let an in-flight stale read overwrite an acknowledged complete replacement", async () => {
    const h = createHarness();
    const state = h.store.pageTagState$("legacy-doc");
    const sub = state.subscribe();
    await settle();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.holdAssignment(() => barrier);
    const refresh = h.store.refresh();
    await settle();
    await h.store.setPageTags("legacy-doc", []);
    expect(state.value.ids).toEqual([]);
    const observed: (string[] | null)[] = [];
    const afterAck = state.subscribe((value) => observed.push(value.ids));
    release();
    await refresh;
    expect(state.value.ids).toEqual([]);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((ids) => ids !== null && ids.length === 0)).toBe(
      true,
    );
    afterAck.unsubscribe();
    expect(h.maxReadConcurrency()).toBe(1);
    sub.unsubscribe();
  });

  test("follows empty ACL-filtered usage pages without overlapping traversals or duplicating observers", async () => {
    const h = createHarness();
    h.usagePages({
      0: { items: [], nextOffset: 200 },
      200: {
        items: [{ externalId: "legacy-doc", title: "Visible" }],
        nextOffset: null,
      },
    });
    const a = h.store.documentUsageState$(serverTagId);
    const b = h.store.documentUsageState$(serverTagId);
    const x = a.subscribe(),
      y = b.subscribe();
    await settle();
    expect(h.usageOffsets).toEqual([0, 200]);
    expect(a.value.ids).toEqual(["legacy-doc"]);
    expect(b.value.ids).toEqual(["legacy-doc"]);
    h.failRead(workspaceTagDocumentUsagesQuery);
    await h.store.refresh();
    expect(a.value).toMatchObject({ status: "error", ids: ["legacy-doc"] });
    x.unsubscribe();
    y.unsubscribe();
  });

  test("keeps creation, metadata, lifecycle and copy writes canonical and never changes the live root", async () => {
    const h = createHarness();
    await h.store.waitUntilReady();
    const created = await h.store.createNewTag(
      "Created",
      "tag.green",
      "Description",
    );
    expect(created).toMatchObject({
      id: createdTagId,
      description: "Description",
    });
    await h.store.renameTag(createdTagId, "Renamed");
    await h.store.recolorTag(createdTagId, "tag.red");
    await h.store.updateTagDescription(createdTagId, "Updated description");
    await h.store.archiveTag(createdTagId);
    await h.store.restoreTag(createdTagId);
    await h.store.setPageTags(
      "legacy-doc",
      [serverTagId, createdTagId],
      "source-doc",
    );
    expect(h.gql).toHaveBeenCalledWith({
      query: setDocumentWorkspaceTagsMutation,
      variables: {
        input: {
          workspaceId,
          docId: "legacy-doc",
          tagIds: [serverTagId, createdTagId],
          copyFromDocId: "source-doc",
        },
      },
    });
    h.failDelete(new Error("Delete denied"));
    await expect(h.store.deleteTagPermanently(createdTagId)).rejects.toThrow(
      "Delete denied",
    );
    expect(h.store.watchTagInfo(createdTagId).value).toBeDefined();
    h.failDelete(null);
    await h.store.deleteTagPermanently(createdTagId);
    expect(h.store.watchTagInfo(createdTagId).value).toBeUndefined();
    expect(encodeStateAsUpdate(h.root)).toEqual(h.original);
  });

  test("isolates native local catalog/assignment editing and observation from every server call", async () => {
    const h = createHarness({ local: true });
    const state = h.store.pageTagState$("legacy-doc");
    const sub = state.subscribe();
    await h.store.waitUntilReady();
    expect(state.value.ids).toEqual(["legacy-project"]);
    const created = await h.store.createNewTag(
      "Local",
      "tag.green",
      "Local description",
    );
    await h.store.setPageTags("legacy-doc", [created.id, "legacy-project"]);
    expect(state.value.ids).toEqual([created.id, "legacy-project"]);
    await h.store.archiveTag(created.id);
    expect(h.store.watchTagInfo(created.id).value?.archived).toBe(true);
    await h.store.deleteTagPermanently(created.id);
    expect(state.value.ids).toEqual(["legacy-project"]);
    expect(h.gql).not.toHaveBeenCalled();
    sub.unsubscribe();
  });
});
function queriesReadOnly(query: unknown) {
  return [
    workspaceTagCatalogQuery,
    workspaceTagsQuery,
    documentWorkspaceTagAssignmentsQuery,
    workspaceTagDocumentUsagesQuery,
    workspaceTagDatabaseRowUsagesQuery,
  ].includes(query as never);
}
