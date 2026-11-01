/**
 * @vitest-environment happy-dom
 */

import { NotificationType } from "@myoxus/graphql";
import { Framework, LiveData, MemoryMemento } from "@myoxus/infra";
import { of } from "rxjs";
import {
  AccountChanged,
  AuthService,
  GraphQLService,
  ServerService,
} from "../../server";
import type { AuthAccountInfo } from "../../server/entities/session";
import { GlobalSessionState } from "../../storage";
import { afterEach, describe, expect, test, vi } from "vitest";

import { type Notification, NotificationStore } from "../stores/notification";
import { NotificationCountService } from "./count";
import { NotificationService } from "./notification";

const push = vi.hoisted(() => ({
  callback: null as null | ((payload: unknown) => void),
  unsubscribed: false,
}));

vi.mock("@myoxus/storage/cloud", () => ({
  onNotificationChanged(callback: (payload: unknown) => void) {
    push.callback = callback;
    return () => {
      push.unsubscribed = true;
    };
  },
}));

const unread = {
  id: "notification-unread",
  type: NotificationType.Mention,
  read: false,
  createdAt: "2026-07-27T09:00:00Z",
} as Notification;
const history = {
  id: "notification-read",
  type: NotificationType.Comment,
  read: true,
  createdAt: "2026-07-26T09:00:00Z",
} as Notification;

function page(
  notifications: Notification[],
  totalCount = notifications.length,
) {
  return {
    edges: notifications.map((node, index) => ({
      cursor: `cursor-${index}`,
      node,
    })),
    pageInfo: {
      endCursor: notifications.length ? "cursor-last" : null,
      hasNextPage: false,
    },
    totalCount,
  };
}

const services = new Set<NotificationService>();
const counts = new Set<NotificationCountService>();

function createService(
  store: object,
  count: object,
  account$ = new LiveData<AuthAccountInfo | null>({
    id: "actor-a",
    label: "Actor A",
  }),
) {
  const framework = new Framework();
  framework
    .service(AuthService, {
      session: { account$, status$: new LiveData("authenticated") },
    } as unknown as AuthService)
    .store(NotificationStore, store as unknown as NotificationStore)
    .service(
      NotificationCountService,
      Object.assign(count, {
        handleAccountChanged: () =>
          (count as { setCount: (value: number) => void }).setCount(0),
      }) as unknown as NotificationCountService,
    )
    .service(NotificationService, [
      NotificationStore,
      NotificationCountService,
      AuthService,
    ]);
  const service = framework.provider().get(NotificationService);
  services.add(service);
  return service;
}

describe("Notification feeds", () => {
  afterEach(() => {
    for (const service of services) service.dispose();
    services.clear();
    for (const count of counts) count.dispose();
    counts.clear();
    push.callback = null;
    push.unsubscribed = false;
    vi.clearAllMocks();
  });

  test("new, read and read-all pushes revalidate the consuming unread count", async () => {
    const store = {
      watchNotificationCountCache: () => of(0),
      getNotificationCount: vi.fn().mockResolvedValue(2),
      setNotificationCountCache: vi.fn(),
    };
    const framework = new Framework();
    framework
      .store(NotificationStore, store as unknown as NotificationStore)
      .service(AuthService, {
        session: {
          status$: new LiveData("authenticated"),
          account$: new LiveData({ id: "actor-a" }),
        },
      } as unknown as AuthService)
      .service(NotificationCountService, [NotificationStore, AuthService]);
    const count = framework.provider().get(NotificationCountService);
    for (const eventType of [
      "notification_new",
      "notification_read",
      "notification_read_all",
    ]) {
      const calls = store.getNotificationCount.mock.calls.length;
      push.callback?.(eventType);
      await vi.waitFor(() =>
        expect(store.getNotificationCount).toHaveBeenCalledTimes(calls + 1),
      );
      expect(store.setNotificationCountCache).toHaveBeenLastCalledWith(2);
    }
    count.dispose();
    expect(push.unsubscribed).toBe(true);
  });

  test("keeps preview and history state independent while sharing read mutations", async () => {
    const store = {
      listNotification: vi
        .fn()
        .mockResolvedValueOnce(page([unread], 1))
        .mockResolvedValueOnce(page([unread, history], 2)),
      readNotification: vi.fn().mockResolvedValue({}),
      readAllNotifications: vi.fn().mockResolvedValue({}),
    };
    const count = {
      revision: 0,
      count$: { value: 1 },
      setCount: vi.fn((value: number) => {
        count.count$.value = value;
        count.revision += 1;
      }),
    };
    const service = createService(store, count);
    const preview = service.createFeed({ includeRead: false });
    const historyFeed = service.createFeed({ includeRead: true });

    await Promise.all([preview.loadMore(), historyFeed.loadMore()]);

    expect(preview.notifications$.value).toEqual([unread]);
    expect(historyFeed.notifications$.value).toEqual([unread, history]);
    expect(count.setCount).toHaveBeenCalledTimes(1);
    expect(count.setCount).toHaveBeenLastCalledWith(1);

    await historyFeed.readNotification(unread.id);
    expect(preview.notifications$.value).toEqual([]);
    expect(historyFeed.notifications$.value).toEqual([
      { ...unread, read: true },
      history,
    ]);
    expect(count.count$.value).toBe(0);

    preview.dispose();
    historyFeed.dispose();
    service.dispose();
    expect(push.unsubscribed).toBe(true);
  });

  test("rolls every active feed and the global count back when marking read fails", async () => {
    const store = {
      listNotification: vi
        .fn()
        .mockResolvedValueOnce(page([unread], 1))
        .mockResolvedValueOnce(page([unread], 1)),
      readNotification: vi.fn().mockRejectedValue(new Error("offline")),
      readAllNotifications: vi.fn().mockRejectedValue(new Error("offline")),
    };
    const count = {
      revision: 0,
      count$: { value: 1 },
      setCount: vi.fn((value: number) => {
        count.count$.value = value;
        count.revision += 1;
      }),
    };
    const service = createService(store, count);
    const preview = service.createFeed({ includeRead: false });
    const mentionFeed = service.createFeed({
      includeRead: false,
      types: [NotificationType.Mention],
    });
    await Promise.all([preview.loadMore(), mentionFeed.loadMore()]);

    await expect(preview.readNotification(unread.id)).rejects.toThrow(
      "offline",
    );
    expect(preview.notifications$.value).toEqual([unread]);
    expect(mentionFeed.notifications$.value).toEqual([unread]);
    expect(count.count$.value).toBe(1);

    await expect(preview.readAllNotifications()).rejects.toThrow("offline");
    expect(preview.notifications$.value).toEqual([unread]);
    expect(mentionFeed.notifications$.value).toEqual([unread]);
    expect(count.count$.value).toBe(1);
  });

  test("aborts stale pages on filter change and refreshes every active feed on push", async () => {
    let resolveFirst: ((value: ReturnType<typeof page>) => void) | undefined;
    const store = {
      listNotification: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<ReturnType<typeof page>>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce(page([history], 1))
        .mockResolvedValueOnce(page([history], 1)),
      readNotification: vi.fn(),
      readAllNotifications: vi.fn(),
    };
    const count = {
      revision: 0,
      count$: { value: 0 },
      setCount: vi.fn(),
    };
    const service = createService(store, count);
    const feed = service.createFeed({ includeRead: false });

    const staleRequest = feed.loadMore();
    feed.setFilter({ includeRead: true });
    resolveFirst?.(page([unread], 1));
    await staleRequest;
    await vi.waitFor(() =>
      expect(feed.notifications$.value).toEqual([history]),
    );

    push.callback?.("notification_new");
    await vi.waitFor(() =>
      expect(store.listNotification).toHaveBeenCalledTimes(3),
    );
    expect(feed.notifications$.value).toEqual([history]);
    store.listNotification.mockResolvedValue(page([history], 1));
    for (const eventType of ["notification_read", "notification_read_all"]) {
      const calls = store.listNotification.mock.calls.length;
      push.callback?.(eventType);
      await vi.waitFor(() =>
        expect(store.listNotification).toHaveBeenCalledTimes(calls + 1),
      );
    }
    service.dispose();
    expect(push.unsubscribed).toBe(true);
  });

  test("appends cursor pages without duplicating notifications", async () => {
    const firstPage = {
      ...page([unread], 2),
      pageInfo: {
        endCursor: "cursor-next",
        hasNextPage: true,
      },
    };
    const store = {
      listNotification: vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(page([unread, history], 2)),
      readNotification: vi.fn(),
      readAllNotifications: vi.fn(),
    };
    const count = {
      revision: 0,
      count$: { value: 0 },
      setCount: vi.fn(),
    };
    const service = createService(store, count);
    const feed = service.createFeed({ includeRead: true });

    await feed.loadMore();
    await feed.loadMore();

    expect(feed.notifications$.value).toEqual([unread, history]);
    expect(store.listNotification).toHaveBeenNthCalledWith(
      2,
      { after: "cursor-next", first: 20 },
      { includeRead: true },
      expect.any(AbortSignal),
    );
  });

  test("initializes only once across the React Strict Effects lease probe", async () => {
    const store = {
      listNotification: vi.fn().mockResolvedValue(page([unread], 1)),
      readNotification: vi.fn(),
      readAllNotifications: vi.fn(),
    };
    const count = {
      revision: 0,
      count$: { value: 0 },
      setCount: vi.fn(),
    };
    const service = createService(store, count);
    const feed = service.createFeed({ includeRead: false });

    const releaseProbe = feed.retain();
    const probeInitialization = feed.initialize();
    releaseProbe();
    const releaseMountedConsumer = feed.retain();
    const mountedInitialization = feed.initialize();
    await Promise.resolve();

    await Promise.all([probeInitialization, mountedInitialization]);
    expect(feed.notifications$.value).toEqual([unread]);
    expect(store.listNotification).toHaveBeenCalledTimes(1);

    releaseMountedConsumer();
    await Promise.resolve();
    await feed.initialize();
    expect(store.listNotification).toHaveBeenCalledTimes(1);
  });

  test("delegates document target validation to the authoritative store", async () => {
    const store = {
      documentTargetExists: vi.fn().mockResolvedValue(true),
      listNotification: vi.fn(),
      readNotification: vi.fn(),
      readAllNotifications: vi.fn(),
    };
    const count = {
      revision: 0,
      count$: { value: 0 },
      setCount: vi.fn(),
    };
    const service = createService(store, count);

    await expect(
      service.documentTargetExists("workspace-1", "doc-1"),
    ).resolves.toBe(true);
    expect(store.documentTargetExists).toHaveBeenCalledWith(
      "workspace-1",
      "doc-1",
    );
  });

  test.each(["single"])(
    "does not restore an old Task title after %s-read failure races a current push projection",
    async (mode) => {
      const available = {
        ...unread,
        type: NotificationType.DatabaseTaskChanged,
        body: {
          workspaceId: "workspace-a",
          databaseId: "database-a",
          rowId: "task-a",
          state: "Available",
          targetKind: "Task",
          rowTitle: "Old private Task",
        },
      };
      const unavailable = {
        ...available,
        body: {
          ...available.body,
          state: "Unavailable",
          targetKind: null,
          rowTitle: null,
        },
      };
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const store = {
        listNotification: vi
          .fn()
          .mockResolvedValueOnce(page([available], 4))
          .mockResolvedValueOnce(page([unavailable], 1)),
        readNotification: vi.fn(() => pending),
        readAllNotifications: vi.fn(() => pending),
      };
      const count = {
        revision: 0,
        count$: { value: 0 },
        setCount: vi.fn((value: number) => {
          count.count$.value = value;
          count.revision += 1;
        }),
      };
      const service = createService(store, count);
      const feed = service.createFeed({ includeRead: false });
      await feed.initialize();
      const read =
        mode === "single"
          ? feed.readNotification(unread.id)
          : feed.readAllNotifications();
      const failure = expect(read).rejects.toThrow("read failed");
      push.callback?.("notification_new");
      await vi.waitFor(() =>
        expect(feed.notifications$.value).toEqual([unavailable]),
      );
      expect(count.count$.value).toBe(1);
      reject(new Error("read failed"));
      await failure;
      expect(feed.notifications$.value).toEqual([unavailable]);
      expect(count.count$.value).toBe(1);
      expect(store.readNotification).toHaveBeenCalledTimes(
        mode === "single" ? 1 : 0,
      );
      expect(store.readAllNotifications).toHaveBeenCalledTimes(
        mode === "all" ? 1 : 0,
      );
      expect(store.listNotification).toHaveBeenCalledTimes(2);
    },
  );

  test.each(["success"])(
    "fences an old actor's late list %s, clears logout, and loads the next account",
    async (outcome) => {
      const account$ = new LiveData<AuthAccountInfo | null>({
        id: "actor-a",
        label: "Actor A",
      });
      const privateTask = {
        ...unread,
        type: NotificationType.DatabaseTaskChanged,
        body: { rowTitle: "Actor A private Task" },
      };
      const nextTask = {
        ...history,
        body: { rowTitle: "Actor B current Task" },
      };
      let finish!: (value: ReturnType<typeof page>) => void;
      let reject!: (error: Error) => void;
      let signal!: AbortSignal;
      const store = {
        listNotification: vi
          .fn()
          .mockImplementationOnce(
            (_pagination, _filter, owned: AbortSignal) => {
              signal = owned;
              return new Promise<ReturnType<typeof page>>((resolve, fail) => {
                finish = resolve;
                reject = fail;
              });
            },
          )
          .mockResolvedValue(page([nextTask], 2)),
        readNotification: vi.fn(),
        readAllNotifications: vi.fn(),
      };
      const count = {
        revision: 0,
        count$: { value: 0 },
        setCount: vi.fn((value: number) => {
          count.count$.value = value;
          count.revision += 1;
        }),
      };
      const service = createService(store, count, account$);
      const feed = service.createFeed({ includeRead: false });
      const old = feed.initialize();
      account$.setValue({ id: "actor-b", label: "Actor B" });
      service.eventBus.emit(AccountChanged, account$.value);
      expect(feed.notifications$.value).toEqual([]);
      expect(signal.aborted).toBe(true);
      await vi.waitFor(() =>
        expect(feed.notifications$.value).toEqual([nextTask]),
      );
      if (outcome === "success") finish(page([privateTask], 99));
      else reject(new Error("Actor A late error"));
      await old;
      expect(feed.notifications$.value).toEqual([nextTask]);
      expect(feed.error$.value).toBeNull();
      expect(count.count$.value).toBe(2);
      account$.setValue(null);
      service.eventBus.emit(AccountChanged, null);
      expect(feed.notifications$.value).toEqual([]);
      await feed.refresh();
      expect(store.listNotification).toHaveBeenCalledTimes(2);
      account$.setValue({ id: "actor-c", label: "Actor C" });
      service.eventBus.emit(AccountChanged, account$.value);
      await vi.waitFor(() =>
        expect(store.listNotification).toHaveBeenCalledTimes(3),
      );
      expect(feed.notifications$.value).toEqual([nextTask]);
    },
  );

  test("old read failures cannot restore across accounts or delete the current actor's deduplicated read", async () => {
    const account$ = new LiveData<AuthAccountInfo | null>({
      id: "actor-a",
      label: "Actor A",
    });
    let rejectOld!: (error: Error) => void;
    let finishCurrent!: () => void;
    const store = {
      listNotification: vi.fn().mockResolvedValue(page([unread], 1)),
      readNotification: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectOld = reject;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishCurrent = resolve;
            }),
        ),
      readAllNotifications: vi.fn(),
    };
    const count = {
      revision: 0,
      count$: { value: 0 },
      setCount: vi.fn((value: number) => {
        count.count$.value = value;
        count.revision += 1;
      }),
    };
    const service = createService(store, count, account$);
    const feed = service.createFeed({ includeRead: false });
    await feed.initialize();
    const old = feed.readNotification(unread.id);
    account$.setValue({ id: "actor-b", label: "Actor B" });
    service.eventBus.emit(AccountChanged, account$.value);
    await vi.waitFor(() => expect(feed.notifications$.value).toEqual([unread]));
    const current = feed.readNotification(unread.id);
    rejectOld(new Error("Actor A late read error"));
    await old;
    expect(feed.notifications$.value).toEqual([]);
    expect(count.count$.value).toBe(0);
    expect(feed.readNotification(unread.id)).toBe(current);
    expect(store.readNotification).toHaveBeenCalledTimes(2);
    finishCurrent();
    await current;
    expect(store.readNotification).toHaveBeenCalledTimes(2);
  });

  test.each(["success"])(
    "keeps count cache and late %s scoped to the current actor",
    async (outcome) => {
      const account$ = new LiveData<AuthAccountInfo | null>({
        id: "actor-a",
        label: "Actor A",
      });
      const state = new MemoryMemento();
      state.setAll({
        "notification-count:server-a": 99,
        "notification-count:server-a:actor-a": 4,
        "notification-count:server-a:actor-b": 8,
      });
      const watch = vi.spyOn(state, "watch");
      const set = vi.spyOn(state, "set");
      let finish!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const gql = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve, fail) => {
              finish = resolve;
              reject = fail;
            }),
        )
        .mockResolvedValue({
          currentUser: { notifications: { totalCount: 7 } },
        });
      const framework = new Framework();
      framework
        .service(AuthService, {
          session: { account$, status$: new LiveData("authenticated") },
        } as unknown as AuthService)
        .service(GraphQLService, { gql } as unknown as GraphQLService)
        .service(ServerService, {
          server: { id: "server-a" },
        } as unknown as ServerService)
        .impl(GlobalSessionState, state)
        .store(NotificationStore, [
          GraphQLService,
          ServerService,
          GlobalSessionState,
          AuthService,
        ])
        .service(NotificationCountService, [NotificationStore, AuthService]);
      const count = framework.provider().get(NotificationCountService);
      counts.add(count);
      expect(count.count$.value).toBe(4);
      count.revalidate();
      await vi.waitFor(() => expect(gql).toHaveBeenCalledTimes(1));
      const oldSignal = gql.mock.calls[0]![0].context.signal as AbortSignal;
      const oldRequest = gql.mock.results[0]!.value;
      account$.setValue({ id: "actor-b", label: "Actor B" });
      count.eventBus.emit(AccountChanged, account$.value);
      expect(oldSignal.aborted).toBe(true);
      await vi.waitFor(() => expect(count.count$.value).toBe(7));
      if (outcome === "success") {
        const delivered = expect(oldRequest).resolves.toEqual({
          currentUser: { notifications: { totalCount: 99 } },
        });
        finish({ currentUser: { notifications: { totalCount: 99 } } });
        await delivered;
      } else {
        const failed = expect(oldRequest).rejects.toThrow(
          "Actor A late count failure",
        );
        reject(new Error("Actor A late count failure"));
        await failed;
      }
      await Promise.resolve();
      expect(count.count$.value).toBe(7);
      expect(count.error$.value).toBeNull();
      expect(count.isLoading$.value).toBe(false);
      const watchedKeys = watch.mock.calls.map(([key]) => key);
      expect(watchedKeys.slice(0, 2)).toEqual([
        "notification-count:server-a:actor-a",
        "notification-count:server-a:actor-b",
      ]);
      // Re-subscribing to the current Memento value is legitimate; returning
      // to an old actor or the unscoped legacy key is not.
      expect(
        watchedKeys
          .slice(2)
          .every((key) => key === "notification-count:server-a:actor-b"),
      ).toBe(true);
      expect(state.get("notification-count:server-a:actor-a")).toBe(4);
      expect(state.get("notification-count:server-a")).toBe(99);
      expect(set).toHaveBeenLastCalledWith(
        "notification-count:server-a:actor-b",
        7,
      );
      account$.setValue(null);
      count.eventBus.emit(AccountChanged, null);
      expect(count.count$.value).toBe(0);
      expect(gql).toHaveBeenCalledTimes(2);
    },
  );

  test.each(["single"])(
    "restores only the unchanged badge after pending %s-read fails following feed disposal",
    async (mode) => {
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const store = {
        listNotification: vi.fn().mockResolvedValue(page([unread], 3)),
        readNotification: vi.fn(() => pending),
        readAllNotifications: vi.fn(() => pending),
      };
      const count = {
        revision: 0,
        count$: { value: 0 },
        setCount: vi.fn((value: number) => {
          count.count$.value = value;
          count.revision += 1;
        }),
      };
      const service = createService(store, count);
      const feed = service.createFeed({ includeRead: false });
      await feed.initialize();
      const failure = expect(
        mode === "single"
          ? feed.readNotification(unread.id)
          : feed.readAllNotifications(),
      ).rejects.toThrow("read rejected");
      expect(count.count$.value).toBe(mode === "single" ? 2 : 0);
      feed.dispose();
      expect(feed.notifications$.value).toEqual([]);
      reject(new Error("read rejected"));
      await failure;
      expect(count.count$.value).toBe(3);
      expect(count.setCount).toHaveBeenCalledTimes(3);
      expect(feed.notifications$.value).toEqual([]);
      expect(store.listNotification).toHaveBeenCalledTimes(1);
      expect(store.readNotification).toHaveBeenCalledTimes(
        mode === "single" ? 1 : 0,
      );
      expect(store.readAllNotifications).toHaveBeenCalledTimes(
        mode === "all" ? 1 : 0,
      );
    },
  );
});
