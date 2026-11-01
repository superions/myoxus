import {
  effect,
  exhaustMapWithTrailing,
  fromPromise,
  LiveData,
  onComplete,
  OnEvent,
  onStart,
  Service,
  smartRetry,
} from "@myoxus/infra";
import { onNotificationChanged } from "@myoxus/storage/cloud";
import { catchError, EMPTY, switchMap, tap, timer } from "rxjs";

import { ApplicationFocused } from "../../lifecycle";
import { AccountChanged, type AuthService } from "../../server";
import { ServerStarted } from "../../server/events/server-started";
import type { NotificationStore } from "../stores/notification";

@OnEvent(ApplicationFocused, (s) => s.handleApplicationFocused)
@OnEvent(ServerStarted, (s) => s.handleServerStarted)
@OnEvent(AccountChanged, (s) => s.handleAccountChanged)
export class NotificationCountService extends Service {
  private ownerGeneration = 0;
  private disposed = false;
  private countRevision = 0;
  get revision() {
    return this.countRevision;
  }
  private readonly unsubscribeNotificationPush: (() => void) | undefined;

  constructor(
    private readonly store: NotificationStore,
    private readonly authService: AuthService,
  ) {
    super();
    // Persisted new/read/read-all events invalidate the same count cache.
    this.unsubscribeNotificationPush = onNotificationChanged(() => {
      if (!this.disposed) this.revalidate();
    });
  }

  loggedIn$ = this.authService.session.status$.map(
    (v) => v === "authenticated",
  );

  readonly count$ = LiveData.from(this.store.watchNotificationCountCache(), 0);
  readonly isLoading$ = new LiveData(false);
  readonly error$ = new LiveData<any>(null);

  revalidate = effect(
    // Switching the owner cancels the whole timer/request chain, including a
    // count read that ignored transport abort while authentication changed.
    switchMap(() =>
      timer(0, 30000).pipe(
        exhaustMapWithTrailing(() => {
          const generation = this.ownerGeneration;
          const accountId = this.authService.session.account$.value?.id ?? null;
          const current = () =>
            !this.disposed &&
            generation === this.ownerGeneration &&
            accountId === (this.authService.session.account$.value?.id ?? null);
          return fromPromise((signal) => {
            if (this.disposed || !accountId || !this.loggedIn$.value)
              return Promise.resolve(0);
            return this.store.getNotificationCount(signal);
          }).pipe(
            tap((result) => {
              if (current()) this.setCount(result ?? 0);
            }),
            smartRetry(),
            catchError((error) => {
              if (current()) this.error$.setValue(error);
              return EMPTY;
            }),
            onStart(() => {
              if (current()) this.isLoading$.setValue(true);
            }),
            onComplete(() => {
              if (current()) this.isLoading$.setValue(false);
            }),
          );
        }),
      ),
    ),
  );

  handleApplicationFocused() {
    if (!this.disposed) this.revalidate();
  }

  handleServerStarted() {
    if (!this.disposed) this.revalidate();
  }

  handleAccountChanged() {
    if (this.disposed) return;
    this.ownerGeneration += 1;
    this.error$.setValue(null);
    this.isLoading$.setValue(false);
    this.setCount(0);
    this.revalidate();
  }

  setCount(count: number) {
    if (this.disposed) return;
    this.countRevision += 1;
    this.store.setNotificationCountCache(count);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ownerGeneration += 1;
    super.dispose();
    this.revalidate.unsubscribe();
    this.unsubscribeNotificationPush?.();
  }
}
