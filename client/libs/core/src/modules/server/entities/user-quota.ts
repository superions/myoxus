import type { QuotaQuery } from "@myoxus/graphql";
import {
  catchErrorInto,
  effect,
  Entity,
  exhaustMapSwitchUntilChanged,
  fromPromise,
  LiveData,
  onComplete,
  onStart,
  smartRetry,
} from "@myoxus/infra";
import { cssVar } from "@myoxus/theme";
import { formatByteSize } from "@virgultum/global/utils";
import { map, tap } from "rxjs";

import {
  computeStorageQuotaPercent,
  formatStorageQuotaLimit,
} from "../../quota/utils/quota-display";
import type { AuthService } from "../services/auth";
import type { UserQuotaStore } from "../stores/user-quota";

export class UserQuota extends Entity {
  quota$ = new LiveData<NonNullable<QuotaQuery["currentUser"]>["quota"] | null>(
    null,
  );
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

  isRevalidating$ = new LiveData(false);
  error$ = new LiveData<any | null>(null);

  constructor(
    private readonly authService: AuthService,
    private readonly store: UserQuotaStore,
  ) {
    super();
  }

  revalidate = effect(
    map(() => ({
      accountId: this.authService.session.account$.value?.id,
    })),
    exhaustMapSwitchUntilChanged(
      (a, b) => a.accountId === b.accountId,
      ({ accountId }) =>
        fromPromise(async (signal) => {
          if (!accountId) {
            return; // no quota if no user
          }
          const { quota, used } = await this.store.fetchUserQuota(signal);

          return { quota, used };
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
          catchErrorInto(this.error$),
          onStart(() => this.isRevalidating$.next(true)),
          onComplete(() => this.isRevalidating$.next(false)),
        ),
      () => {
        // Reset the state when the user is changed
        this.reset();
      },
    ),
  );

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
