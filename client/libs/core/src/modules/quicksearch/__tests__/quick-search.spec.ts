/**
 * @vitest-environment happy-dom
 */

import { type Entity, Framework, LiveData, MemoryMemento } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSource } from "../../../desktop/pages/workspace/search/use-search-results";
import { Observable, of, throwError } from "rxjs";
import { describe, expect, type Mock, test, vi } from "vitest";

import {
  CURATED_WORKSPACE_COMMAND_IDS,
  MyoxusCommandRegistry,
  registerMyoxusCommand,
} from "../../../commands";
import { DocsService } from "../../doc";
import { DocDisplayMetaService } from "../../doc-display-meta";
import { DocsSearchService } from "../../docs-search";
import { GlobalContextService } from "../../global-context";
import { WorkbenchService } from "../../workbench";
import { WorkspaceLocalState, WorkspaceService } from "../../workspace";
import { QuickSearch } from "../entities/quick-search";
import { CollectionsQuickSearchSession } from "../impls/collections";
import { CommandsQuickSearchSession } from "../impls/commands";
import { CreationQuickSearchSession } from "../impls/creation";
import { DatabaseRowsQuickSearchSession } from "../impls/database-rows";
import { DatabasesQuickSearchSession } from "../impls/databases";
import { DocsQuickSearchSession } from "../impls/docs";
import { ExternalLinksQuickSearchSession } from "../impls/external-links";
import { FavoritesQuickSearchSession } from "../impls/favorites";
import { RecentDocsQuickSearchSession } from "../impls/recent-docs";
import { RecentTargetsQuickSearchSession } from "../impls/recent-targets";
import { TagsQuickSearchSession } from "../impls/tags";
import type { QuickSearchSession } from "../providers/quick-search-provider";
import { CMDKQuickSearchService } from "../services/cmdk";
import { QuickSearchService } from "../services/quick-search";
import { RecentWorkspaceItemsService } from "../services/recent-workspace-items";
import type { QuickSearchItem } from "../types/item";
import type { QuickSearchOptions } from "../types/options";

function createSession(items: QuickSearchItem[]): QuickSearchSession<
  "test",
  unknown
> & {
  dispose: Mock<() => void>;
  query: Mock<(query: string) => void>;
} {
  return {
    items$: new LiveData(items),
    query: vi.fn(),
    dispose: vi.fn(),
  };
}

function recentDoc(id: string, updatedDate: number, trash = false) {
  return {
    id,
    trash$: new LiveData(trash),
    meta$: new LiveData({ updatedDate }),
  };
}

function createEntity<T extends Entity>(entity: new (...args: any[]) => T): T {
  const framework = new Framework();
  framework.entity(entity as any);
  return framework.provider().get(entity as any) as T;
}

describe("results page source ownership", () => {
  const identity = (hit: { id: number }) => String(hit.id);
  test("appends beyond 500 by raw offset, retries failures and exhausts only on a short raw page", async () => {
    let fail = true;
    const read = vi.fn(async (_signal: AbortSignal, offset: number) => {
      if (offset === 50 && fail) {
        fail = false;
        throw new Error("temporary append failure");
      }
      if (offset === 550) return [];
      return Array.from({ length: 50 }, (_, index) => ({
        id: offset === 50 ? 49 + index : offset + index,
      }));
    });
    const { result, unmount } = renderHook(() => useSource(read, identity));
    try {
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.items).toHaveLength(50);
      act(() => {
        result.current.loadMore();
        result.current.loadMore();
      });
      await waitFor(() => expect(result.current.error).toBe(true));
      expect(result.current.items).toHaveLength(50);
      expect(read.mock.calls.map((call) => call[1])).toEqual([0, 50]);
      act(() => {
        result.current.retry();
        result.current.retry();
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.items).toHaveLength(99);
      for (let offset = 100; offset <= 500; offset += 50) {
        expect(result.current.hasMore).toBe(true);
        act(() => result.current.loadMore());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(read.mock.calls.at(-1)?.[1]).toBe(offset);
      }
      expect(result.current.items).toHaveLength(549);
      expect(result.current.hasMore).toBe(true);
      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.hasMore).toBe(false));
      expect(read.mock.calls.map((call) => call[1])).toEqual([
        0, 50, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550,
      ]);
      expect(new Set(result.current.items.map(identity)).size).toBe(549);
      act(() => result.current.loadMore());
      expect(read).toHaveBeenCalledTimes(13);
    } finally {
      unmount();
    }
  });
  test("aborts replaced owners and rejects late replies even when transport ignores abort", async () => {
    let resolveOld!: (items: { id: number }[]) => void;
    const oldRead = vi.fn(
      (_signal: AbortSignal, _offset: number) =>
        new Promise<{ id: number }[]>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const newRead = vi.fn(async (_signal: AbortSignal, _offset: number) => [
      { id: 2 },
    ]);
    const { result, rerender, unmount } = renderHook(
      ({ read }) => useSource(read, identity),
      { initialProps: { read: oldRead } },
    );
    try {
      await waitFor(() => expect(oldRead).toHaveBeenCalledOnce());
      rerender({ read: newRead });
      expect(oldRead.mock.calls[0][0].aborted).toBe(true);
      expect(result.current.items).toEqual([]);
      await waitFor(() => expect(result.current.items).toEqual([{ id: 2 }]));
      await act(async () => {
        resolveOld([{ id: 1 }]);
        await Promise.resolve();
      });
      expect(result.current.items).toEqual([{ id: 2 }]);
    } finally {
      unmount();
    }
  });
});

describe("QuickSearch entity", () => {
  test("opens sessions with the default query and aggregates their items", () => {
    const quickSearch = createEntity(QuickSearch);
    const session = createSession([
      { id: "alpha", source: "test", label: "Alpha" },
    ]);
    const callback = vi.fn();

    quickSearch.show([session], callback, { defaultQuery: "alpha" });

    expect(quickSearch.show$.value).toBe(true);
    expect(session.query).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(quickSearch.query$.value).toBe("alpha");
    expect(quickSearch.items$.value).toEqual([
      expect.objectContaining({ id: "alpha" }),
    ]);
  });

  test("updates every session when the query changes", () => {
    const quickSearch = createEntity(QuickSearch);
    const first = createSession([]);
    const second = createSession([]);

    quickSearch.show([first, second], vi.fn());
    quickSearch.setQuery("needle");

    expect(quickSearch.query$.value).toBe("needle");
    expect(first.query).toHaveBeenLastCalledWith("needle");
    expect(second.query).toHaveBeenLastCalledWith("needle");
  });

  test("keeps async source failures local and exposes their retry contract", () => {
    const quickSearch = createEntity(QuickSearch);
    const retry = vi.fn();
    const error$ = new LiveData<unknown>(null);
    const loading$ = new LiveData(false);
    const session = {
      ...createSession([]),
      error$,
      group: { id: "databases", label: "Databases", score: 18 },
      isLoading$: loading$,
      retry,
    };

    quickSearch.show([session], vi.fn());
    error$.next(new Error("offline"));

    expect(quickSearch.error$.value).toBeNull();
    expect(quickSearch.sourceStates$.value).toEqual([
      expect.objectContaining({
        error: expect.any(Error),
        group: session.group,
        loading: false,
        retry: expect.any(Function),
      }),
    ]);
    quickSearch.sourceStates$.value[0]?.retry?.();
    expect(retry).toHaveBeenCalledOnce();
  });

  test("respects beforeSubmit vetoes without closing the active session", () => {
    const quickSearch = createEntity(QuickSearch);
    const session = createSession([]);
    const callback = vi.fn();
    const item = {
      id: "vetoed",
      source: "test",
      label: "Vetoed",
      beforeSubmit: () => false,
    };

    quickSearch.show([session], callback);
    quickSearch.submit(item);

    expect(callback).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(quickSearch.show$.value).toBe(true);
  });

  test("submits the selected item, disposes sessions and closes", () => {
    const quickSearch = createEntity(QuickSearch);
    const session = createSession([]);
    const callback = vi.fn();
    const item = { id: "alpha", source: "test", label: "Alpha" };

    quickSearch.show([session], callback);
    quickSearch.submit(item);

    expect(callback).toHaveBeenCalledExactlyOnceWith(item);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(quickSearch.show$.value).toBe(false);
  });

  test("hide disposes the active sessions and reports cancellation", () => {
    const quickSearch = createEntity(QuickSearch);
    const session = createSession([]);
    const callback = vi.fn();

    quickSearch.show([session], callback);
    quickSearch.hide();

    expect(callback).toHaveBeenCalledExactlyOnceWith(null);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(quickSearch.show$.value).toBe(false);
  });
});

describe("CreationQuickSearchSession", () => {
  test("uses the registered create capabilities and preserves each document mode", () => {
    const cleanups = [
      registerMyoxusCommand({
        id: "myoxus:new-page",
        icon: null,
        label: "New page",
        preconditionStrategy: () => false,
        run: vi.fn(),
      }),
      registerMyoxusCommand({
        id: "myoxus:new-edgeless-page",
        icon: null,
        label: "New edgeless",
        preconditionStrategy: () => true,
        run: vi.fn(),
      }),
    ];
    try {
      const session = createEntity(CreationQuickSearchSession);

      expect(session.items$.value).toEqual([]);
      session.query("  ");
      expect(session.items$.value).toEqual([]);

      session.query("Roadmap");
      expect(session.items$.value).toEqual([
        expect.objectContaining({
          id: "creation:create-edgeless",
          source: "creation",
          payload: { mode: "edgeless", title: "Roadmap" },
        }),
      ]);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });
});

describe("CommandsQuickSearchSession", () => {
  test("uses the curated action order only for an empty query", () => {
    const cleanups = [
      ...CURATED_WORKSPACE_COMMAND_IDS.map((id) =>
        registerMyoxusCommand({
          id,
          category: "myoxus:creation",
          icon: null,
          label: id,
          preconditionStrategy: () => id !== "myoxus:today-journal",
          run: vi.fn(),
        }),
      ),
      registerMyoxusCommand({
        id: "myoxus:unrelated",
        icon: null,
        label: "Unrelated command",
        run: vi.fn(),
      }),
    ];
    try {
      const framework = new Framework();
      framework
        .service(GlobalContextService, {
          globalContext: {
            docMode: { $: new LiveData(null) },
          },
        } as any)
        .entity(CommandsQuickSearchSession, [GlobalContextService]);
      const session = framework
        .provider()
        .createEntity(CommandsQuickSearchSession);

      expect(session.items$.value.map((item) => item.payload.id)).toEqual(
        CURATED_WORKSPACE_COMMAND_IDS.filter(
          (id) => id !== "myoxus:today-journal",
        ),
      );

      session.query("Unrelated");
      expect(session.items$.value.map((item) => item.payload.id)).toEqual([
        "myoxus:unrelated",
      ]);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      expect(MyoxusCommandRegistry.getAll()).toEqual([]);
    }
  });
});

describe("RecentDocsQuickSearchSession", () => {
  test("lists only non-trashed recent documents for the empty query", () => {
    const visible = recentDoc("visible", 20);
    const trashed = recentDoc("trashed", 10, true);
    const recentDocsService = {
      getRecentDocs: vi.fn(() => [visible, trashed]),
    };
    const docDisplayMetaService = {
      getDocDisplayMeta: vi.fn((doc: { id: string }) => ({
        title: `Title ${doc.id}`,
        icon: undefined,
      })),
    };
    const framework = new Framework();
    framework
      .service(RecentWorkspaceItemsService, recentDocsService as any)
      .service(DocDisplayMetaService, docDisplayMetaService as any)
      .entity(RecentDocsQuickSearchSession, [
        RecentWorkspaceItemsService,
        DocDisplayMetaService,
      ]);
    const session = framework
      .provider()
      .createEntity(RecentDocsQuickSearchSession);

    expect(session.items$.value).toEqual([
      expect.objectContaining({
        id: "recent-doc:visible",
        source: "recent-doc",
        label: { title: "Title visible" },
        timestamp: 20,
        payload: { docId: "visible" },
      }),
    ]);
    expect(docDisplayMetaService.getDocDisplayMeta).toHaveBeenCalledOnce();

    session.query("vis");
    expect(session.items$.value).toEqual([]);
  });

  test("reacts when a recent document moves to trash", () => {
    const doc = recentDoc("doc", 30);
    const framework = new Framework();
    framework
      .service(RecentWorkspaceItemsService, {
        getRecentDocs: () => [doc],
      } as any)
      .service(DocDisplayMetaService, {
        getDocDisplayMeta: () => ({
          title: "Document",
          icon: undefined,
        }),
      } as any)
      .entity(RecentDocsQuickSearchSession, [
        RecentWorkspaceItemsService,
        DocDisplayMetaService,
      ]);
    const session = framework
      .provider()
      .createEntity(RecentDocsQuickSearchSession);

    expect(session.items$.value).toHaveLength(1);

    doc.trash$.next(true);
    expect(session.items$.value).toEqual([]);
  });
});

describe("RecentWorkspaceItemsService", () => {
  test("migrates the legacy document list only after the typed write succeeds", () => {
    const localState = new MemoryMemento();
    localState.set("recent-pages", ["a", "a", "b"]);
    const framework = new Framework();

    framework
      .impl(WorkspaceLocalState, localState)
      .service(DocsService, {
        list: {
          docs$: new LiveData([{ id: "a" }, { id: "b" }]),
        },
      } as any)
      .service(RecentWorkspaceItemsService, [WorkspaceLocalState, DocsService]);
    const service = framework.provider().get(RecentWorkspaceItemsService);

    expect(service.getRecentItems()).toEqual([
      { id: "a", type: "doc" },
      { id: "b", type: "doc" },
    ]);
    expect(localState.get("recent-workspace-items")).toEqual([
      { id: "a", type: "doc" },
      { id: "b", type: "doc" },
    ]);
    expect(localState.get("recent-pages")).toBeUndefined();
  });

  test("does not erase malformed or unsuccessfully migrated legacy state", () => {
    const malformed = new MemoryMemento();
    malformed.set("recent-pages", ["valid", 7]);
    const docsService = { list: { docs$: new LiveData([]) } } as any;
    const malformedFramework = new Framework();
    malformedFramework
      .impl(WorkspaceLocalState, malformed)
      .service(DocsService, docsService)
      .service(RecentWorkspaceItemsService, [WorkspaceLocalState, DocsService]);
    const malformedService = malformedFramework
      .provider()
      .get(RecentWorkspaceItemsService);

    expect(malformedService.getRecentItems()).toEqual([]);
    expect(malformed.get("recent-pages")).toEqual(["valid", 7]);
    expect(malformed.get("recent-workspace-items")).toBeUndefined();

    const legacy = new MemoryMemento();
    legacy.set("recent-pages", ["doc"]);
    const failingState = {
      ...legacy,
      get: legacy.get.bind(legacy),
      del: legacy.del.bind(legacy),
      set: vi.fn((key: string, value: unknown) => {
        if (key === "recent-workspace-items") {
          throw new Error("write failed");
        }
        legacy.set(key, value);
      }),
    } as any;
    const failingFramework = new Framework();
    failingFramework
      .impl(WorkspaceLocalState, failingState)
      .service(DocsService, docsService)
      .service(RecentWorkspaceItemsService, [WorkspaceLocalState, DocsService]);
    const failingService = failingFramework
      .provider()
      .get(RecentWorkspaceItemsService);

    expect(() => failingService.getRecentItems()).toThrow("write failed");
    expect(legacy.get("recent-pages")).toEqual(["doc"]);
  });

  test("keeps twelve unique typed targets and resolves current documents", () => {
    const localState = new MemoryMemento();
    const docs = Array.from({ length: 13 }, (_, index) => ({
      id: `doc-${index}`,
    }));
    const framework = new Framework();
    framework
      .impl(WorkspaceLocalState, localState)
      .service(DocsService, {
        list: { docs$: new LiveData(docs) },
      } as any)
      .service(RecentWorkspaceItemsService, [WorkspaceLocalState, DocsService]);
    const service = framework.provider().get(RecentWorkspaceItemsService);

    docs.forEach((doc) => service.addRecentDoc(doc.id));
    service.addRecentDatabase("database");
    service.addRecentDatabase("database");

    expect(service.getRecentItems()).toHaveLength(12);
    expect(service.getRecentItems()[0]).toEqual({
      id: "database",
      type: "database",
    });
    expect(service.getRecentDatabaseIds()).toEqual(["database"]);
    expect(service.getRecentDocs().map((doc) => doc.id)).toEqual(
      docs
        .slice(2)
        .reverse()
        .map((doc) => doc.id),
    );
  });
});

describe("DocsQuickSearchSession", () => {
  const createDocsSession = (
    search$: ReturnType<typeof vi.fn>,
    options: { hasLocalDoc?: boolean } = {},
  ) => {
    const framework = new Framework();
    framework
      .service(WorkspaceService, {
        workspace: { flavour: "myoxus-cloud", id: "workspace-1" },
      } as any)
      .service(DocsSearchService, {
        indexerState$: new LiveData({ completed: true }),
        search$,
      } as any)
      .service(DocsService, {
        list: {
          doc$: vi.fn(
            () =>
              new LiveData(
                options.hasLocalDoc === false
                  ? undefined
                  : {
                      id: "doc-1",
                      title$: new LiveData("Display title"),
                    },
              ),
          ),
        },
      } as any)
      .service(DocDisplayMetaService, {
        getDocDisplayMeta: vi.fn(() => ({
          title: "Display title",
          icon: undefined,
          updatedDate: 42,
        })),
      } as any)
      .entity(DocsQuickSearchSession, [
        WorkspaceService,
        DocsSearchService,
        DocsService,
        DocDisplayMetaService,
      ]);
    return framework.provider().createEntity(DocsQuickSearchSession);
  };

  test("routes cloud queries to remote full-text search and maps document payloads", async () => {
    vi.useFakeTimers();
    try {
      const search$ = vi.fn(() =>
        of([
          {
            docId: "doc-1",
            title: "ignored by display meta",
            score: 8,
            blockId: "block-1",
            blockContent: "body hit 123456",
          },
        ]),
      );
      const session = createDocsSession(search$);

      session.query('"test123456"');
      await vi.advanceTimersByTimeAsync(600);

      expect(search$).toHaveBeenCalledExactlyOnceWith('"test123456"', "remote");
      expect(session.items$.value).toEqual([
        expect.objectContaining({
          id: "doc:doc-1",
          source: "docs",
          label: {
            title: "Display title",
            subTitle: "body hit 123456",
          },
          timestamp: 42,
          payload: expect.objectContaining({
            docId: "doc-1",
            blockId: "block-1",
            blockContent: "body hit 123456",
          }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("aborts an obsolete query without cancelling its replacement", async () => {
    vi.useFakeTimers();
    try {
      const pending: Array<{
        query: string;
        signal: AbortSignal;
        resolve: () => void;
      }> = [];
      const search$ = vi.fn(
        (query: string) =>
          new Observable<
            {
              docId: string;
              title: string;
              score: number;
              blockContent: string;
            }[]
          >((subscriber) => {
            const controller = new AbortController();
            pending.push({
              query,
              signal: controller.signal,
              resolve: () => {
                subscriber.next([
                  {
                    docId: "doc-1",
                    title: "Replacement",
                    score: 1,
                    blockContent: "latest result",
                  },
                ]);
                subscriber.complete();
              },
            });
            return () => controller.abort();
          }),
      );
      const session = createDocsSession(search$);

      session.query("obsolete");
      await vi.advanceTimersByTimeAsync(600);
      expect(pending).toHaveLength(1);
      expect(pending[0].signal.aborted).toBe(false);

      session.query("replacement");
      await vi.advanceTimersByTimeAsync(600);
      expect(pending).toHaveLength(2);
      expect(pending[0].signal.aborted).toBe(true);
      expect(pending[1].signal.aborted).toBe(false);
      expect(session.error$.value).toBeNull();

      pending[1].resolve();
      expect(session.items$.value).toEqual([
        expect.objectContaining({
          id: "doc:doc-1",
          label: {
            title: "Display title",
            subTitle: "latest result",
          },
        }),
      ]);
      expect(session.isLoading$.value).toBe(false);
      expect(session.error$.value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not fall back to a local browser index for empty cloud results", async () => {
    vi.useFakeTimers();
    try {
      const search$ = vi.fn((_query: string, prefer: string) =>
        of(
          prefer === "local"
            ? [
                {
                  docId: "doc-1",
                  title: "Local-only hit",
                  score: 8,
                },
              ]
            : [],
        ),
      );
      const session = createDocsSession(search$);

      session.query("server-only");
      await vi.advanceTimersByTimeAsync(600);

      expect(search$).toHaveBeenCalledExactlyOnceWith("server-only", "remote");
      expect(session.items$.value).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not fall back to a local browser index when cloud search fails", async () => {
    vi.useFakeTimers();
    try {
      const search$ = vi.fn(() =>
        throwError(() => new Error("server search unavailable")),
      );
      const session = createDocsSession(search$);

      session.query("server-only");
      await vi.advanceTimersByTimeAsync(600);

      expect(search$).toHaveBeenCalledExactlyOnceWith("server-only", "remote");
      expect(session.items$.value).toEqual([]);
      expect(session.error$.value).toBe("server search unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps server full-text hits that are not materialized in the local docs list", async () => {
    vi.useFakeTimers();
    try {
      const search$ = vi.fn(() =>
        of([
          {
            docId: "doc-1",
            title: "Server title",
            score: 1,
            blockContent: "Body-only search hit",
          },
        ]),
      );
      const session = createDocsSession(search$, { hasLocalDoc: false });

      session.query("body-only");
      await vi.advanceTimersByTimeAsync(600);

      expect(session.items$.value).toEqual([
        expect.objectContaining({
          id: "doc:doc-1",
          label: {
            title: "Server title",
            subTitle: "Body-only search hit",
          },
          payload: expect.objectContaining({ docId: "doc-1" }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps body-only server hits scannable with the localized untitled fallback", async () => {
    vi.useFakeTimers();
    try {
      const session = createDocsSession(
        vi.fn(() =>
          of([
            {
              docId: "body-only",
              title: "",
              score: 1,
              blockContent: "Database architecture",
            },
          ]),
        ),
        { hasLocalDoc: false },
      );

      session.query("Database");
      await vi.advanceTimersByTimeAsync(600);

      expect(session.items$.value).toEqual([
        expect.objectContaining({
          label: {
            title: { i18nKey: "Untitled" },
            subTitle: "Database architecture",
          },
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ExternalLinksQuickSearchSession", () => {
  test("offers external link insertion for URL-like text", () => {
    const framework = new Framework();
    framework
      .service(WorkspaceService, {
        workspace: { id: "workspace-1" },
      } as any)
      .entity(ExternalLinksQuickSearchSession, [WorkspaceService]);
    const session = framework
      .provider()
      .createEntity(ExternalLinksQuickSearchSession);

    expect(session.items$.value).toEqual([]);

    session.query("example.org");

    expect(session.items$.value).toEqual([
      expect.objectContaining({
        id: "external-link:example.org",
        source: "external-link",
        payload: { url: "example.org" },
      }),
    ]);
  });
});

describe("CMDKQuickSearchService", () => {
  test("opens document search hits with block anchors for editor highlight consumers", () => {
    let options: QuickSearchOptions | undefined;
    let submitResult: ((result: QuickSearchItem | null) => void) | undefined;
    const show$ = new LiveData(false);
    const show = vi.fn(
      (_sessions, callback, nextOptions: QuickSearchOptions) => {
        options = nextOptions;
        submitResult = callback;
        show$.next(true);
      },
    );
    const openDoc = vi.fn();
    const open = vi.fn();
    const hide = vi.fn();
    const workspace = { flavour: "cloud" };
    const framework = new Framework();
    for (const session of [
      RecentTargetsQuickSearchSession,
      FavoritesQuickSearchSession,
      CollectionsQuickSearchSession,
      CommandsQuickSearchSession,
      CreationQuickSearchSession,
      DocsQuickSearchSession,
      DatabasesQuickSearchSession,
      DatabaseRowsQuickSearchSession,
      TagsQuickSearchSession,
    ]) {
      framework.entity(session as any, () => createSession([]) as any);
    }
    framework
      .service(QuickSearchService, {
        quickSearch: {
          hide,
          show,
          show$,
        },
      } as any)
      .service(WorkbenchService, {
        workbench: {
          openCollection: vi.fn(),
          openDoc,
          open,
          openTag: vi.fn(),
        },
      } as any)
      .service(DocsService, { createDoc: vi.fn() } as any)
      .service(WorkspaceService, { workspace } as any)
      .service(CMDKQuickSearchService, [
        QuickSearchService,
        WorkbenchService,
        DocsService,
        WorkspaceService,
      ]);
    const service = framework.provider().get(CMDKQuickSearchService);

    service.toggle();
    submitResult?.({
      id: "doc:doc-1",
      source: "docs",
      label: "Document",
      payload: { docId: "doc-1", blockId: "block-1" },
    });

    expect(openDoc).toHaveBeenCalledExactlyOnceWith({
      docId: "doc-1",
      blockIds: ["block-1"],
    });
    options?.onOpenPage?.("needle + spaces");
    expect(hide).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "/search/results?q=needle+%2B+spaces",
      { at: "active" },
    );
    expect(hide.mock.invocationCallOrder[0]).toBeLessThan(
      open.mock.invocationCallOrder[0],
    );
    show$.next(false);
    workspace.flavour = "local";
    service.toggle();
    expect(options?.onOpenPage).toBeUndefined();
  });

  test("contains rejected async commands and reports the failure", async () => {
    let submitResult: ((result: QuickSearchItem | null) => void) | undefined;
    const show$ = new LiveData(false);
    const show = vi.fn((_sessions, callback) => {
      submitResult = callback;
      show$.next(true);
    });
    const framework = new Framework();
    for (const session of [
      RecentTargetsQuickSearchSession,
      FavoritesQuickSearchSession,
      CollectionsQuickSearchSession,
      CommandsQuickSearchSession,
      CreationQuickSearchSession,
      DocsQuickSearchSession,
      DatabasesQuickSearchSession,
      DatabaseRowsQuickSearchSession,
      TagsQuickSearchSession,
    ]) {
      framework.entity(session as any, () => createSession([]) as any);
    }
    framework
      .service(QuickSearchService, {
        quickSearch: {
          hide: vi.fn(),
          show,
          show$,
        },
      } as any)
      .service(WorkbenchService, { workbench: {} } as any)
      .service(DocsService, { createDoc: vi.fn() } as any)
      .service(WorkspaceService, { workspace: { flavour: "cloud" } } as any)
      .service(CMDKQuickSearchService, [
        QuickSearchService,
        WorkbenchService,
        DocsService,
        WorkspaceService,
      ]);
    const notifyError = vi
      .spyOn(notify, "error")
      .mockImplementation(() => undefined as never);
    const commandError = new Error("Command failed");

    try {
      framework.provider().get(CMDKQuickSearchService).toggle();
      submitResult?.({
        id: "command:failure",
        source: "commands",
        label: "Failure",
        payload: {
          run: vi.fn(async () => {
            throw commandError;
          }),
        },
      });

      await vi.waitFor(() =>
        expect(notifyError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: commandError.message,
          }),
        ),
      );
    } finally {
      notifyError.mockRestore();
    }
  });
});
