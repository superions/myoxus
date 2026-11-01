import { LiveData } from "@myoxus/infra";

import type {
  Notification,
  NotificationFilter,
  NotificationStore,
} from "../stores/notification";

export type NotificationFeedSnapshot = {
  generation: number;
  notifications: Notification[];
  nextCursor: string | undefined;
  hasMore: boolean;
  totalCount: number;
};

type NotificationFeedActions = {
  canRead: () => boolean;
  readNotification: (id: string) => Promise<void>;
  readAllNotifications: () => Promise<void>;
  release: (feed: NotificationFeed) => void;
  setGlobalUnreadCount: (count: number) => void;
};

const PAGE_SIZE = 20;

function filtersEqual(left: NotificationFilter, right: NotificationFilter) {
  return (
    left.includeRead === right.includeRead &&
    (left.types ?? []).join(",") === (right.types ?? []).join(",")
  );
}

/**
 * Independently materialized notification feed.
 *
 * Each consumer owns its pagination and request lifecycle while mutations are
 * coordinated by `NotificationService` across all active feeds.
 */
export class NotificationFeed {
  readonly notifications$ = new LiveData<Notification[]>([]);
  readonly filter$ = new LiveData<NotificationFilter>({ includeRead: false });
  readonly isLoading$ = new LiveData(false);
  readonly error$ = new LiveData<unknown>(null);
  readonly nextCursor$ = new LiveData<string | undefined>(undefined);
  readonly hasMore$ = new LiveData(true);
  readonly totalCount$ = new LiveData(0);

  private abortController: AbortController | undefined;
  private initialized = false;
  private requestGeneration = 0;
  private canonicalGeneration = 0;
  private disposed = false;
  private leases = 0;

  constructor(
    private readonly store: NotificationStore,
    private readonly actions: NotificationFeedActions,
    filter: NotificationFilter,
  ) {
    this.filter$.setValue(filter);
  }

  get mirrorsGlobalUnreadCount() {
    const filter = this.filter$.value;
    return !filter.includeRead && filter.types === undefined;
  }

  /**
   * Keep the feed alive while a React consumer is mounted.
   *
   * Disposal is deferred to a microtask so React Strict Effects can perform
   * their development-only setup/cleanup/setup probe without invalidating the
   * memoized feed between both setups. A real unmount leaves no lease behind
   * and therefore still aborts requests and releases the service registration.
   */
  retain() {
    if (this.disposed) {
      throw new Error("Cannot retain a disposed notification feed");
    }
    this.leases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases = Math.max(0, this.leases - 1);
      queueMicrotask(() => {
        if (this.leases === 0) this.dispose();
      });
    };
  }

  setFilter(filter: NotificationFilter) {
    if (filtersEqual(this.filter$.value, filter)) return;
    this.filter$.setValue(filter);
    void this.refresh();
  }

  /**
   * Load a newly created feed exactly once.
   *
   * React Strict Effects mounts consumers twice in development. Re-running a
   * destructive refresh during that probe aborts the first GraphQL request and
   * can make a deduplicating client hand the aborted request to the second
   * setup. Explicit refreshes remain available for retry and push updates.
   */
  async initialize() {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    await this.loadMore();
  }

  async refresh() {
    this.initialized = true;
    this.reset();
    await this.loadMore();
  }

  async loadMore() {
    if (
      this.disposed ||
      !this.actions.canRead() ||
      this.isLoading$.value ||
      !this.hasMore$.value
    )
      return;

    const generation = this.requestGeneration;
    const controller = new AbortController();
    this.abortController = controller;
    this.isLoading$.setValue(true);
    this.error$.setValue(null);

    try {
      const result = await this.store.listNotification(
        {
          first: PAGE_SIZE,
          after: this.nextCursor$.value,
        },
        this.filter$.value,
        controller.signal,
      );
      if (
        !result ||
        generation !== this.requestGeneration ||
        this.disposed ||
        !this.actions.canRead()
      ) {
        return;
      }

      this.canonicalGeneration += 1;
      const known = new Set(
        this.notifications$.value.map((notification) => notification.id),
      );
      const appended = result.edges
        .map((edge) => edge.node)
        .filter((notification) => !known.has(notification.id));
      this.notifications$.next([...this.notifications$.value, ...appended]);
      this.totalCount$.setValue(result.totalCount);
      if (this.mirrorsGlobalUnreadCount) {
        this.actions.setGlobalUnreadCount(result.totalCount);
      }
      this.hasMore$.setValue(result.pageInfo.hasNextPage);
      this.nextCursor$.setValue(result.pageInfo.endCursor ?? undefined);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        generation === this.requestGeneration &&
        !this.disposed &&
        this.actions.canRead()
      ) {
        this.error$.setValue(error);
      }
    } finally {
      if (generation === this.requestGeneration) {
        this.isLoading$.setValue(false);
      }
    }
  }

  readNotification(id: string) {
    return this.actions.readNotification(id);
  }

  readAllNotifications() {
    return this.actions.readAllNotifications();
  }

  snapshot(): NotificationFeedSnapshot {
    return {
      generation: this.canonicalGeneration,
      notifications: [...this.notifications$.value],
      nextCursor: this.nextCursor$.value,
      hasMore: this.hasMore$.value,
      totalCount: this.totalCount$.value,
    };
  }

  restore(snapshot: NotificationFeedSnapshot) {
    // A failed optimistic read cannot restore private data over a newer
    // canonical projection, account reset, or disposed consumer.
    if (this.disposed || snapshot.generation !== this.canonicalGeneration)
      return false;
    this.notifications$.setValue(snapshot.notifications);
    this.nextCursor$.setValue(snapshot.nextCursor);
    this.hasMore$.setValue(snapshot.hasMore);
    this.totalCount$.setValue(snapshot.totalCount);
    return true;
  }

  applyRead(id: string) {
    const notification = this.notifications$.value.find(
      (candidate) => candidate.id === id,
    );
    if (!notification || notification.read) return false;

    if (this.filter$.value.includeRead) {
      this.notifications$.next(
        this.notifications$.value.map((candidate) =>
          candidate.id === id ? { ...candidate, read: true } : candidate,
        ),
      );
    } else {
      this.notifications$.next(
        this.notifications$.value.filter((candidate) => candidate.id !== id),
      );
      this.totalCount$.setValue(Math.max(0, this.totalCount$.value - 1));
    }
    return true;
  }

  applyReadAll() {
    if (this.filter$.value.includeRead) {
      this.notifications$.next(
        this.notifications$.value.map((notification) =>
          notification.read ? notification : { ...notification, read: true },
        ),
      );
      return;
    }
    this.notifications$.setValue([]);
    this.totalCount$.setValue(0);
    this.hasMore$.setValue(false);
    this.nextCursor$.setValue(undefined);
  }

  reset() {
    this.abortController?.abort();
    this.abortController = undefined;
    this.requestGeneration += 1;
    this.canonicalGeneration += 1;
    this.notifications$.setValue([]);
    this.nextCursor$.setValue(undefined);
    this.hasMore$.setValue(true);
    this.totalCount$.setValue(0);
    this.isLoading$.setValue(false);
    this.error$.setValue(null);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.actions.release(this);
  }
}
