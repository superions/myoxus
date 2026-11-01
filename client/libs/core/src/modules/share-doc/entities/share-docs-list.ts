import { DebugLogger } from "@myoxus/debug";
import type {
  GetWorkspacePublicPagesQuery,
  PublicDocMode,
} from "@myoxus/graphql";
import { Entity, LiveData } from "@myoxus/infra";
import { map } from "rxjs";

import type { GlobalCache } from "../../storage";
import type { WorkspaceService } from "../../workspace";
import type { ShareDocsStore } from "../stores/share-docs";

type ShareDocListType = NonNullable<
  GetWorkspacePublicPagesQuery["workspace"]
>["publicDocs"];

export const logger = new DebugLogger("myoxus:share-doc-list");

function abortReason(signal: AbortSignal) {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class ShareDocsList extends Entity {
  private refreshGeneration = 0;
  private readonly refreshes = new Map<
    number,
    { controller: AbortController; promise: Promise<void> }
  >();
  private disposed = false;

  list$ = LiveData.from(
    this.cache
      .watch<ShareDocListType>("share-docs")
      .pipe(map((list) => list ?? [])),
    [],
  );
  publicMode$(docId: string) {
    // Document lists must not instantiate per-row ShareInfo queries. They all
    // subscribe to this workspace-level server projection and derive the row
    // status locally from the cached public-doc list.
    return this.list$.map(
      (list) => list.find((doc) => doc.id === docId)?.mode ?? null,
    );
  }

  isLoading$ = new LiveData<boolean>(false);
  error$ = new LiveData<any>(null);

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly store: ShareDocsStore,
    private readonly cache: GlobalCache,
  ) {
    super();
  }

  private fetchWorkspacePublicDocs(signal?: AbortSignal) {
    return this.store.getWorkspacesShareDocs(
      this.workspaceService.workspace.id,
      signal,
    );
  }

  private cacheWorkspacePublicDocs(list: ShareDocListType) {
    this.cache.set("share-docs", list);
  }

  private refresh(generation: number) {
    const existing = this.refreshes.get(generation);
    if (existing) return existing.promise;
    if (this.disposed) {
      return Promise.reject(new Error("ShareDocsList has been disposed"));
    }

    const controller = new AbortController();
    if (generation === this.refreshGeneration) {
      this.isLoading$.next(true);
    }
    const promise = Promise.resolve()
      .then(() => this.fetchWorkspacePublicDocs(controller.signal))
      .then((list) => {
        if (this.disposed || generation !== this.refreshGeneration) return;
        this.cacheWorkspacePublicDocs(list);
        this.error$.next(null);
      })
      .catch((error) => {
        if (!this.disposed && generation === this.refreshGeneration) {
          this.error$.next(error);
        }
        throw error;
      })
      .finally(() => {
        if (this.refreshes.get(generation)?.promise === promise) {
          this.refreshes.delete(generation);
        }
        if (!this.disposed && generation === this.refreshGeneration) {
          this.isLoading$.next(false);
        }
      });
    this.refreshes.set(generation, { controller, promise });
    return promise;
  }

  /** Starts or joins the current workspace projection refresh. */
  revalidate = () => {
    void this.refresh(this.refreshGeneration).catch((error) => {
      if (!this.disposed) logger.error("revalidate share docs error", error);
    });
  };

  waitForRevalidation(signal?: AbortSignal) {
    return waitWithSignal(this.refresh(this.refreshGeneration), signal);
  }

  /**
   * Invalidates reads that began before a confirmed publication mutation.
   * The new generation may run concurrently, but only it may update the cache.
   */
  refreshAfterMutation(signal?: AbortSignal) {
    const generation = ++this.refreshGeneration;
    return waitWithSignal(this.refresh(generation), signal);
  }

  async enableShare(docId: string, mode: PublicDocMode, signal?: AbortSignal) {
    await this.store.enableSharePage(
      this.workspaceService.workspace.id,
      docId,
      mode,
      signal,
    );
    await this.refreshAfterMutation(signal);
  }

  async disableShare(docId: string, signal?: AbortSignal) {
    await this.store.disableSharePage(
      this.workspaceService.workspace.id,
      docId,
      signal,
    );
    await this.refreshAfterMutation(signal);
  }

  override dispose(): void {
    this.disposed = true;
    for (const request of this.refreshes.values()) {
      request.controller.abort();
    }
    this.refreshes.clear();
    super.dispose();
  }
}
