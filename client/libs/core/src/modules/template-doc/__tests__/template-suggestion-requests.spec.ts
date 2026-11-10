// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { TemplateSuggestionSurface } from "@myoxus/graphql";
import { LiveData } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import {
  type TemplateSuggestionMenuState,
  TemplateDocService,
} from "../services/template-doc";

const initialState = (): TemplateSuggestionMenuState => ({
  status: "idle",
  surface: null,
  items: [],
  emptyDocumentAllowed: true,
  reconcileRequired: false,
  stale: false,
  hasNextPage: false,
  endCursor: null,
  error: null,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const response = (templateId: string, category: string | null = null) => ({
  workspace: {
    templateSuggestions: {
      items: [
        {
          templateId,
          templateDocId: `doc-${templateId}`,
          slug: templateId,
          title: templateId,
          description: null,
          category,
          source: "bundle",
          titlePolicy: "template",
          sourceRevisionId: `revision-${templateId}`,
          updatedAt: "2026-10-11T00:00:00Z",
          tags: [],
          score: 1,
          reasons: [],
          instanceState: "ok",
          available: true,
          protectedSource: false,
        },
      ],
      emptyDocumentAllowed: true,
      reconcileRequired: false,
      stale: false,
      hasNextPage: false,
      endCursor: null as string | null,
    },
  },
});

function serviceWithGraphql(gql: ReturnType<typeof vi.fn>) {
  const service = Object.create(
    TemplateDocService.prototype,
  ) as TemplateDocService & Record<string, unknown>;
  Object.assign(service, {
    templateSuggestions$: new LiveData(initialState()),
    suggestionGeneration: 0,
    sourceMetadata$: new LiveData({
      inventory: initialState(),
      metadata: {},
      key: null,
    }),
    metadataCache: {
      getIndexRowByExternalId: (id: string) =>
        id === "unbound-reader-copy" ? { templateState: "guide" } : undefined,
      watchIndexRows: () => new LiveData([]),
    },
    metadataGeneration: 0,
    metadataEpoch: 0,
    list: {
      getTemplateDocs: () => [],
      templateDocs$: new LiveData([]),
      templateOrigins$: new LiveData(new Map()),
    },
    builtinReconciler: {
      bindings$: new LiveData({}),
      reconcile: vi.fn(async () => {}),
      applyPageDefaultReplacements: vi.fn(async () => {}),
    },
    workspaceService: { workspace: { id: "workspace", flavour: "cloud" } },
    workspaceServerService: {
      server: {
        account$: new LiveData({ id: "actor" }),
        scope: { get: () => ({ gql }) },
      },
    },
    defaultServerService: { server: null },
  });
  return service;
}

test("a source materialized after an empty Registry read acquires its file category in the consuming picker", async () => {
  const service = serviceWithGraphql(
    vi.fn(async () => response("new-source", "journal-daily")),
  );
  Object.assign(service, {
    list: {
      getTemplateDocs: () => [{ id: "doc-new-source" }, { id: "custom" }],
      templateOrigins$: new LiveData(new Map()),
    },
    builtinReconciler: {
      bindings$: new LiveData({}),
      applyPageDefaultReplacements: vi.fn(async () => {}),
    },
  });
  expect(service.getTemplateDocs({ include: ["journal-daily"] })).toEqual([]);
  await service.loadTemplateSuggestions({
    surface: TemplateSuggestionSurface.JournalOnboarding,
  });
  expect(
    service
      .getTemplateDocs({ include: ["journal-daily"] })
      .map((doc) => doc.id),
  ).toEqual(["doc-new-source"]);
  expect(
    service.getTemplateDocs({ exclude: ["onboarding"] }).map((doc) => doc.id),
  ).toEqual(["doc-new-source", "custom"]);
});

test.each(["cloud", "local"])(
  "custom classification partitions discovery and suggestions in %s workspaces",
  async (flavour) => {
    const empty = response("unused");
    empty.workspace.templateSuggestions.items = [];
    const gql = vi.fn(async () => empty);
    const service = serviceWithGraphql(gql);
    const reconcile = vi.fn(async () => {});
    const loading$ = new LiveData(flavour === "local");
    const docs = [
      { id: "section", category: "building-blocks" },
      { id: "ordinary", category: null },
      { id: "unbound-reader-copy", category: null },
    ].map(({ id, category }) => ({
      id,
      meta$: new LiveData({ title: id }),
      updatedAt$: new LiveData(null),
      templateAttribution$: new LiveData(undefined),
      templateClassification$: new LiveData({ category, tags: ["projects"] }),
    }));
    Object.assign(service, {
      workspaceService: { workspace: { id: "workspace", flavour } },
      list: {
        getTemplateDocs: () => docs,
        templateDocs$: new LiveData(docs),
        templateOrigins$: new LiveData(new Map()),
      },
      setting: { loading$, builtinTemplateInstanceDocIds$: new LiveData({}) },
      builtinReconciler: {
        bindings$: new LiveData({}),
        reconcile,
        applyPageDefaultReplacements: vi.fn(async () => {}),
      },
    });
    const sections = service.templateDocs$(
      undefined,
      TemplateSuggestionSurface.BuildingBlock,
    );
    if (flavour === "local") {
      expect({
        reactive: sections.value,
        read: service.getTemplateDocs(),
      }).toEqual({ reactive: [], read: [] });
      loading$.setValue(false);
    }
    expect(sections.value.map((doc) => doc.id)).toEqual(["section"]);
    expect(
      service
        .getTemplateDocs(undefined, TemplateSuggestionSurface.StarterBar)
        .map((doc) => doc.id),
    ).toEqual(["ordinary"]);
    const close = service.openTemplateSuggestionMenu({
      surface: TemplateSuggestionSurface.StarterBar,
    });
    const ordinary = await service.templateSuggestions$.waitFor(
      (state) => state.status === "ready",
    );
    expect(reconcile).toHaveBeenCalledTimes(flavour === "local" ? 1 : 0);
    expect(gql).toHaveBeenCalledTimes(flavour === "local" ? 0 : 1);
    close();
    expect(
      ordinary.items.map((item) => [item.templateDocId, item.origin]),
    ).toEqual([["ordinary", flavour === "cloud" ? "unknown" : "custom"]]);
    const blocks = await service.loadTemplateSuggestions({
      surface: TemplateSuggestionSurface.BuildingBlock,
    });
    expect(
      blocks.items.map((item) => [item.templateDocId, item.origin]),
    ).toEqual([["section", flavour === "cloud" ? "unknown" : "custom"]]);
    const rows = await service.loadTemplateSuggestions({
      surface: TemplateSuggestionSurface.DatabaseRowTemplate,
    });
    expect(rows.items).toEqual([]);
  },
);

test("an older selected-source read cannot overwrite a newer picker source policy", async () => {
  const older = deferred<ReturnType<typeof response>>();
  const newer = response("same-source", "journal-daily");
  newer.workspace.templateSuggestions.items[0].titlePolicy = "template-date";
  const gql = vi
    .fn()
    .mockImplementationOnce(() => older.promise)
    .mockResolvedValueOnce(newer)
    .mockResolvedValue({
      workspace: {
        templateSuggestions: {
          ...newer.workspace.templateSuggestions,
          items: [],
        },
      },
    });
  const service = serviceWithGraphql(gql);
  Object.assign(service, {
    builtinReconciler: {
      bindings$: new LiveData({}),
      applyPageDefaultReplacements: vi.fn(async () => {}),
    },
  });
  const pending = service.resolveSourceMetadataForDoc("doc-same-source");
  await service.loadTemplateSuggestions({
    surface: TemplateSuggestionSurface.JournalOnboarding,
  });
  const old = response("same-source", "journal-daily");
  old.workspace.templateSuggestions.items[0].titlePolicy = "date";
  older.resolve(old);
  await expect(pending).resolves.toEqual({
    slug: "same-source",
    source: "bundle",
    category: "journal-daily",
    tags: [],
    titlePolicy: "template-date",
    purpose: "template",
  });
});

describe("Template suggestion request ownership", () => {
  test("a menu publishes page one, shares exactly one unpublished continuation with More and retains usable rows after prefetch failure", async () => {
    const continuation = deferred<ReturnType<typeof response>>();
    const first = response("first");
    first.workspace.templateSuggestions.hasNextPage = true;
    first.workspace.templateSuggestions.endCursor = "page-2";
    const next = response("second");
    next.workspace.templateSuggestions.items.unshift(
      first.workspace.templateSuggestions.items[0],
    );
    next.workspace.templateSuggestions.hasNextPage = true;
    next.workspace.templateSuggestions.endCursor = "page-3";
    const gql = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => continuation.promise)
      .mockRejectedValueOnce(new Error("prefetch offline"))
      .mockResolvedValueOnce(response("last"));
    const service = serviceWithGraphql(gql);
    const options = {
      surface: TemplateSuggestionSurface.AllPagesNewPage,
      locale: "de",
      first: 1,
    };
    const close = service.openTemplateSuggestionMenu(options);
    await service.loadTemplateSuggestions(options);
    expect(gql).toHaveBeenCalledTimes(1);
    expect(
      service.templateSuggestions$.value.items.map((item) => item.templateId),
    ).toEqual(["first"]);
    const prefetch = service.prepareTemplateSuggestionContinuation(options);
    expect(service.prepareTemplateSuggestionContinuation(options)).toBe(
      prefetch,
    );
    expect(
      service.templateSourceMetadata$().value["doc-second"],
    ).toBeUndefined();
    const more = service.loadTemplateSuggestions({
      ...options,
      after: "page-2",
    });
    expect(gql).toHaveBeenCalledTimes(2);
    continuation.resolve(next);
    await more;
    expect(
      service.templateSuggestions$.value.items.map((item) => item.templateId),
    ).toEqual(["first", "second"]);
    expect(service.templateSourceMetadata$().value["doc-second"]).toMatchObject(
      { source: "bundle" },
    );
    expect(gql).toHaveBeenCalledTimes(2);
    await service.prepareTemplateSuggestionContinuation(options);
    expect(service.templateSuggestions$.value).toMatchObject({
      status: "ready",
      hasNextPage: true,
      error: expect.any(Error),
    });
    expect(
      service.templateSuggestions$.value.items.map((item) => item.templateId),
    ).toEqual(["first", "second"]);
    await service.loadTemplateSuggestions({ ...options, after: "page-3" });
    expect(gql).toHaveBeenCalledTimes(4);
    expect(
      service.templateSuggestions$.value.items.map((item) => item.templateId),
    ).toEqual(["first", "second", "last"]);
    close();
  });

  test("closing, context changes and an observed account switch discard buffered metadata and late rows", async () => {
    const stale = deferred<ReturnType<typeof response>>();
    const first = response("first");
    first.workspace.templateSuggestions.hasNextPage = true;
    first.workspace.templateSuggestions.endCursor = "page-2";
    const gql = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(response("new-context"))
      .mockImplementationOnce(() => stale.promise);
    const service = serviceWithGraphql(gql);
    const options = {
      surface: TemplateSuggestionSurface.AllPagesNewPage,
      locale: "en",
      currentDocId: "original",
    };
    const close = service.openTemplateSuggestionMenu(options);
    await service.loadTemplateSuggestions(options);
    const pending = service.prepareTemplateSuggestionContinuation(options);
    const next = { ...options, currentDocId: "different" };
    service.openTemplateSuggestionMenu(next);
    await service.loadTemplateSuggestions(next);
    close(); // An old menu cleanup cannot close the new request owner.
    stale.resolve(response("private-old"));
    await pending;
    expect(
      service.templateSuggestions$.value.items.map((item) => item.templateId),
    ).toEqual(["new-context"]);
    expect(
      service.templateSourceMetadata$().value["doc-private-old"],
    ).toBeUndefined();
    const late = service.loadTemplateSuggestions(next, true);
    service.closeTemplateSuggestionMenu(next);
    await late;
    expect(service.templateSuggestions$.value.status).toBe("idle");
    const account$ = (
      service as unknown as {
        workspaceServerService: {
          server: { account$: LiveData<{ id: string } | null> };
        };
      }
    ).workspaceServerService.server.account$;
    const actorPending = deferred<ReturnType<typeof response>>();
    gql.mockImplementationOnce(() => actorPending.promise);
    service.openTemplateSuggestionMenu(options);
    const actorRead = service.loadTemplateSuggestions(options);
    account$.setValue({ id: "another-actor" });
    account$.setValue({ id: "actor" });
    actorPending.resolve(response("not-for-returned-actor"));
    await actorRead;
    expect(service.templateSuggestions$.value).toMatchObject({
      status: "idle",
      items: [],
    });
  });
  test("Library publishes one page with metadata, then appends only on explicit continuation", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const first = response("same");
    const custom = {
      ...first.workspace.templateSuggestions.items[0],
      source: "custom",
      templateDocId: "same",
    };
    first.workspace.templateSuggestions.items.push(custom);
    first.workspace.templateSuggestions.hasNextPage = true;
    first.workspace.templateSuggestions.endCursor = "page-2";
    const next = response("tail");
    const gql = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce(response("selected"));
    const service = serviceWithGraphql(gql);
    const options = { surface: TemplateSuggestionSurface.Library, first: 200 };
    const load = service.loadTemplateSuggestions(options);
    expect(gql).toHaveBeenCalledTimes(1);
    pending.resolve(first);
    const page = await load;
    expect(service.templateSourceMetadata$().value["doc-same"]).toMatchObject({
      source: "bundle",
      slug: "same",
    });
    expect(page.items.map((item) => [item.templateDocId, item.origin])).toEqual(
      [
        ["doc-same", "imported"],
        ["same", "custom"],
      ],
    );
    expect(gql).toHaveBeenCalledTimes(1);
    expect(gql.mock.calls[0][0].variables.input).toMatchObject({
      surface: "Library",
      first: 200,
    });
    await service.loadTemplateSuggestions(options);
    expect(gql).toHaveBeenCalledTimes(1);
    const more = await service.loadTemplateSuggestions({
      ...options,
      after: page.endCursor,
    });
    expect(gql).toHaveBeenCalledTimes(2);
    expect(more.items.map((item) => item.templateDocId)).toEqual([
      "doc-same",
      "same",
      "doc-tail",
    ]);
    expect(more.hasNextPage).toBe(false);
    await expect(
      service.lookupTemplateSource("doc-selected", "de"),
    ).resolves.toMatchObject({ templateDocId: "doc-selected" });
    expect(gql.mock.calls[2][0].variables.input).toMatchObject({
      surface: "Library",
      first: 1,
      locale: "de",
    });
    expect(gql.mock.calls[2][0].variables.input.library).toEqual({
      sourceDocId: "doc-selected",
    });
    expect(service.templateLibraryInventory$().value).toBe(more);
    const contextual = service.templateSuggestions$.value;
    const source = response("selected");
    gql.mockResolvedValue(source);
    const selection = {
      surface: TemplateSuggestionSurface.AllPagesNewPage,
      locale: "de",
    };
    await expect(
      service.revalidateTemplateSuggestion(
        "selected",
        "doc-selected",
        selection,
        "revision-selected",
      ),
    ).resolves.toBe(true);
    await expect(
      service.revalidateTemplateSuggestion(
        "selected",
        "doc-selected",
        selection,
        "old-revision",
      ),
    ).resolves.toBe(false);
    source.workspace.templateSuggestions.items = [];
    await expect(
      service.revalidateTemplateSuggestion(
        "selected",
        "doc-selected",
        selection,
      ),
    ).resolves.toBe(false);
    expect(service.templateLibraryInventory$().value).toBe(more);
    expect(service.templateSuggestions$.value).toBe(contextual);
  });

  test("Library filter changes discard an older continuation and private invalidation discards late results", async () => {
    const continuation = deferred<ReturnType<typeof response>>();
    const invalidated = deferred<ReturnType<typeof response>>();
    const first = response("first");
    first.workspace.templateSuggestions.hasNextPage = true;
    first.workspace.templateSuggestions.endCursor = "page-2";
    const gql = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => continuation.promise)
      .mockResolvedValueOnce(response("filtered"))
      .mockImplementationOnce(() => invalidated.promise);
    const service = serviceWithGraphql(gql);
    const options = {
      surface: TemplateSuggestionSurface.Library,
      library: { search: "first" },
    };
    const page = await service.loadTemplateSuggestions(options);
    const more = service.loadTemplateSuggestions({
      ...options,
      after: page.endCursor,
    });
    await service.loadTemplateSuggestions({
      ...options,
      library: { search: "filtered" },
    });
    continuation.resolve(response("obsolete"));
    await more;
    expect(
      service
        .templateLibraryInventory$()
        .value.items.map((item) => item.templateId),
    ).toEqual(["filtered"]);
    const late = service.loadTemplateSuggestions({
      ...options,
      library: { search: "late" },
    });
    service.invalidateTemplateSuggestions();
    invalidated.resolve(response("private"));
    await late;
    expect(service.templateLibraryInventory$().value).toMatchObject({
      status: "idle",
      items: [],
      endCursor: null,
    });
  });

  test("a superseded request cannot replace the newer result with its error", async () => {
    const older = deferred<ReturnType<typeof response>>();
    const newer = deferred<ReturnType<typeof response>>();
    const gql = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const service = serviceWithGraphql(gql);

    const olderResult = service.loadTemplateSuggestions({
      surface: TemplateSuggestionSurface.SidebarNewPage,
    });
    const newerResult = service.loadTemplateSuggestions({
      surface: TemplateSuggestionSurface.StarterBar,
    });
    newer.resolve(response("newer"));
    await expect(newerResult).resolves.toMatchObject({
      status: "ready",
      surface: TemplateSuggestionSurface.StarterBar,
      items: [{ templateId: "newer" }],
    });

    older.reject(new Error("older failed"));
    await expect(olderResult).resolves.toMatchObject({
      status: "ready",
      surface: TemplateSuggestionSurface.StarterBar,
      items: [{ templateId: "newer" }],
      error: null,
    });
    expect(service.templateSuggestions$.value.items[0]?.templateId).toBe(
      "newer",
    );
  });
});

test("manual assistant source reads preserve raw revision and discard an observed actor switch even after return", async () => {
  const pending = deferred<{
    workspace: {
      id: string;
      assistantDocumentSource: ReturnType<
        typeof response
      >["workspace"]["templateSuggestions"]["items"][number];
    };
  }>();
  const gql = vi.fn(() => pending.promise);
  const service = serviceWithGraphql(gql);
  const account$ = new LiveData<{ id: string } | null>({ id: "actor-a" });
  Object.assign(service, {
    workspaceServerService: {
      server: { account$, scope: { get: () => ({ gql }) } },
    },
  });
  const input = {
    identity: {
      id: "example.project",
      version: "1.0.0",
      digest: "a".repeat(64),
    },
    step: "setup",
    group: "guides",
    sourceDigest: "b".repeat(64),
  };
  const read = service.resolveAssistantDocumentSource(input, "es");
  account$.setValue({ id: "actor-b" });
  account$.setValue({ id: "actor-a" });
  const source = response("source").workspace.templateSuggestions.items[0];
  pending.resolve({
    workspace: { id: "workspace", assistantDocumentSource: source },
  });
  expect(await read).toBeNull();
  gql.mockResolvedValue({
    workspace: { id: "workspace", assistantDocumentSource: source },
  });
  expect(await service.resolveAssistantDocumentSource(input, "es")).toEqual(
    source,
  );
  expect(gql).toHaveBeenLastCalledWith(
    expect.objectContaining({
      variables: {
        workspaceId: "workspace",
        input: { ...input, locale: "es", clientVersion: 1 },
      },
    }),
  );
});
