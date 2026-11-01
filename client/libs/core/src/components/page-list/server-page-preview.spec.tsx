/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocsService } from "@myoxus/core/modules/doc";
import { DocSummaryService } from "@myoxus/core/modules/doc-summary";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { Framework, FrameworkRoot, LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BehaviorSubject, Subject } from "rxjs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { DocSummaryStore } from "../../modules/doc-summary/stores/doc-summary";
import { PagePreview } from "./page-content-preview";
import { requestPagePreview } from "./server-page-preview-request";

const observed = new Set<Element>();
let intersection: IntersectionObserverCallback;
beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersection = callback;
      }
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
});
afterAll(() => vi.unstubAllGlobals());

function visibility(visible: boolean) {
  act(() =>
    intersection(
      [...observed].map(
        (target) =>
          ({ target, isIntersecting: visible }) as IntersectionObserverEntry,
      ),
      {} as IntersectionObserver,
    ),
  );
}

const disposals: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});

function setup() {
  const requests: Array<{
    url: string;
    signal: AbortSignal;
    resolve: (response: Response) => void;
  }> = [];
  const read$ = new LiveData<boolean | undefined>(true);
  const account$ = new LiveData({ id: "alice" });
  const updates = new Subject<{ docId: string }>();
  const sync = new BehaviorSubject({ syncing: false, synced: true });
  const blobs = new BehaviorSubject({ uploading: 0 });
  const workspace = {
    id: "workspace-a",
    flavour: "cloud",
    engine: {
      doc: {
        storage: {
          subscribeDocUpdate: (
            callback: (update: { docId: string }) => void,
          ) => {
            const sub = updates.subscribe(callback);
            return () => sub.unsubscribe();
          },
        },
        docState$: () => sync,
      },
      blob: { state$: blobs },
    },
  };
  const server = {
    id: "server-a",
    account$,
    config$: new LiveData({
      preview: {
        maxConcurrentRequests: 1,
        requestTimeoutMs: 5000,
        retryCount: 0,
      },
    }),
    fetch: vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({ url, signal: init.signal!, resolve }),
        ),
    ),
  };
  const record = { trash$: new LiveData(false), updatedAt$: new LiveData(1) };
  const open = vi.fn(() => {
    throw new Error("Cloud previews must not open editor stores");
  });
  const index = vi.fn(() => {
    throw new Error("Cloud previews must not initialize the local indexer");
  });
  const framework = new Framework();
  framework.service(WorkspaceService, {
    workspace,
  } as unknown as WorkspaceService);
  framework.service(WorkspaceServerService, {
    server$: new LiveData(server),
  } as unknown as WorkspaceServerService);
  framework.service(DocsService, {
    list: { doc$: () => new LiveData(record) },
    open,
  } as unknown as DocsService);
  framework.service(GuardService, {
    can$: () => read$,
  } as unknown as GuardService);
  const cache = new BehaviorSubject<string | undefined>("Server summary");
  framework.store(
    DocSummaryStore,
    () =>
      new DocSummaryStore(
        { workspace } as never,
        {
          server: {
            gql: async () => ({
              workspace: { doc: { summary: "Server summary" } },
            }),
          },
        } as never,
        {
          watch: () => cache,
          set: async (_key: string, value: string) => cache.next(value),
        } as never,
      ),
  );
  framework.service(DocSummaryService, (provider) => {
    const store = provider.get(DocSummaryStore);
    vi.spyOn(store, "watchDocSummaryFromIndexer").mockImplementation(index);
    return new DocSummaryService(
      { workspace } as never,
      store,
      {
        flags: { enable_battery_save_mode: { value: false } },
      } as never,
      { server: null } as never,
    );
  });
  const provider = framework.provider();
  const summaries = provider.get(DocSummaryService);
  disposals.push(() => {
    requests.forEach((request) =>
      request.resolve(new Response(null, { status: 204 })),
    );
    provider.dispose();
  });
  let urlCount = 0;
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => `blob:preview-${++urlCount}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const navigate = vi.fn();
  const content = (pageId: string, inventoryPreview?: "grid" | "masonry") => (
    <MyoxusUIProvider>
      <FrameworkRoot framework={provider}>
        <div onClick={navigate}>
          <PagePreview
            pageId={pageId}
            variant="image"
            inventoryPreview={inventoryPreview}
          />
        </div>
      </FrameworkRoot>
    </MyoxusUIProvider>
  );
  const textContent = (pageId: string) => (
    <MyoxusUIProvider>
      <FrameworkRoot framework={provider}>
        <PagePreview
          pageId={pageId}
          visibleListSnippet
          fallback="Snippet pending"
          emptyFallback="Snippet empty"
        />
      </FrameworkRoot>
    </MyoxusUIProvider>
  );
  const view = render(content("a"));
  return {
    ...view,
    requests,
    read$,
    account$,
    record,
    updates,
    sync,
    blobs,
    server,
    open,
    index,
    create,
    revoke,
    navigate,
    summaries,
    changeDoc: (id: string) => view.rerender(content(id)),
    showInventory: (layout: "grid" | "masonry") =>
      view.rerender(content("a", layout)),
    showText: (id: string) => view.rerender(textContent(id)),
  };
}

const svg = () =>
  new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><path d="M0 0L20 20"/></svg>',
    { headers: { "content-type": "image/svg+xml" } },
  );

describe("cloud PagePreview consumption", () => {
  test("inventory crops from metadata by width without requesting another artifact on layout change", async () => {
    const view = setup();
    view.showInventory("masonry");
    visibility(true);
    await waitFor(() => expect(view.requests).toHaveLength(1));
    const response = svg();
    response.headers.set("x-preview-content-height", "96");
    response.headers.set("x-preview-partial", "true");
    act(() => view.requests[0]?.resolve(response));
    const image = await screen.findByRole("img", { name: "Server summary" });
    const aspect = image.closest(".mantine-AspectRatio-root") as HTMLElement;
    expect(aspect?.style.getPropertyValue("--ar-ratio")).toBe(
      (640 / 96).toString(),
    );
    expect(screen.getByText("com.myoxus.common.preview-partial")).toBeDefined();

    view.showInventory("grid");
    expect(aspect?.style.getPropertyValue("--ar-ratio")).toBe("1.6");
    expect(view.requests).toHaveLength(1);
  });

  test("acquires a list snippet only while its row is visible", async () => {
    const view = setup();
    const snippet = new BehaviorSubject<string | undefined>(undefined);
    const acquire = vi
      .spyOn(view.summaries, "watchVisibleListSnippet")
      .mockReturnValue(snippet);
    view.showText("a");

    expect(screen.getByText("Snippet pending")).toBeDefined();
    expect(acquire).not.toHaveBeenCalled();
    visibility(false);
    expect(acquire).not.toHaveBeenCalled();

    visibility(true);
    await waitFor(() => expect(acquire).toHaveBeenCalledExactlyOnceWith("a"));
    expect(screen.getByText("Snippet pending")).toBeDefined();
    act(() => snippet.next("Loaded snippet"));
    expect(screen.getByText("Loaded snippet")).toBeDefined();
    act(() => snippet.next(""));
    expect(screen.getByText("Snippet empty")).toBeDefined();
  });

  test("requests browser revalidation and never consumes a raw 304 body", async () => {
    const server = { fetch: vi.fn().mockResolvedValue(svg()) };
    const policy = {
      maxConcurrentRequests: 1,
      requestTimeoutMs: 5000,
      retryCount: 0,
    };
    const request = () =>
      requestPagePreview(
        server as never,
        "workspace-a",
        "a",
        policy,
        new AbortController().signal,
        "dark",
      );
    expect(await request()).toMatchObject({
      state: "ready",
      contentHeight: 400,
      partial: null,
      truncated: null,
    });
    const withMetadata = svg();
    withMetadata.headers.set("x-preview-height", "400");
    withMetadata.headers.set("x-preview-content-height", "96");
    withMetadata.headers.set("x-preview-partial", "true");
    withMetadata.headers.set("x-preview-truncated", "false");
    withMetadata.headers.set("x-doc-revision", "9");
    server.fetch.mockResolvedValue(withMetadata);
    expect(await request()).toMatchObject({
      state: "ready",
      contentHeight: 96,
      partial: true,
      truncated: false,
      revision: "9",
    });
    const invalidMetadata = svg();
    invalidMetadata.headers.set("x-preview-content-height", "Infinity");
    invalidMetadata.headers.set("x-preview-partial", "perhaps");
    server.fetch.mockResolvedValue(invalidMetadata);
    expect(await request()).toMatchObject({
      state: "ready",
      contentHeight: 400,
      partial: null,
    });
    expect(server.fetch).toHaveBeenLastCalledWith(
      "/api/workspaces/workspace-a/docs/a/preview?colorScheme=dark",
      expect.objectContaining({ cache: "no-cache", credentials: "include" }),
    );
    const raw = new Response(null, { status: 304 });
    const blob = vi.spyOn(raw, "blob");
    server.fetch.mockResolvedValue(raw);
    expect(await request()).toEqual({ state: "failed" });
    expect(blob).not.toHaveBeenCalled();
  });

  test("cancels hidden in-flight work and releases late results before resuming demand", async () => {
    const view = setup();
    visibility(true);
    await waitFor(() => expect(view.requests).toHaveLength(1));
    visibility(false);
    expect(view.requests[0].signal.aborted).toBe(true);
    await act(async () => view.requests[0].resolve(svg()));
    expect(view.create).not.toHaveBeenCalled();
    visibility(true);
    await waitFor(() => expect(view.requests).toHaveLength(2));
    await act(async () => view.requests[1].resolve(svg()));
    await screen.findByRole("img");
  });

  test.each(["update", "upload", "sync", "trash", "account"])(
    "invalidates a hidden ready image immediately on %s",
    async (cause) => {
      const view = setup();
      visibility(true);
      await waitFor(() => expect(view.requests).toHaveLength(1));
      await act(async () => view.requests[0].resolve(svg()));
      await screen.findByRole("img");
      visibility(false);
      act(() => {
        if (cause === "update") view.updates.next({ docId: "a" });
        if (cause === "upload") {
          view.blobs.next({ uploading: 1 });
          view.blobs.next({ uploading: 0 });
        }
        if (cause === "sync") {
          view.sync.next({ syncing: true, synced: false });
          view.sync.next({ syncing: false, synced: true });
        }
        if (cause === "trash") view.record.trash$.next(true);
        if (cause === "account") view.account$.next({ id: "bob" });
      });
      expect(screen.queryByRole("img")).toBeNull();
      expect(view.revoke).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
      expect(view.requests).toHaveLength(1);
      visibility(true);
      if (cause === "trash") {
        expect(view.requests).toHaveLength(1);
      } else {
        await waitFor(() => expect(view.requests).toHaveLength(2));
        await act(async () => view.requests[1].resolve(svg()));
        expect((await screen.findByRole("img")).getAttribute("src")).toBe(
          "blob:preview-2",
        );
      }
    },
  );

  test("gives queued cards a request budget after admission, not while waiting", async () => {
    vi.useFakeTimers();
    const server = {
      fetch: vi.fn(
        (url: string, { signal }: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(signal!.reason);
            };
            const timer = setTimeout(
              () => {
                signal!.removeEventListener("abort", abort);
                resolve(svg());
              },
              url.includes("/slow/") ? 150 : 75,
            );
            signal!.addEventListener("abort", abort, { once: true });
          }),
      ),
    };
    const policy = {
      maxConcurrentRequests: 1,
      requestTimeoutMs: 100,
      retryCount: 0,
    };
    const controller = new AbortController();
    const requests = ["a", "b", "slow"].map((id) =>
      requestPagePreview(
        server as never,
        "workspace-a",
        id,
        policy,
        controller.signal,
        "light",
      ),
    );
    const results = Promise.allSettled(requests);
    try {
      await vi.advanceTimersByTimeAsync(75);
      expect(server.fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(175);
      expect(await results).toMatchObject([
        { status: "fulfilled", value: { state: "ready" } },
        { status: "fulfilled", value: { state: "ready" } },
        { status: "rejected", reason: new Error("Preview timed out") },
      ]);
    } finally {
      controller.abort();
      await results;
      vi.useRealTimers();
    }
  });

  test("bounds visible requests, rejects late identity results and clears revoked access without hydration", async () => {
    const view = setup();
    expect(view.requests).toHaveLength(0);
    visibility(true);
    await waitFor(() => expect(view.requests).toHaveLength(1));
    view.changeDoc("b");
    expect(view.requests[0].signal.aborted).toBe(true);
    expect(view.requests).toHaveLength(1);
    await act(async () => view.requests[0].resolve(svg()));
    await waitFor(() => expect(view.requests).toHaveLength(2));
    expect(view.requests[1].url).toContain("/docs/b/preview");
    expect(view.create).not.toHaveBeenCalled();
    await act(async () => view.requests[1].resolve(svg()));
    const image = await screen.findByRole("img", { name: "Server summary" });
    expect(image.getAttribute("src")).toBe("blob:preview-1");
    act(() => view.account$.next({ id: "bob" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(view.revoke).toHaveBeenCalledWith("blob:preview-1");
    await waitFor(() => expect(view.requests).toHaveLength(3));
    await act(async () => view.requests[2].resolve(svg()));
    expect((await screen.findByRole("img")).getAttribute("src")).toBe(
      "blob:preview-2",
    );
    act(() => view.read$.next(false));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("Server summary")).toBeNull();
    expect(view.revoke).toHaveBeenCalledWith("blob:preview-2");
    expect(view.open).not.toHaveBeenCalled();
    expect(view.index).not.toHaveBeenCalled();
  });

  test("retries a failed image without opening the card and retains mounted images across visibility changes and releases on unmount", async () => {
    const view = setup();
    visibility(true);
    await waitFor(() => expect(view.requests).toHaveLength(1));
    await act(async () =>
      view.requests[0].resolve(new Response(null, { status: 500 })),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(view.navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(view.requests).toHaveLength(2));
    await act(async () => view.requests[1].resolve(svg()));
    await screen.findByRole("img");
    visibility(false);
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:preview-1");
    expect(view.revoke).not.toHaveBeenCalled();
    visibility(true);
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:preview-1");
    expect(view.requests).toHaveLength(2);
    expect(view.create).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(view.revoke).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  });
});
