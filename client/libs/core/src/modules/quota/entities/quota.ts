import { DebugLogger } from "@myoxus/debug";
import type { WorkspaceQuotaQuery } from "@myoxus/graphql";
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
import { cssVar } from "@myoxus/theme";
import { formatByteSize } from "@virgultum/global/utils";
import { tap } from "rxjs";

import type { WorkspaceService } from "../../workspace";
import type { WorkspaceQuotaStore } from "../stores/quota";
import {
  computeStorageQuotaPercent,
  formatStorageQuotaLimit,
} from "../utils/quota-display";

type QuotaType = NonNullable<WorkspaceQuotaQuery["workspace"]>["quota"];

const logger = new DebugLogger("myoxus:workspace-permission");

export class WorkspaceQuota extends Entity {
  quota$ = new LiveData<QuotaType | null>(null);
  isRevalidating$ = new LiveData(false);
  error$ = new LiveData<any>(null);

  /** Used storage in bytes */
  used$ = new LiveData<number | null>(null);
  /** Formatted used storage */
  usedFormatted$ = this.used$.map((used) =>
    used !== null ? formatByteSize(used) : null,
  );
  /** Maximum storage limit in bytes */
  max$ = this.quota$.map((quota) => (quota ? quota.storageQuota : null));
  /** Maximum storage limit formatted */
  maxFormatted$ = this.max$.map(formatStorageQuotaLimit);

  /** Percentage of storage used */
  percent$ = LiveData.computed((get) => {
    const max = get(this.max$);
    const used = get(this.used$);
    return computeStorageQuotaPercent(max, used);
  });

  color$ = this.percent$.map((percent) =>
    percent !== null
      ? percent > 80
        ? cssVar("errorColor")
        : cssVar("processingColor")
      : null,
  );

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly store: WorkspaceQuotaStore,
  ) {
    super();
  }

  revalidate = effect(
    exhaustMapWithTrailing(() => {
      return fromPromise(async (signal) => {
        const data = await this.store.fetchWorkspaceQuota(
          this.workspaceService.workspace.id,
          signal,
        );
        return { quota: data, used: data.usedStorageQuota };
      }).pipe(
        smartRetry(),
        tap((data) => {
          if (data) {
            const { quota, used } = data;
            this.quota$.next(quota);
            this.used$.next(used);
          } else {
            this.quota$.next(null);
            this.used$.next(null);
          }
        }),
        catchErrorInto(this.error$, (error) => {
          logger.error("Failed to fetch workspace quota", error);
        }),
        onStart(() => this.isRevalidating$.setValue(true)),
        onComplete(() => this.isRevalidating$.setValue(false)),
      );
    }),
  );

  waitForRevalidation(signal?: AbortSignal) {
    this.revalidate();
    return this.isRevalidating$.waitFor(
      (isRevalidating) => !isRevalidating,
      signal,
    );
  }

  reset() {
    this.quota$.next(null);
    this.used$.next(null);
    this.error$.next(null);
    this.isRevalidating$.next(false);
  }

  override dispose(): void {
    this.revalidate.unsubscribe();
  }
}
