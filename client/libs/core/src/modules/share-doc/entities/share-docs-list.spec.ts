import { PublicDocMode } from "@myoxus/graphql";
import { Framework, MemoryMemento, Service, Store } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { GlobalCache } from "../../storage";
import { ShareDocsList } from "./share-docs-list";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function createShareDocsListFixture() {
  const publicDocs = [{ id: "doc-public", mode: PublicDocMode.Page }] as any;
  const refreshedPublicDocs = [
    { id: "doc-public", mode: PublicDocMode.Edgeless },
  ] as any;
  const cache = new MemoryMemento();

  class TestWorkspaceService extends Service {
    workspace = { id: "workspace-share-docs-list" };
  }

  class TestShareDocsStore extends Store {
    disableSharePage = vi.fn().mockResolvedValue(undefined);
    enableSharePage = vi.fn().mockResolvedValue(undefined);
    getWorkspacesShareDocs = vi.fn().mockResolvedValue(refreshedPublicDocs);
  }

  cache.set("share-docs", publicDocs);
  const framework = new Framework();
  framework
    .service(TestWorkspaceService)
    .store(TestShareDocsStore)
    .impl(GlobalCache, cache)
    .entity(ShareDocsList as any, [
      TestWorkspaceService,
      TestShareDocsStore,
      GlobalCache,
    ]);

  const provider = framework.provider();
  const store = provider.get(TestShareDocsStore);

  return {
    cache,
    list: provider.createEntity(ShareDocsList),
    publicDocs,
    refreshedPublicDocs,
    store,
  };
}

describe("ShareDocsList", () => {
  test("derives public status from the cached workspace public-doc projection", () => {
    const { list } = createShareDocsListFixture();

    expect(list.publicMode$("doc-public").value).toBe(PublicDocMode.Page);
    expect(list.publicMode$("doc-private").value).toBeNull();
  });

  test("publishes a row document and refreshes the workspace projection", async () => {
    const { cache, list, refreshedPublicDocs, store } =
      createShareDocsListFixture();

    await list.enableShare("doc-public", PublicDocMode.Edgeless);

    expect(store.enableSharePage).toHaveBeenCalledWith(
      "workspace-share-docs-list",
      "doc-public",
      PublicDocMode.Edgeless,
      undefined,
    );
    expect(store.getWorkspacesShareDocs).toHaveBeenCalled();
    expect(cache.get("share-docs")).toEqual(refreshedPublicDocs);
  });

  test("revokes a row document and refreshes the workspace projection", async () => {
    const { list, store } = createShareDocsListFixture();

    await list.disableShare("doc-public");

    expect(store.disableSharePage).toHaveBeenCalledWith(
      "workspace-share-docs-list",
      "doc-public",
      undefined,
    );
    expect(store.getWorkspacesShareDocs).toHaveBeenCalled();
  });

  test("pre-mutation refresh cannot overwrite the confirmed post-mutation list", async () => {
    const { cache, list, refreshedPublicDocs, store } =
      createShareDocsListFixture();
    const stale = deferred<any>();
    const current = deferred<any>();
    store.getWorkspacesShareDocs
      .mockReset()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);

    list.revalidate();
    await vi.waitFor(() =>
      expect(store.getWorkspacesShareDocs).toHaveBeenCalledTimes(1),
    );
    const publication = list.enableShare("doc-public", PublicDocMode.Edgeless);
    await vi.waitFor(() =>
      expect(store.getWorkspacesShareDocs).toHaveBeenCalledTimes(2),
    );

    current.resolve(refreshedPublicDocs);
    await publication;
    stale.resolve([{ id: "doc-stale", mode: PublicDocMode.Page }]);
    await stale.promise;
    await Promise.resolve();

    expect(cache.get("share-docs")).toEqual(refreshedPublicDocs);
    expect(list.isLoading$.value).toBe(false);
    expect(list.error$.value).toBeNull();
  });

  test("propagates the current refresh error without discarding cached entries", async () => {
    const { cache, list, publicDocs, store } = createShareDocsListFixture();
    const refreshError = new Error("public list unavailable");
    store.getWorkspacesShareDocs.mockRejectedValueOnce(refreshError);

    await expect(list.disableShare("doc-public")).rejects.toBe(refreshError);

    expect(cache.get("share-docs")).toEqual(publicDocs);
    expect(list.error$.value).toBe(refreshError);
    expect(list.isLoading$.value).toBe(false);
  });

  test("disposal aborts the owned refresh and blocks its late cache write", async () => {
    const { cache, list, publicDocs, store } = createShareDocsListFixture();
    const pending = deferred<any>();
    let requestSignal: AbortSignal | undefined;
    store.getWorkspacesShareDocs.mockImplementationOnce(
      (_workspaceId: string, signal?: AbortSignal) => {
        requestSignal = signal;
        return pending.promise;
      },
    );

    list.revalidate();
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    list.dispose();
    expect(requestSignal?.aborted).toBe(true);

    pending.resolve([{ id: "doc-late", mode: PublicDocMode.Edgeless }]);
    await pending.promise;
    await Promise.resolve();
    expect(cache.get("share-docs")).toEqual(publicDocs);
  });
});
