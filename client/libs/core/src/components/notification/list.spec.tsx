// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  type Notification,
  NotificationService,
  NotificationType,
} from "@myoxus/core/modules/notification";
import { WorkspaceListService } from "@myoxus/core/modules/workspace";
import { DashboardNotificationSection } from "@myoxus/core/desktop/pages/workspace/home/notification-views";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { NotificationList } from "./list";

afterEach(cleanup);

const jumpToPageComment = vi.hoisted(() => vi.fn());
const jumpToPageBlock = vi.hoisted(() => vi.fn());
const jumpToDatabaseRow = vi.hoisted(() => vi.fn());
const readNotification = vi.hoisted(() => vi.fn(async () => undefined));

const notification = {
  id: "notification-1",
  type: NotificationType.DatabaseRowReminder,
  level: "Default",
  body: {
    workspaceId: "workspace-1",
    databaseId: "database-1",
    rowId: "row-1",
    state: "Available",
    targetKind: "Task",
    rowTitle: "Current release",
    fieldId: "date-field",
    allDay: false,
    timeZone: "UTC",
    fieldName: "Due",
    scheduledFor: "2026-07-11T09:00:00Z",
  },
  createdAt: "2026-07-11T08:00:00Z",
  updatedAt: "2026-07-11T08:00:00Z",
  read: false,
} as unknown as Notification;

const feed = {
  notifications$: { value: [notification] as Notification[] },
  isLoading$: { value: false },
  error$: { value: null },
  hasMore$: { value: false },
  retain: vi.fn(() => vi.fn()),
  initialize: vi.fn(async () => undefined),
  refresh: vi.fn(),
  loadMore: vi.fn(),
  readNotification,
  readAllNotifications: vi.fn(async () => undefined),
  dispose: vi.fn(),
};
const notificationService = {
  createFeed: vi.fn(() => feed),
  documentTargetExists: vi.fn(async () => true),
};
const workspaceListService = {
  list: {
    workspaces$: {
      value: [{ id: "workspace-1", name: "Alpha workspace" }],
    },
  },
};

vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async () => {
    const { formatRegionalDate, formatRegionalDateTime } =
      await import("@myoxus/core/modules/i18n/regional-format");
    const preferences = {
      locale: "en-US",
      timezone: "UTC",
      dateFormat: "locale" as const,
      timeFormat: "12-hour" as const,
    };
    return {
      useRegionalFormatters: () => ({
        formatDate: (value: string) => formatRegionalDate(value, preferences),
        formatDateTime: (value: string) =>
          formatRegionalDateTime(value, preferences),
        preferences,
      }),
    };
  },
);

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: (source: { value: unknown }) => source.value,
    useService: (service: unknown) => {
      if (service === NotificationService) return notificationService;
      if (service === WorkspaceListService) return workspaceListService;
      throw new Error(
        `Unexpected notification test service: ${String(service)}`,
      );
    },
  };
});

vi.mock("../hooks/use-navigate-helper", () => ({
  useNavigateHelper: () => ({
    jumpToDatabaseRow,
    jumpToPageComment,
    jumpToPageBlock,
  }),
}));

vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/i18n")>();
  const { createDatabaseTestI18nModule } =
    await import("../../modules/database/test-i18n-mock");
  return { ...actual, ...createDatabaseTestI18nModule() };
});

describe("Database Row reminder notifications", () => {
  afterEach(() => {
    feed.notifications$.value = [notification];
    vi.clearAllMocks();
  });

  test.each([
    {
      name: "date-only Berlin",
      allDay: true,
      state: "Available",
      expected: "Oct 18, 2026",
    },
    {
      name: "timed offset",
      allDay: false,
      state: "Available",
      expected: "Oct 17, 2026, 10:00 PM",
    },
  ])(
    "uses the current Feed date projection for $name",
    ({ allDay, state, expected }) => {
      feed.notifications$.value = [
        {
          ...notification,
          body: {
            ...notification.body,
            state,
            fieldId: state === "Available" ? "date-field" : null,
            targetKind: state === "Available" ? "Task" : null,
            rowTitle: state === "Available" ? "Current release" : null,
            fieldName: state === "Available" ? "Due" : null,
            allDay,
            timeZone: state === "Available" ? "Europe/Berlin" : null,
            scheduledFor:
              state === "Available" ? "2026-10-18T00:00:00+02:00" : null,
          },
        },
      ];
      render(
        <MyoxusUIProvider>
          <NotificationList />
        </MyoxusUIProvider>,
      );
      if (expected) {
        expect(screen.getByText(expected).textContent).toBe(expected);
        fireEvent.click(screen.getByText(/Current release/));
        expect(jumpToDatabaseRow).toHaveBeenCalledWith(
          "workspace-1",
          "database-1",
          "row-1",
        );
        expect(readNotification).toHaveBeenCalledWith("notification-1");
      } else {
        fireEvent.click(
          screen.getByText("This reminder target is no longer available."),
        );
        expect(screen.queryByText(/Current release/)).toBeNull();
        expect(jumpToDatabaseRow).not.toHaveBeenCalled();
        expect(readNotification).not.toHaveBeenCalled();
      }
    },
  );

  test.each(["Unavailable"])(
    "redacts a warm Reminder card after current %s projection without a cached Row fallback",
    (state) => {
      const surface = () => (
        <MyoxusUIProvider>
          <NotificationList />
        </MyoxusUIProvider>
      );
      const rendered = render(surface());
      expect(screen.getByText(/Current release/).textContent).toContain("Due");
      feed.notifications$.value = [
        {
          ...notification,
          body: {
            ...notification.body,
            state,
            targetKind: null,
            rowTitle: null,
            fieldName: null,
            scheduledFor: null,
            allDay: null,
            timeZone: null,
          },
        },
      ];
      rendered.rerender(surface());
      expect(screen.queryByText(/Current release/)).toBeNull();
      expect(screen.queryByText(/Due/)).toBeNull();
      expect(screen.queryByText("Jul 11, 2026, 09:00 AM")).toBeNull();
      fireEvent.click(
        screen.getByText("This reminder target is no longer available."),
      );
      expect(jumpToDatabaseRow).not.toHaveBeenCalled();
      expect(readNotification).not.toHaveBeenCalled();
    },
  );

  test("uses the server-validated Row title and opens the shared Database deep link", () => {
    render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );

    const message = screen.getByText(/Current release/);
    expect(screen.queryByText(/Stale private title/)).toBeNull();
    fireEvent.click(message);
    expect(readNotification).toHaveBeenCalledWith("notification-1");
    expect(jumpToDatabaseRow).toHaveBeenCalledWith(
      "workspace-1",
      "database-1",
      "row-1",
    );
  });

  test("does not leak the payload title when the target is deleted or inaccessible", () => {
    feed.notifications$.value = [
      {
        ...notification,
        body: {
          ...notification.body,
          state: "Unavailable",
          rowTitle: "Stale private title",
          fieldName: "Secret field",
        },
      },
    ];
    render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByText("This reminder target is no longer available."),
    ).toBeTruthy();
    expect(screen.queryByText(/Stale private title/)).toBeNull();
    fireEvent.click(
      screen.getByText("This reminder target is no longer available."),
    );
    expect(readNotification).not.toHaveBeenCalled();
    expect(jumpToDatabaseRow).not.toHaveBeenCalled();
  });

  test("does not offer a redundant read action for history entries", () => {
    feed.notifications$.value = [{ ...notification, read: true }];

    const { container } = render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );

    expect(
      container.querySelector(
        '[data-myoxus-ui-role="button:notification-panel-read"]',
      ),
    ).toBeNull();
  });

  test("adds resolved workspace context for embedded account-wide feeds", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <NotificationList
          feed={feed as never}
          limit={6}
          mode="embedded"
          showHeader={false}
          showWorkspaceContext
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Alpha workspace")).toBeTruthy();
    expect(
      container.querySelector(
        '[data-myoxus-ui-role="notification-panel-scroll-root"]',
      ),
    ).toBeNull();
  });
});

describe("native Database assignment notifications", () => {
  const assignment = {
    workspaceId: "d5e2d8bf-c0f4-45e6-a776-0ff6a4768b08",
    databaseId: "75af766d-281d-4d3a-9f29-13778a9768c4",
    rowId: "510ee81c-7fa4-4dcb-88f1-414ff777ff39",
    state: "Available",
    targetKind: "Task",
    rowTitle: "Current authorized release",
  };
  afterEach(() => {
    feed.notifications$.value = [notification];
    vi.clearAllMocks();
  });

  test.each([
    { ...assignment, state: "Unavailable", rowTitle: "Stale private title" },
  ])(
    "redacts unavailable, trashed or malformed assignment targets %#",
    (body) => {
      feed.notifications$.value = [
        {
          ...notification,
          type: NotificationType.DatabaseRowAssigned,
          body,
        } as Notification,
      ];
      render(
        <MyoxusUIProvider>
          <NotificationList />
        </MyoxusUIProvider>,
      );
      expect(screen.getByText("Target unavailable").textContent).toBe(
        "Target unavailable",
      );
      expect(
        screen.queryByText(/Stale private title|Current authorized release/),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Open task" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Open details" })).toBeNull();
      fireEvent.click(screen.getByText("Target unavailable"));
      expect(jumpToDatabaseRow).not.toHaveBeenCalled();
      expect(readNotification).not.toHaveBeenCalled();
    },
  );

  test("Home Activity requests native assignments and renders their canonical Open Task action", () => {
    const assigned = {
      ...notification,
      type: NotificationType.DatabaseRowAssigned,
      body: assignment,
    };
    notificationService.createFeed.mockImplementationOnce(
      (...args: unknown[]) => {
        const filter = args[0] as { types?: NotificationType[] };
        // The actual feed's server filter must admit this event before the shared
        // Inbox renderer can expose it in the Home Activity preview.
        feed.notifications$.value = filter.types?.includes(
          NotificationType.DatabaseRowAssigned,
        )
          ? [assigned]
          : [];
        return feed;
      },
    );
    render(
      <MyoxusUIProvider>
        <DashboardNotificationSection kind="activity" onOpenInbox={vi.fn()} />
      </MyoxusUIProvider>,
    );
    expect(
      screen.getByText(
        "You were assigned to the task “Current authorized release”.",
      ).textContent,
    ).toContain("Current authorized release");
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(jumpToDatabaseRow).toHaveBeenCalledExactlyOnceWith(
      assignment.workspaceId,
      assignment.databaseId,
      assignment.rowId,
    );
    expect(readNotification).toHaveBeenCalledExactlyOnceWith(notification.id);
  });

  test("never infers an assignment from a General notification's assignment-shaped body", () => {
    feed.notifications$.value = [
      { ...notification, type: NotificationType.General, body: assignment },
    ];
    render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );
    expect(screen.getByText("Unsupported message").textContent).toBe(
      "Unsupported message",
    );
    expect(screen.queryByText(/Current authorized release/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open task" })).toBeNull();
    expect(jumpToDatabaseRow).not.toHaveBeenCalled();
  });
});

describe("Workspace content move notifications", () => {
  afterEach(() => {
    feed.notifications$.value = [notification];
    vi.clearAllMocks();
  });

  test("renders the server-projected aggregate without target metadata", () => {
    feed.notifications$.value = [
      {
        ...notification,
        type: NotificationType.WorkspaceContentMoved,
        body: {
          resourceCount: 3,
          resourceKinds: ["Document", "Database"],
          targetWorkspaceName: "Private target name",
        },
      } as unknown as Notification,
    ];

    render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByText(/Moved content: 3.*Documents, Databases/),
    ).not.toBeNull();
    expect(screen.queryByText(/Private target name/)).toBeNull();
  });

  test("keeps legacy or redacted payloads useful without an unsafe action", () => {
    feed.notifications$.value = [
      {
        ...notification,
        type: NotificationType.WorkspaceContentMoved,
        body: {},
      } as unknown as Notification,
    ];

    const { container } = render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByText("Content was moved to another workspace."),
    ).not.toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("Canonical comment notification targets", () => {
  afterEach(() => {
    feed.notifications$.value = [notification];
    vi.clearAllMocks();
  });

  test.each([NotificationType.CommentMention])(
    "%s opens the projected document key and comment, then reads the row",
    async (type) => {
      feed.notifications$.value = [
        {
          ...notification,
          type,
          body: {
            workspaceId: "workspace-1",
            commentId: "comment-1",
            docId: "private-internal-id",
            doc: {
              id: "projected-external-key",
              mode: "page",
              title: "Comment target",
            },
            createdByUser: { name: "Comment author" },
          },
        } as unknown as Notification,
      ];
      const { container } = render(
        <MyoxusUIProvider>
          <NotificationList />
        </MyoxusUIProvider>,
      );
      // The native row is the consuming action, independent of localized text.
      const row = container.querySelector(
        '[data-myoxus-ui-role="notification-panel-item"]',
      );
      expect(row).not.toBeNull();
      fireEvent.click(row!);
      await waitFor(() =>
        expect(jumpToPageComment).toHaveBeenCalledWith(
          "workspace-1",
          "projected-external-key",
          "comment-1",
          "page",
        ),
      );
      expect(readNotification).toHaveBeenCalledWith("notification-1");
    },
  );

  test("an unavailable comment target has no navigation or private details", () => {
    feed.notifications$.value = [
      {
        ...notification,
        type: NotificationType.CommentMention,
        body: {
          workspaceId: "workspace-1",
          commentId: "comment-1",
          doc: null,
          createdByUser: null,
        },
      } as unknown as Notification,
    ];
    const { container } = render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );
    expect(container.querySelector("a")).toBeNull();
    fireEvent.click(
      container.querySelector(
        '[data-myoxus-ui-role="notification-panel-item"]',
      )!,
    );
    expect(jumpToPageComment).not.toHaveBeenCalled();
  });
});

describe("Document change notifications", () => {
  afterEach(() => {
    feed.notifications$.value = [notification];
    vi.clearAllMocks();
  });

  const change = (body: unknown): Notification =>
    ({
      ...notification,
      type: NotificationType.DocumentChanged,
      body,
    }) as Notification;

  test("shows the latest actor and other actor count and opens the resolved document", async () => {
    feed.notifications$.value = [
      change({
        workspaceId: "workspace-1",
        doc: { id: "external-key", title: "Current title", mode: "page" },
        createdByUser: { name: "Alice" },
        otherActorCount: 2,
      }),
    ];
    render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );
    expect(screen.getByText(/2 other people/).textContent).toContain(
      "2 other people",
    );
    expect(screen.getByText("Alice").textContent).toBe("Alice");
    fireEvent.click(screen.getByText("Current title"));
    await waitFor(() =>
      expect(jumpToPageBlock).toHaveBeenCalledWith(
        "workspace-1",
        "external-key",
        "page",
        undefined,
        undefined,
      ),
    );
    expect(readNotification).toHaveBeenCalledWith("notification-1");
  });

  test("shows generic unavailable copy without a stale actor, title or opening action", () => {
    feed.notifications$.value = [
      change({
        workspaceId: "workspace-1",
        doc: null,
        createdByUser: { name: "Stale actor" },
        title: "Stale title",
      }),
    ];
    render(
      <MyoxusUIProvider>
        <NotificationList />
      </MyoxusUIProvider>,
    );
    const message = screen.getByText(
      "This document update is no longer available.",
    );
    expect(screen.queryByText(/Stale/)).toBeNull();
    fireEvent.click(message);
    expect(jumpToPageBlock).not.toHaveBeenCalled();
    expect(readNotification).not.toHaveBeenCalled();
  });
});

describe("explicit Task change notifications", () => {
  const body = {
    workspaceId: "d5e2d8bf-c0f4-45e6-a776-0ff6a4768b08",
    databaseId: "75af766d-281d-4d3a-9f29-13778a9768c4",
    rowId: "510ee81c-7fa4-4dcb-88f1-414ff777ff39",
    state: "Available",
    targetKind: "Task",
    rowTitle: "Current watched release",
  };
  afterEach(() => {
    feed.notifications$.value = [notification];
    vi.clearAllMocks();
  });
  test("Home Activity admits the native event and opens/reads the current Task without calling it an assignment", () => {
    const changed = {
      ...notification,
      type: NotificationType.DatabaseTaskChanged,
      body,
    };
    notificationService.createFeed.mockImplementationOnce(
      (...args: unknown[]) => {
        const filter = args[0] as { types?: NotificationType[] };
        feed.notifications$.value = filter.types?.includes(
          NotificationType.DatabaseTaskChanged,
        )
          ? [changed]
          : [];
        return feed;
      },
    );
    render(
      <MyoxusUIProvider>
        <DashboardNotificationSection kind="activity" onOpenInbox={vi.fn()} />
      </MyoxusUIProvider>,
    );
    expect(
      screen.getByText("The task “Current watched release” was updated.")
        .textContent,
    ).toBe("The task “Current watched release” was updated.");
    expect(screen.queryByText(/You were assigned/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(jumpToDatabaseRow).toHaveBeenCalledExactlyOnceWith(
      body.workspaceId,
      body.databaseId,
      body.rowId,
    );
    expect(readNotification).toHaveBeenCalledExactlyOnceWith(notification.id);
  });
});
