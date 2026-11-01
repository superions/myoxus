import { Framework } from "@myoxus/infra";
import { BehaviorSubject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import { DocSummaryStore } from "../stores/doc-summary";
import { DocSummaryService } from "./doc-summary";

function createService(cloudResult: string | undefined, batterySave = true) {
  const cache$ = new BehaviorSubject<string | undefined>("stale summary");
  const docState$ = new BehaviorSubject({ synced: true, syncing: false });
  const addIndexerPriority = vi.fn(() => vi.fn());
  const addDocPriority = vi.fn(() => vi.fn());
  let deleteListener: ((docId: string) => void) | undefined;
  const workspace = {
    id: "summary-workspace",
    flavour: "cloud",
    engine: {
      indexer: { addPriority: addIndexerPriority },
      doc: {
        addPriority: addDocPriority,
        docState$: () => docState$,
        storage: {
          subscribeDocUpdate: () => vi.fn(),
          subscribeDocDelete: (callback: (docId: string) => void) => {
            deleteListener = callback;
            return () => {
              deleteListener = undefined;
            };
          },
        },
      },
    },
  };
  const framework = new Framework();
  framework.store(
    DocSummaryStore,
    () =>
      new DocSummaryStore(
        { workspace } as never,
        {
          server: {
            gql: async () => ({
              workspace: {
                doc:
                  cloudResult === undefined
                    ? null
                    : { summary: cloudResult || null },
              },
            }),
          },
        } as never,
        {
          watch: () => cache$,
          set: async (_key: string, summary: string) => cache$.next(summary),
        } as never,
      ),
  );
  framework.service(
    DocSummaryService,
    (provider) =>
      new DocSummaryService(
        { workspace } as never,
        provider.get(DocSummaryStore),
        {
          flags: { enable_battery_save_mode: { value: batterySave } },
        } as never,
        { server: null } as never,
      ),
  );
  const provider = framework.provider();
  const store = provider.get(DocSummaryStore);
  vi.spyOn(store, "getDocSummaryFromCloud");
  vi.spyOn(store, "setDocSummaryCache");
  return {
    addDocPriority,
    addIndexerPriority,
    emitDelete: (docId: string) => deleteListener?.(docId),
    provider,
    service: provider.get(DocSummaryService),
    store,
  };
}

describe("DocSummaryService cloud revalidation", () => {
  test("a successful empty summary replaces stale cached text", async () => {
    const { provider, service, store } = createService("");
    const observed: Array<string | undefined> = [];
    const subscription = service
      .watchDocSummary("doc-empty")
      .subscribe((value) => observed.push(value));

    await vi.waitFor(() => {
      expect(store.setDocSummaryCache).toHaveBeenCalledWith("doc-empty", "");
      expect(observed.at(-1)).toBe("");
    });
    subscription.unsubscribe();
    provider.dispose();
  });

  test("an unavailable cloud result leaves the existing cache untouched", async () => {
    const { provider, service, store } = createService(undefined);
    const subscription = service.watchDocSummary("doc-unavailable").subscribe();

    await vi.waitFor(() =>
      expect(store.getDocSummaryFromCloud).toHaveBeenCalledWith(
        "doc-unavailable",
      ),
    );
    expect(store.setDocSummaryCache).not.toHaveBeenCalled();
    subscription.unsubscribe();
    provider.dispose();
  });
});

describe.each([true])(
  "DocSummaryService visible list batching (battery save %s)",
  (batterySave) => {
    test("batches visible demand without prioritizing document sync or indexing", async () => {
      const { addDocPriority, addIndexerPriority, provider, service, store } =
        createService(undefined, batterySave);
      vi.spyOn(store, "getDocumentSnippets").mockResolvedValue([
        {
          docId: "doc-a",
          snippet: "Alpha",
          indexedAt: "2026-09-24T10:00:00Z",
        },
        {
          docId: "doc-b",
          snippet: "Beta",
          indexedAt: "2026-09-24T10:00:01Z",
        },
      ]);

      const a: Array<string | undefined> = [];
      const b: Array<string | undefined> = [];
      const subscriptionA = service
        .watchVisibleListSnippet("doc-a")
        .subscribe((value) => a.push(value));
      const subscriptionB = service
        .watchVisibleListSnippet("doc-b")
        .subscribe((value) => b.push(value));

      await vi.waitFor(() => {
        expect(store.getDocumentSnippets).toHaveBeenCalledTimes(1);
        expect(store.getDocumentSnippets).toHaveBeenCalledWith(
          ["doc-a", "doc-b"],
          expect.any(AbortSignal),
        );
        expect(a.at(-1)).toBe("Alpha");
        expect(b.at(-1)).toBe("Beta");
      });
      expect(addIndexerPriority).not.toHaveBeenCalled();
      expect(addDocPriority).not.toHaveBeenCalled();

      subscriptionA.unsubscribe();
      subscriptionB.unsubscribe();
      provider.dispose();
    });
  },
);

test("a missing search row is retried and replaced after indexing catches up", async () => {
  const { provider, service, store } = createService(undefined);
  vi.spyOn(store, "getDocumentSnippets")
    .mockResolvedValueOnce([
      { docId: "doc-delayed", snippet: undefined, indexedAt: undefined },
    ])
    .mockResolvedValueOnce([
      {
        docId: "doc-delayed",
        snippet: "Indexed later",
        indexedAt: "2026-09-24T10:05:00Z",
      },
    ]);

  const first = service.watchVisibleListSnippet("doc-delayed").subscribe();
  await vi.waitFor(() =>
    expect(store.getDocumentSnippets).toHaveBeenCalledTimes(1),
  );
  first.unsubscribe();

  const observed: Array<string | undefined> = [];
  const second = service
    .watchVisibleListSnippet("doc-delayed")
    .subscribe((value) => observed.push(value));
  await vi.waitFor(() => expect(observed.at(-1)).toBe("Indexed later"));

  second.unsubscribe();
  provider.dispose();
});

test("a later authorization omission discards the retained snippet", async () => {
  const { provider, service, store } = createService(undefined);
  vi.spyOn(store, "getDocumentSnippets")
    .mockResolvedValueOnce([
      {
        docId: "doc-revoked",
        snippet: "Previously readable",
        indexedAt: "2026-09-24T10:00:00Z",
      },
    ])
    .mockResolvedValueOnce([]);

  const firstValues: Array<string | undefined> = [];
  const first = service
    .watchVisibleListSnippet("doc-revoked")
    .subscribe((value) => firstValues.push(value));
  await vi.waitFor(() =>
    expect(firstValues.at(-1)).toBe("Previously readable"),
  );
  first.unsubscribe();

  const secondValues: Array<string | undefined> = [];
  const second = service
    .watchVisibleListSnippet("doc-revoked")
    .subscribe((value) => secondValues.push(value));
  await vi.waitFor(() => {
    expect(store.getDocumentSnippets).toHaveBeenCalledTimes(2);
    expect(secondValues.at(-1)).toBeUndefined();
  });

  second.unsubscribe();
  provider.dispose();
});

test("a confirmed deletion fences a late batch response", async () => {
  const { emitDelete, provider, service, store } = createService(undefined);
  let resolveRequest!: (
    value: Array<{ docId: string; snippet: string; indexedAt: string }>,
  ) => void;
  vi.spyOn(store, "getDocumentSnippets").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
  );
  const observed: Array<string | undefined> = [];
  const subscription = service
    .watchVisibleListSnippet("doc-deleted")
    .subscribe((value) => observed.push(value));
  await vi.waitFor(() =>
    expect(store.getDocumentSnippets).toHaveBeenCalledTimes(1),
  );

  emitDelete("doc-deleted");
  resolveRequest([
    {
      docId: "doc-deleted",
      snippet: "Obsolete text",
      indexedAt: "2026-09-24T10:00:00Z",
    },
  ]);
  await Promise.resolve();
  expect(observed.at(-1)).toBeUndefined();

  subscription.unsubscribe();
  provider.dispose();
});

test("shared batch work aborts only after its last visible demand is released", async () => {
  const { provider, service, store } = createService(undefined);
  let resolveRequest!: (value: []) => void;
  let requestSignal: AbortSignal | undefined;
  vi.spyOn(store, "getDocumentSnippets").mockImplementation(
    (_ids, signal) =>
      new Promise((resolve) => {
        requestSignal = signal;
        resolveRequest = resolve;
      }),
  );
  const first = service.watchVisibleListSnippet("doc-a").subscribe();
  const second = service.watchVisibleListSnippet("doc-b").subscribe();
  await vi.waitFor(() => expect(requestSignal).toBeDefined());

  first.unsubscribe();
  expect(requestSignal?.aborted).toBe(false);
  second.unsubscribe();
  expect(requestSignal?.aborted).toBe(true);
  resolveRequest([]);

  provider.dispose();
});
