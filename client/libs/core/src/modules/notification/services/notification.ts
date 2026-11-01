import { OnEvent, Service } from "@myoxus/infra";
import { onNotificationChanged } from "@myoxus/storage/cloud";
import type { DocMode } from "@virgultum/editor/model";

import { AccountChanged, type AuthService } from "../../server";

import { NotificationFeed } from "../entities/feed";
import type {
  NotificationFilter,
  NotificationStore,
} from "../stores/notification";
import type { NotificationCountService } from "./count";

@OnEvent(AccountChanged, (s) => s.handleAccountChanged)
export class NotificationService extends Service {
  private ownerGeneration = 0;
  private disposed = false;
  private accountId = this.authService.session.account$.value?.id ?? null;
  private readonly feeds = new Set<NotificationFeed>();
  private readonly readRequests = new Map<string, Promise<void>>();
  private readonly unsubscribeNotificationPush: () => void;

  constructor(
    private readonly store: NotificationStore,
    private readonly notificationCount: NotificationCountService,
    private readonly authService: AuthService,
  ) {
    super();
    this.unsubscribeNotificationPush = onNotificationChanged(() => {
      if (this.disposed) return;
      for (const feed of this.feeds) {
        void feed.refresh();
      }
    });
  }

  private currentOwner(generation: number) {
    return (
      !this.disposed &&
      generation === this.ownerGeneration &&
      this.accountId === (this.authService.session.account$.value?.id ?? null)
    );
  }

  handleAccountChanged() {
    if (this.disposed) return;
    this.ownerGeneration += 1;
    this.accountId = this.authService.session.account$.value?.id ?? null;
    this.readRequests.clear();
    // Clear every mounted surface before starting any request for the new actor.
    for (const feed of this.feeds) feed.reset();
    if (this.authService.session.account$.value) {
      for (const feed of this.feeds) void feed.refresh();
    }
  }

  createFeed(filter: NotificationFilter) {
    const feed = new NotificationFeed(
      this.store,
      {
        canRead: () =>
          this.currentOwner(this.ownerGeneration) && this.accountId !== null,
        readNotification: (id) => this.readNotification(id),
        readAllNotifications: () => this.readAllNotifications(),
        release: (releasedFeed) => this.feeds.delete(releasedFeed),
        setGlobalUnreadCount: (count) => this.notificationCount.setCount(count),
      },
      filter,
    );
    this.feeds.add(feed);
    return feed;
  }

  readNotification(id: string) {
    if (!this.currentOwner(this.ownerGeneration) || this.accountId === null)
      return Promise.resolve();
    const existing = this.readRequests.get(id);
    if (existing) return existing;

    const request = this.performReadNotification(
      id,
      this.ownerGeneration,
    ).finally(() => {
      // An old actor's completion must not delete the new actor's request slot.
      if (this.readRequests.get(id) === request) this.readRequests.delete(id);
    });
    this.readRequests.set(id, request);
    return request;
  }

  private async performReadNotification(id: string, owner: number) {
    if (!this.currentOwner(owner) || !this.authService.session.account$.value)
      return;
    const snapshots = new Map(
      [...this.feeds].map((feed) => [feed, feed.snapshot()]),
    );
    const previousCount = this.notificationCount.count$.value;
    let wasUnread = false;
    for (const feed of this.feeds) {
      if (feed.applyRead(id)) wasUnread = true;
    }
    if (wasUnread) {
      this.notificationCount.setCount(Math.max(0, previousCount - 1));
    }

    const countRevision = this.notificationCount.revision;
    try {
      await this.store.readNotification(id);
    } catch (error) {
      if (!this.currentOwner(owner)) return;
      for (const [feed, snapshot] of snapshots) feed.restore(snapshot);
      // Navigation may dispose the feed; the badge still has its own actor and
      // revision fence, independent of whether private cards can be restored.
      if (wasUnread && this.notificationCount.revision === countRevision)
        this.notificationCount.setCount(previousCount);
      throw error;
    }
  }

  async readAllNotifications() {
    const owner = this.ownerGeneration;
    if (!this.currentOwner(owner) || !this.authService.session.account$.value)
      return;
    const snapshots = new Map(
      [...this.feeds].map((feed) => [feed, feed.snapshot()]),
    );
    const previousCount = this.notificationCount.count$.value;
    for (const feed of this.feeds) feed.applyReadAll();
    this.notificationCount.setCount(0);

    const countRevision = this.notificationCount.revision;
    try {
      await this.store.readAllNotifications();
    } catch (error) {
      if (!this.currentOwner(owner)) return;
      for (const [feed, snapshot] of snapshots) feed.restore(snapshot);
      if (this.notificationCount.revision === countRevision)
        this.notificationCount.setCount(previousCount);
      throw error;
    }
  }

  documentTargetExists(workspaceId: string, docId: string) {
    return this.store.documentTargetExists(workspaceId, docId);
  }

  async mentionUser(
    userId: string,
    workspaceId: string,
    doc: {
      id: string;
      title: string;
      blockId?: string;
      elementId?: string;
      mode: DocMode;
    },
  ): Promise<string> {
    return this.store.mentionUser(userId, workspaceId, doc);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ownerGeneration += 1;
    this.readRequests.clear();
    super.dispose();
    this.unsubscribeNotificationPush();
    // Disposing a feed may mutate the source set; iterate over a stable snapshot.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const feed of [...this.feeds]) feed.dispose();
  }
}
