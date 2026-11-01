import type { GetWorkspacePageMetaByIdQuery } from "@myoxus/graphql";
import {
  catchErrorInto,
  effect,
  Entity,
  exhaustMapWithTrailing,
  fromPromise,
  LiveData,
  onComplete,
  onStart,
  smartRetry,
} from "@myoxus/infra";
import { tap } from "rxjs";

import type { DocService } from "../../doc";
import type { GlobalCache } from "../../storage";
import type { ServerDocMetaStore } from "../stores/server-doc-meta";

export type ServerDocMetaType = NonNullable<
  GetWorkspacePageMetaByIdQuery["workspace"]
>["pageMeta"];

// Preserve the historical cache namespace so installed clients can reuse and
// invalidate existing non-authoritative entries across the module rename.
const CACHE_KEY_PREFIX = "cloud-doc-meta:";

export class ServerDocMeta extends Entity {
  constructor(
    private readonly store: ServerDocMetaStore,
    private readonly docService: DocService,
    private readonly cache: GlobalCache,
  ) {
    super();
  }

  readonly docId = this.docService.doc.id;
  readonly workspaceId = this.docService.doc.workspace.id;

  readonly cacheKey = `${CACHE_KEY_PREFIX}${this.workspaceId}:${this.docId}`;
  meta$ = LiveData.from<ServerDocMetaType | undefined>(
    this.cache.watch<ServerDocMetaType>(this.cacheKey),
    undefined,
  );
  isRevalidating$ = new LiveData(false);
  error$ = new LiveData<any | null>(null);

  revalidate = effect(
    exhaustMapWithTrailing(() => {
      return fromPromise(
        this.store.fetchServerDocMeta(this.workspaceId, this.docId),
      ).pipe(
        smartRetry(),
        tap((meta) => {
          this.cache.set<ServerDocMetaType>(this.cacheKey, meta);
        }),
        catchErrorInto(this.error$),
        onStart(() => this.isRevalidating$.next(true)),
        onComplete(() => this.isRevalidating$.next(false)),
      );
    }),
  );
}
