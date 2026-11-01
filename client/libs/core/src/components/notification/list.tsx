import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import {
  type Notification,
  type NotificationFeed,
  NotificationService,
  NotificationType,
} from "@myoxus/core/modules/notification";
import { InvitationService } from "@myoxus/core/modules/server";
import {
  WorkspaceListService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { extractEmojiIcon } from "@myoxus/core/utils";
import { UserFriendlyError } from "@myoxus/error";
import { formatRegionalDate } from "@myoxus/core/modules/i18n";
import { i18nTime, Trans, useI18n } from "@myoxus/i18n";
import {
  CalendarClockIcon,
  CheckIcon,
  CollaborationIcon,
  EdgelessIcon,
  MoreHorizontalIcon,
  NotificationIcon,
  PageIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  Avatar,
  Button,
  Group,
  IconButton,
  Menu,
  MenuItem,
  NotificationPanelEmpty,
  NotificationPanelEntity,
  NotificationPanelEntityIcon,
  NotificationPanelError,
  NotificationPanelFooter,
  NotificationPanelGroupTitle,
  NotificationPanelHeader,
  NotificationPanelHeaderTitle,
  NotificationPanelItem as FacadeNotificationPanelItem,
  NotificationPanelItemDate,
  NotificationPanelItemMain,
  NotificationPanelItemMessage,
  NotificationPanelItemSkeleton,
  NotificationPanelLeadingIcon,
  NotificationPanelList,
  NotificationPanelLoadMoreIndicator,
  NotificationPanelReadAction,
  NotificationPanelRoot,
  NotificationPanelScrollRoot,
  NotificationPanelViewport,
  notify,
  observeIntersection,
  Scrollable,
} from "@myoxus/ui-facade";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useNavigateHelper } from "../hooks/use-navigate-helper";

type NotificationUserBody = {
  name?: string | null;
  avatarUrl?: string | null;
};

type NotificationWorkspaceBody = {
  id?: string | null;
  name?: string | null;
};

type NotificationDocBody = {
  id: string;
  mode: "page" | "edgeless";
  title?: string | null;
  blockId?: string | null;
  elementId?: string | null;
};

type MentionNotificationBodyType = {
  otherActorCount?: number;
  createdByUser?: NotificationUserBody | null;
  workspace?: NotificationWorkspaceBody | null;
  workspaceId?: string | null;
  doc?: NotificationDocBody | null;
};

type WorkspaceNotificationBodyType = {
  createdByUser?: NotificationUserBody | null;
  workspace?: NotificationWorkspaceBody | null;
};

type InvitationNotificationBodyType = WorkspaceNotificationBodyType & {
  inviteId: string;
};

type InvitationAcceptedNotificationBodyType = WorkspaceNotificationBodyType;
type InvitationBlockedNotificationBodyType = WorkspaceNotificationBodyType;
type InvitationReviewRequestNotificationBodyType =
  WorkspaceNotificationBodyType;
type InvitationReviewDeclinedNotificationBodyType =
  WorkspaceNotificationBodyType;
type InvitationReviewApprovedNotificationBodyType =
  WorkspaceNotificationBodyType;
type CommentNotificationBodyType = {
  createdByUser?: NotificationUserBody | null;
  workspaceId?: string | null;
  commentId: string;
  doc?: NotificationDocBody | null;
};

type CalendarReminderNotificationBody = {
  event_title?: string;
  starts_at?: string;
};

type WorkspaceContentMovedNotificationBody = {
  resourceCount?: number;
  resourceKinds?: string[];
};

const NotificationFeedContext = createContext<NotificationFeed | null>(null);
const NotificationWorkspaceContext = createContext<{
  namesById: ReadonlyMap<string, string>;
  show: boolean;
}>({
  namesById: new Map(),
  show: false,
});

function useNotificationFeed() {
  const feed = useContext(NotificationFeedContext);
  if (!feed) {
    throw new Error("Notification items require a NotificationFeed provider");
  }
  return feed;
}

type NotificationListProps = {
  emptyDescription?: ReactNode;
  emptyIcon?: ReactNode;
  emptyTitle?: ReactNode;
  feed?: NotificationFeed;
  grouped?: boolean;
  limit?: number;
  mode?: "embedded" | "preview" | "route";
  onOpenInbox?: () => void;
  showHeader?: boolean;
  showWorkspaceContext?: boolean;
};

export const NotificationList = ({
  emptyDescription,
  emptyIcon,
  emptyTitle,
  feed: providedFeed,
  grouped = false,
  limit,
  mode = "preview",
  onOpenInbox,
  showHeader = true,
  showWorkspaceContext = false,
}: NotificationListProps) => {
  const t = useI18n();
  const notificationService = useService(NotificationService);
  const ownedFeed = useMemo(
    () =>
      providedFeed ??
      notificationService.createFeed({
        includeRead: false,
      }),
    [notificationService, providedFeed],
  );
  const notifications = useLiveData(ownedFeed.notifications$);
  const visibleNotifications = useMemo(
    () => (limit == null ? notifications : notifications.slice(0, limit)),
    [limit, notifications],
  );
  const isLoading = useLiveData(ownedFeed.isLoading$);
  const error = useLiveData(ownedFeed.error$);
  const hasMore = useLiveData(ownedFeed.hasMore$);
  const loadMoreIndicatorRef = useRef<HTMLDivElement>(null);
  const { formatDate, preferences } = useRegionalFormatters();
  const workspaceListService = useService(WorkspaceListService);
  const workspaces = useLiveData(workspaceListService.list.workspaces$);
  const workspaceNamesById = useMemo(
    () =>
      new Map(
        workspaces.flatMap((workspace) =>
          workspace.name ? [[workspace.id, workspace.name] as const] : [],
        ),
      ),
    [workspaces],
  );

  const hasError = error != null;

  useLayoutEffect(() => {
    const releaseFeed = ownedFeed.retain();
    void ownedFeed.initialize();
    return releaseFeed;
  }, [ownedFeed]);

  useEffect(() => {
    if (limit == null && loadMoreIndicatorRef.current) {
      let previousIsIntersecting = false;
      return observeIntersection(loadMoreIndicatorRef.current, (entity) => {
        if (entity.isIntersecting && !previousIsIntersecting && hasMore) {
          void ownedFeed.loadMore();
        }
        previousIsIntersecting = entity.isIntersecting;
      });
    }
    return;
  }, [hasMore, limit, ownedFeed]);

  const handleReadAll = useCallback(() => {
    ownedFeed.readAllNotifications().catch((err) => {
      notify.error(UserFriendlyError.fromAny(err));
    });
  }, [ownedFeed]);

  const groups = useMemo(() => {
    if (!grouped)
      return [{ key: "all", label: null, notifications: visibleNotifications }];
    const formatter = new Intl.DateTimeFormat(preferences.locale, {
      day: "2-digit",
      month: "2-digit",
      timeZone: preferences.timezone,
      year: "numeric",
    });
    const now = new Date();
    const today = formatter.format(now);
    const yesterday = formatter.format(
      new Date(now.getTime() - 24 * 60 * 60 * 1000),
    );
    const ordered = new Map<string, Notification[]>();
    for (const notification of visibleNotifications) {
      const date = formatter.format(new Date(notification.createdAt));
      const key =
        date === today ? "today" : date === yesterday ? "yesterday" : date;
      const values = ordered.get(key) ?? [];
      values.push(notification);
      ordered.set(key, values);
    }
    return [...ordered].map(([key, values]) => ({
      key,
      label:
        key === "today"
          ? t["com.myoxus.today"]()
          : key === "yesterday"
            ? t["com.myoxus.yesterday"]()
            : formatDate(values[0].createdAt),
      notifications: values,
    }));
  }, [
    formatDate,
    grouped,
    visibleNotifications,
    preferences.locale,
    preferences.timezone,
    t,
  ]);

  const content =
    visibleNotifications.length > 0 ? (
      <NotificationPanelList
        aria-label={t["com.myoxus.rootAppSidebar.notifications"]()}
      >
        {grouped
          ? groups.map((group) => (
              <li key={group.key}>
                <NotificationPanelGroupTitle>
                  {group.label}
                </NotificationPanelGroupTitle>
                <NotificationPanelList>
                  {group.notifications.map((notification) => (
                    <li key={notification.id}>
                      <NotificationItem notification={notification} />
                    </li>
                  ))}
                </NotificationPanelList>
              </li>
            ))
          : visibleNotifications.map((notification) => (
              <li key={notification.id}>
                <NotificationItem notification={notification} />
              </li>
            ))}
        {hasError ? (
          <li>
            <NotificationFeedError onRetry={() => void ownedFeed.refresh()} />
          </li>
        ) : null}
      </NotificationPanelList>
    ) : isLoading ? (
      <NotificationItemSkeleton />
    ) : hasError ? (
      <NotificationFeedError onRetry={() => void ownedFeed.refresh()} />
    ) : (
      <NotificationListEmpty
        description={emptyDescription}
        icon={emptyIcon}
        title={emptyTitle}
      />
    );

  return (
    <NotificationFeedContext.Provider value={ownedFeed}>
      <NotificationWorkspaceContext.Provider
        value={{
          namesById: workspaceNamesById,
          show: showWorkspaceContext,
        }}
      >
        <NotificationPanelRoot
          mode={mode}
          mobile={BUILD_CONFIG.isMobileEdition}
        >
          {showHeader ? (
            <NotificationPanelHeader>
              <NotificationPanelHeaderTitle>
                {t["com.myoxus.rootAppSidebar.notifications"]()}
              </NotificationPanelHeaderTitle>
              {visibleNotifications.length > 0 ? (
                <Menu
                  items={
                    <MenuItem
                      prefixIcon={<CheckIcon />}
                      onClick={handleReadAll}
                    >
                      {t["com.myoxus.notification.mark-all-read"]()}
                    </MenuItem>
                  }
                >
                  <IconButton
                    aria-label={t["com.myoxus.common.open-menu"]()}
                    icon={<MoreHorizontalIcon />}
                  />
                </Menu>
              ) : null}
            </NotificationPanelHeader>
          ) : null}
          {mode === "embedded" ? (
            content
          ) : (
            <NotificationPanelScrollRoot>
              <NotificationPanelViewport>
                {content}
                <NotificationPanelLoadMoreIndicator ref={loadMoreIndicatorRef}>
                  {hasMore && !hasError && limit == null
                    ? t["com.myoxus.notification.loading-more"]()
                    : null}
                </NotificationPanelLoadMoreIndicator>
              </NotificationPanelViewport>
              <Scrollable.Scrollbar />
            </NotificationPanelScrollRoot>
          )}
          {onOpenInbox ? (
            <NotificationPanelFooter>
              <Button variant="plain" onClick={onOpenInbox}>
                {t["com.myoxus.notification.open-inbox"]()}
              </Button>
            </NotificationPanelFooter>
          ) : null}
        </NotificationPanelRoot>
      </NotificationWorkspaceContext.Provider>
    </NotificationFeedContext.Provider>
  );
};

const NotificationListEmpty = ({
  description,
  icon,
  title,
}: {
  description?: ReactNode;
  icon?: ReactNode;
  title?: ReactNode;
}) => {
  const t = useI18n();
  return (
    <NotificationPanelEmpty
      icon={icon ?? <NotificationIcon />}
      title={title ?? t["com.myoxus.notification.empty"]()}
      description={
        description ?? t["com.myoxus.notification.empty.description"]()
      }
    />
  );
};

function notificationWorkspace(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const candidate = body as {
    workspace?: NotificationWorkspaceBody | null;
    workspaceId?: string | null;
  };
  const id = candidate.workspace?.id ?? candidate.workspaceId;
  if (!id) return null;
  return { id, name: candidate.workspace?.name ?? null };
}

const CurrentNotificationContext = createContext<Notification | null>(null);

/**
 * Adds account-wide workspace context to the shared item renderer without
 * creating a dashboard-specific notification row or per-item lookup.
 */
const NotificationPanelItem = ({
  footer,
  ...props
}: ComponentProps<typeof FacadeNotificationPanelItem>) => {
  const t = useI18n();
  const notification = useContext(CurrentNotificationContext);
  const workspaceContext = useContext(NotificationWorkspaceContext);
  const workspace = notification
    ? notificationWorkspace(notification.body)
    : null;
  const workspaceName = workspace
    ? (workspace.name ?? workspaceContext.namesById.get(workspace.id))
    : null;
  const workspaceFooter =
    workspaceContext.show && workspace ? (
      <NotificationPanelItemDate>
        {workspaceName ?? t["com.myoxus.inactive-workspace"]()}
      </NotificationPanelItemDate>
    ) : null;

  return (
    <FacadeNotificationPanelItem
      {...props}
      footer={footer ?? workspaceFooter}
    />
  );
};

const NotificationItemSkeleton = () => {
  return Array.from({ length: 3 }).map((_, i) => (
    // oxlint-disable-next-line no-array-index-key
    <NotificationPanelItemSkeleton key={i} />
  ));
};

const NotificationFeedError = ({ onRetry }: { onRetry: () => void }) => {
  const t = useI18n();
  return (
    <NotificationPanelError>
      <Group wrap="wrap">
        {t["com.myoxus.notification.load-error"]()}
        <Button variant="plain" onClick={onRetry}>
          {t["Retry"]()}
        </Button>
      </Group>
    </NotificationPanelError>
  );
};

const NotificationItem = ({ notification }: { notification: Notification }) => {
  const type = notification.type;

  if (
    (type === NotificationType.Mention ||
      type === NotificationType.DocumentChanged) &&
    !hasDocumentTarget(notification.body)
  ) {
    return (
      <CurrentNotificationContext.Provider value={notification}>
        <UnavailableNotificationItem notification={notification} />
      </CurrentNotificationContext.Provider>
    );
  }
  if (
    (type === NotificationType.Comment ||
      type === NotificationType.CommentMention ||
      type === NotificationType.CommentReply) &&
    !hasCommentTarget(notification.body)
  ) {
    return (
      <CurrentNotificationContext.Provider value={notification}>
        <UnavailableNotificationItem notification={notification} />
      </CurrentNotificationContext.Provider>
    );
  }

  return (
    <CurrentNotificationContext.Provider value={notification}>
      {type === NotificationType.Mention ||
      type === NotificationType.DocumentChanged ? (
        <MentionNotificationItem notification={notification} />
      ) : type === NotificationType.Comment ||
        type === NotificationType.CommentMention ||
        type === NotificationType.CommentReply ? (
        <CommentNotificationItem notification={notification} />
      ) : type === NotificationType.InvitationAccepted ? (
        <InvitationAcceptedNotificationItem notification={notification} />
      ) : type === NotificationType.Invitation ? (
        <InvitationNotificationItem notification={notification} />
      ) : type === NotificationType.InvitationBlocked ? (
        <InvitationBlockedNotificationItem notification={notification} />
      ) : type === NotificationType.MemberApproval ? (
        <InvitationReviewRequestNotificationItem notification={notification} />
      ) : type === NotificationType.MemberApprovalDeclined ? (
        <InvitationReviewDeclinedNotificationItem notification={notification} />
      ) : type === NotificationType.MemberApproved ? (
        <InvitationReviewApprovedNotificationItem notification={notification} />
      ) : type === NotificationType.DatabaseTaskChanged ? (
        <DatabaseRowUpdateNotificationItem
          notification={notification}
          changed
        />
      ) : type === NotificationType.DatabaseRowAssigned ? (
        <DatabaseRowUpdateNotificationItem notification={notification} />
      ) : type === NotificationType.DatabaseRowReminder ? (
        <DatabaseRowReminderNotificationItem notification={notification} />
      ) : type === NotificationType.CalendarReminder ? (
        <CalendarReminderNotificationItem notification={notification} />
      ) : type === NotificationType.WorkspaceContentMoved ? (
        <WorkspaceContentMovedNotificationItem notification={notification} />
      ) : (
        <UnavailableNotificationItem notification={notification} />
      )}
    </CurrentNotificationContext.Provider>
  );
};

function hasDocumentTarget(body: unknown): body is MentionNotificationBodyType {
  if (!body || typeof body !== "object") return false;
  const candidate = body as MentionNotificationBodyType;
  return Boolean(
    (candidate.workspace?.id || candidate.workspaceId) &&
    candidate.doc?.id &&
    (candidate.doc.mode === "page" || candidate.doc.mode === "edgeless"),
  );
}

function hasCommentTarget(body: unknown): body is CommentNotificationBodyType {
  if (!body || typeof body !== "object") return false;
  const candidate = body as CommentNotificationBodyType;
  return Boolean(
    candidate.workspaceId &&
    candidate.commentId &&
    candidate.doc?.id &&
    (candidate.doc.mode === "page" || candidate.doc.mode === "edgeless"),
  );
}

const UnavailableNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const t = useI18n();
  return (
    <NotificationPanelItem>
      <Avatar size="xs" />
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          {notification.type === NotificationType.DocumentChanged
            ? t["com.myoxus.notification.document-change-unavailable"]()
            : t["com.myoxus.notification.unsupported"]()}
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, { relative: true })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

/**
 * XWS notifications intentionally contain no target names or resource IDs.
 * The count/type summary remains useful without triggering unauthorized
 * resource lookups or trusting persisted display metadata.
 */
const WorkspaceContentMovedNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const t = useI18n();
  const body = notification.body as WorkspaceContentMovedNotificationBody;
  const count =
    Number.isInteger(body.resourceCount) && (body.resourceCount ?? 0) > 0
      ? body.resourceCount
      : null;
  const kinds = Array.isArray(body.resourceKinds)
    ? body.resourceKinds.filter(
        (kind): kind is string => typeof kind === "string",
      )
    : [];
  const projectedKinds = kinds
    .map((kind) => workspaceContentKindLabel(t, kind))
    .filter(Boolean)
    .join(", ");

  return (
    <NotificationPanelItem>
      <NotificationPanelLeadingIcon>
        <NotificationIcon />
      </NotificationPanelLeadingIcon>
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          {count
            ? projectedKinds
              ? t["com.myoxus.workspace-content-operation.notification.count"]({
                  count: count.toString(),
                  kinds: projectedKinds,
                })
              : t[
                  "com.myoxus.workspace-content-operation.notification.count-only"
                ]({
                  count: count.toString(),
                })
            : t[
                "com.myoxus.workspace-content-operation.notification.generic"
              ]()}
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, { relative: true })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

function workspaceContentKindLabel(
  t: ReturnType<typeof useI18n>,
  kind: string,
) {
  switch (kind) {
    case "document":
    case "Document":
      return t["com.myoxus.workspace-content-operation.kind.document"]();
    case "database":
    case "Database":
      return t["com.myoxus.workspace-content-operation.kind.database"]();
    case "collection":
    case "Collection":
      return t["com.myoxus.workspace-content-operation.kind.collection"]();
    case "folder":
    case "Folder":
      return t["com.myoxus.workspace-content-operation.kind.folder"]();
    case "tag":
    case "Tag":
      return t["com.myoxus.workspace-content-operation.kind.tag"]();
    case "blob":
    case "Blob":
      return t["com.myoxus.workspace-content-operation.kind.file"]();
    default:
      return "";
  }
}

const CalendarReminderNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const t = useI18n();
  const { formatDateTime } = useRegionalFormatters();
  const body = notification.body as CalendarReminderNotificationBody;
  const eventTitle =
    typeof body.event_title === "string" && body.event_title.trim()
      ? body.event_title
      : t["com.myoxus.integration.calendar.untitled-event"]();
  const startsAt =
    typeof body.starts_at === "string" && body.starts_at
      ? formatDateTime(body.starts_at)
      : i18nTime(notification.createdAt, { relative: true });

  return (
    <NotificationPanelItem>
      <NotificationPanelLeadingIcon>
        <CalendarClockIcon />
      </NotificationPanelLeadingIcon>
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          {eventTitle}
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>{startsAt}</NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

/** The native feed projects current authorization. Historical payload titles and
 * field names are never a fallback, and General never implies assignment. */
const DatabaseRowUpdateNotificationItem = ({
  notification,
  changed = false,
}: {
  notification: Notification;
  changed?: boolean;
}) => {
  const t = useI18n();
  const notificationFeed = useNotificationFeed();
  const { jumpToDatabaseRow } = useNavigateHelper();
  const body =
    notification.body &&
    typeof notification.body === "object" &&
    !Array.isArray(notification.body)
      ? (notification.body as Record<string, unknown>)
      : null;
  const target =
    body?.state === "Available" &&
    (body.targetKind === "Task" ||
      (!changed && body.targetKind === "DatabaseRow")) &&
    typeof body.workspaceId === "string" &&
    body.workspaceId.trim() !== "" &&
    typeof body.databaseId === "string" &&
    body.databaseId.trim() !== "" &&
    typeof body.rowId === "string" &&
    body.rowId.trim() !== "" &&
    typeof body.rowTitle === "string"
      ? {
          workspaceId: body.workspaceId,
          databaseId: body.databaseId,
          rowId: body.rowId,
          kind: body.targetKind,
          title: body.rowTitle,
        }
      : null;
  const handleClick = () => {
    if (!target) return;
    jumpToDatabaseRow(target.workspaceId, target.databaseId, target.rowId);
    notificationFeed.readNotification(notification.id).catch((error) => {
      notify.error(UserFriendlyError.fromAny(error));
    });
  };
  return (
    <NotificationPanelItem
      onClick={target ? handleClick : undefined}
      aria-label={
        target
          ? target.kind === "Task"
            ? t["com.myoxus.database.tasks.open-task"]()
            : t["com.myoxus.database.row.open-details"]()
          : undefined
      }
    >
      <NotificationPanelLeadingIcon>
        <NotificationIcon />
      </NotificationPanelLeadingIcon>
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          {target
            ? changed
              ? t["com.myoxus.notification.database-task-changed"]({
                  title: target.title,
                })
              : target.kind === "Task"
                ? t["com.myoxus.notification.database-row-assigned.task"]({
                    title: target.title,
                  })
                : t["com.myoxus.notification.database-row-assigned.row"]({
                    title: target.title,
                  })
            : t["com.myoxus.reference.target-unavailable"]()}
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, { relative: true })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const DatabaseRowReminderNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const t = useI18n();
  const { formatDateTime, preferences } = useRegionalFormatters();
  const notificationFeed = useNotificationFeed();
  const { jumpToDatabaseRow } = useNavigateHelper();
  const body =
    notification.body &&
    typeof notification.body === "object" &&
    !Array.isArray(notification.body)
      ? (notification.body as Record<string, unknown>)
      : null;
  // This is the current authorized Feed projection, never a historical payload
  // or a second globally cached Row read. Feed disposal owns actor changes.
  const target =
    body?.state === "Available" &&
    (body.targetKind === "Task" || body.targetKind === "DatabaseRow") &&
    typeof body.workspaceId === "string" &&
    body.workspaceId.trim() &&
    typeof body.databaseId === "string" &&
    body.databaseId.trim() &&
    typeof body.rowId === "string" &&
    body.rowId.trim() &&
    typeof body.fieldId === "string" &&
    body.fieldId.trim() &&
    typeof body.rowTitle === "string" &&
    typeof body.fieldName === "string" &&
    typeof body.scheduledFor === "string" &&
    Number.isFinite(Date.parse(body.scheduledFor)) &&
    typeof body.allDay === "boolean" &&
    (typeof body.timeZone === "string" || body.timeZone === null)
      ? {
          workspaceId: body.workspaceId,
          databaseId: body.databaseId,
          rowId: body.rowId,
          rowTitle: body.rowTitle,
          fieldName: body.fieldName,
          scheduledFor: body.scheduledFor,
          allDay: body.allDay,
          timeZone: body.timeZone,
          kind: body.targetKind,
        }
      : null;
  const handleClick = () => {
    if (!target) return;
    jumpToDatabaseRow(target.workspaceId, target.databaseId, target.rowId);
    notificationFeed.readNotification(notification.id).catch((error) => {
      notify.error(UserFriendlyError.fromAny(error));
    });
  };
  // Date-only values preserve their canonical Cell calendar day. Null timezone
  // has the same UTC meaning as the existing native DateTime editor.
  const reminderDate = target
    ? target.allDay
      ? formatRegionalDate(target.scheduledFor, {
          ...preferences,
          timezone: target.timeZone || "UTC",
        })
      : formatDateTime(target.scheduledFor)
    : null;
  return (
    <NotificationPanelItem
      onClick={target ? handleClick : undefined}
      aria-label={
        target
          ? target.kind === "Task"
            ? t["com.myoxus.database.tasks.open-task"]()
            : t["com.myoxus.database.row.open-details"]()
          : undefined
      }
    >
      <NotificationPanelLeadingIcon>
        <NotificationIcon />
      </NotificationPanelLeadingIcon>
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          {target
            ? t["com.myoxus.database.reminder.notification"]({
                rowTitle: target.rowTitle,
                fieldName: target.fieldName,
              })
            : t["com.myoxus.database.reminder.notification-unavailable"]()}
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {target && reminderDate
            ? reminderDate
            : i18nTime(notification.createdAt, { relative: true })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const MentionNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const notificationFeed = useNotificationFeed();
  const notificationService = useService(NotificationService);
  const { jumpToPageBlock } = useNavigateHelper();
  const t = useI18n();
  const body = notification.body as MentionNotificationBodyType;
  const memberInactived = !body.createdByUser;
  const documentChanged =
    notification.type === NotificationType.DocumentChanged;
  const otherActorCount = body.otherActorCount ?? 0;
  const messageKey = documentChanged
    ? otherActorCount > 0
      ? "com.myoxus.notification.document-changed-many"
      : "com.myoxus.notification.document-changed"
    : "com.myoxus.notification.mention";
  const workspaceId = body.workspace?.id ?? body.workspaceId;
  const [targetError, setTargetError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    track.$.sidebar.notifications.clickNotification({
      type: notification.type,
      item: "read",
    });
    if (!workspaceId) {
      return;
    }
    setTargetError(null);
    try {
      const targetExists = await notificationService.documentTargetExists(
        workspaceId,
        body.doc!.id,
      );
      if (!targetExists) {
        setTargetError(t["com.myoxus.workbench.route.not-found.description"]());
        return;
      }
    } catch (error) {
      setTargetError(UserFriendlyError.fromAny(error).message);
      return;
    }
    jumpToPageBlock(
      workspaceId,
      body.doc!.id,
      body.doc!.mode,
      body.doc!.blockId ? [body.doc!.blockId] : undefined,
      body.doc!.elementId ? [body.doc!.elementId] : undefined,
    );
    notificationFeed.readNotification(notification.id).catch((err) => {
      notify.error(UserFriendlyError.fromAny(err));
    });
  }, [
    body,
    jumpToPageBlock,
    notificationFeed,
    notification,
    notificationService,
    t,
    workspaceId,
  ]);

  return (
    <NotificationPanelItem onClick={handleClick}>
      <Avatar
        size="xs"
        name={body.createdByUser?.name ?? undefined}
        url={body.createdByUser?.avatarUrl ?? undefined}
      />
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          <Trans
            i18nKey={messageKey}
            count={documentChanged ? otherActorCount : undefined}
            components={{
              1: <NotificationPanelEntity inactive={memberInactived} />,
              2: <DocNameWithIcon mode={body.doc!.mode} />,
            }}
            values={{
              count: otherActorCount,
              username:
                body.createdByUser?.name ?? t["com.myoxus.inactive-member"](),
              docTitle: body.doc!.title || t["Untitled"](),
            }}
          />
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, {
            relative: true,
          })}
        </NotificationPanelItemDate>
        {targetError ? (
          <NotificationPanelError>{targetError}</NotificationPanelError>
        ) : null}
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const InvitationReviewRequestNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const notificationFeed = useNotificationFeed();
  const { jumpToWorkspaceSettings } = useNavigateHelper();
  const t = useI18n();
  const body = notification.body as InvitationReviewRequestNotificationBodyType;
  const memberInactived = !body.createdByUser;
  const workspaceInactived = !body.workspace;
  const handleClick = useCallback(() => {
    track.$.sidebar.notifications.clickNotification({
      type: notification.type,
      item: "read",
    });
    if (!body.workspace?.id) {
      return;
    }
    jumpToWorkspaceSettings(body.workspace.id, "workspace:members");
    notificationFeed.readNotification(notification.id).catch((err) => {
      notify.error(UserFriendlyError.fromAny(err));
    });
  }, [body, jumpToWorkspaceSettings, notification, notificationFeed]);

  return (
    <NotificationPanelItem onClick={handleClick}>
      <Avatar
        size="xs"
        name={body.createdByUser?.name ?? undefined}
        url={body.createdByUser?.avatarUrl ?? undefined}
      />
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          <Trans
            i18nKey={"com.myoxus.notification.invitation-review-request"}
            components={{
              1: <NotificationPanelEntity inactive={memberInactived} />,
              2: <WorkspaceNameWithIcon data-inactived={workspaceInactived} />,
            }}
            values={{
              username:
                body.createdByUser?.name ?? t["com.myoxus.inactive-member"](),
              workspaceName:
                body.workspace?.name ?? t["com.myoxus.inactive-workspace"](),
            }}
          />
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, {
            relative: true,
          })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const InvitationReviewDeclinedNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const t = useI18n();
  const body =
    notification.body as InvitationReviewDeclinedNotificationBodyType;
  const memberInactived = !body.createdByUser;
  const workspaceInactived = !body.workspace;

  return (
    <NotificationPanelItem>
      <Avatar
        size="xs"
        name={body.createdByUser?.name ?? undefined}
        url={body.createdByUser?.avatarUrl ?? undefined}
      />
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          <Trans
            i18nKey={"com.myoxus.notification.invitation-review-declined"}
            components={{
              1: <NotificationPanelEntity inactive={memberInactived} />,
              2: <WorkspaceNameWithIcon data-inactived={workspaceInactived} />,
            }}
            values={{
              username:
                body.createdByUser?.name ?? t["com.myoxus.inactive-member"](),
              workspaceName:
                body.workspace?.name ?? t["com.myoxus.inactive-workspace"](),
            }}
          />
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, {
            relative: true,
          })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const InvitationReviewApprovedNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const notificationFeed = useNotificationFeed();
  const { jumpToPage } = useNavigateHelper();
  const t = useI18n();
  const body =
    notification.body as InvitationReviewApprovedNotificationBodyType;
  const memberInactived = !body.createdByUser;
  const workspaceInactived = !body.workspace;

  const handleClick = useCallback(() => {
    track.$.sidebar.notifications.clickNotification({
      type: notification.type,
      item: "button",
      button: "open",
    });
    if (!body.workspace?.id) {
      return;
    }
    jumpToPage(body.workspace.id, "home");
    notificationFeed.readNotification(notification.id).catch((err) => {
      notify.error(UserFriendlyError.fromAny(err));
    });
  }, [body, jumpToPage, notification, notificationFeed]);

  return (
    <NotificationPanelItem>
      <Avatar
        size="xs"
        name={body.createdByUser?.name ?? undefined}
        url={body.createdByUser?.avatarUrl ?? undefined}
      />
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          <Trans
            i18nKey={"com.myoxus.notification.invitation-review-approved"}
            components={{
              1: <NotificationPanelEntity inactive={memberInactived} />,
              2: <WorkspaceNameWithIcon data-inactived={workspaceInactived} />,
            }}
            values={{
              username:
                body.createdByUser?.name ?? t["com.myoxus.inactive-member"](),
              workspaceName:
                body.workspace?.name ?? t["com.myoxus.inactive-workspace"](),
            }}
          />
        </NotificationPanelItemMessage>
        {!workspaceInactived && (
          <Button variant="secondary" onClick={handleClick}>
            {t[
              "com.myoxus.notification.invitation-review-approved.open-workspace"
            ]()}
          </Button>
        )}
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, {
            relative: true,
          })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const InvitationAcceptedNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const notificationFeed = useNotificationFeed();
  const { jumpToWorkspaceSettings } = useNavigateHelper();
  const t = useI18n();
  const body = notification.body as InvitationAcceptedNotificationBodyType;
  const memberInactived = !body.createdByUser;

  const handleClick = useCallback(() => {
    track.$.sidebar.notifications.clickNotification({
      type: notification.type,
      item: "read",
    });
    if (!body.workspace?.id) {
      return;
    }
    jumpToWorkspaceSettings(body.workspace.id, "workspace:members");
    notificationFeed.readNotification(notification.id).catch((err) => {
      notify.error(UserFriendlyError.fromAny(err));
    });
  }, [body, jumpToWorkspaceSettings, notification, notificationFeed]);

  return (
    <NotificationPanelItem onClick={handleClick}>
      <Avatar
        size="xs"
        name={body.createdByUser?.name ?? undefined}
        url={body.createdByUser?.avatarUrl ?? undefined}
      />
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          <Trans
            i18nKey={"com.myoxus.notification.invitation-accepted"}
            components={{
              1: <WorkspaceNameWithIcon data-inactived={memberInactived} />,
            }}
            values={{
              username:
                body.createdByUser?.name ?? t["com.myoxus.inactive-member"](),
            }}
          />
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, {
            relative: true,
          })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const InvitationBlockedNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const notificationFeed = useNotificationFeed();
  const { jumpToWorkspaceSettings } = useNavigateHelper();
  const t = useI18n();
  const body = notification.body as InvitationBlockedNotificationBodyType;
  const workspaceInactived = !body.workspace;

  const handleClick = useCallback(() => {
    track.$.sidebar.notifications.clickNotification({
      type: notification.type,
      item: "read",
    });
    if (!body.workspace?.id) {
      return;
    }
    jumpToWorkspaceSettings(body.workspace.id, "workspace:members");
    notificationFeed.readNotification(notification.id).catch((err) => {
      notify.error(UserFriendlyError.fromAny(err));
    });
  }, [body, jumpToWorkspaceSettings, notification, notificationFeed]);

  return (
    <NotificationPanelItem onClick={handleClick}>
      <NotificationPanelLeadingIcon>
        <CollaborationIcon />
      </NotificationPanelLeadingIcon>
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          <Trans
            i18nKey={"com.myoxus.notification.invitation-blocked"}
            components={{
              1: <NotificationPanelEntity inactive={workspaceInactived} />,
            }}
            values={{
              workspaceName:
                body.workspace?.name ?? t["com.myoxus.inactive-workspace"](),
            }}
          />
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, {
            relative: true,
          })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const InvitationNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const t = useI18n();
  const body = notification.body as InvitationNotificationBodyType;
  const memberInactived = !body.createdByUser;
  const workspaceInactived = !body.workspace;
  const workspacesService = useService(WorkspacesService);
  const invitationService = useService(InvitationService);
  const notificationFeed = useNotificationFeed();
  const inviteId = body.inviteId;
  const workspaceName = body.workspace?.name ?? "";
  const [isAccepting, setIsAccepting] = useState(false);
  // P100-WF-G-04: after accepting, show "Switch to Workspace" dialog inline
  const [acceptedWorkspaceName, setAcceptedWorkspaceName] = useState<
    string | null
  >(null);
  const { jumpToPage } = useNavigateHelper();

  const handleReadAndOpenWorkspace = useCallback(() => {
    if (!body.workspace?.id) {
      return; // should never happen
    }
    jumpToPage(body.workspace.id, "home");
    notificationFeed.readNotification(notification.id).catch((err) => {
      notify.error(UserFriendlyError.fromAny(err));
    });
  }, [body, jumpToPage, notification.id, notificationFeed]);

  const handleAcceptInvite = useCallback(() => {
    track.$.sidebar.notifications.clickNotification({
      type: notification.type,
      item: "button",
      button: "accept",
    });
    setIsAccepting(true);
    invitationService
      .acceptInvite(inviteId)
      .catch((err) => {
        const userFriendlyError = UserFriendlyError.fromAny(err);
        if (userFriendlyError.is("ALREADY_IN_SPACE")) {
          // ignore if the user is already in the workspace
          return true;
        }
        notify.error(userFriendlyError);
        throw err;
      })
      .then(async (value) => {
        if (value === false) {
          // invite is expired
          notify.error({
            title: t["com.myoxus.expired.page.title"](),
            message: t["com.myoxus.expired.page.new-subtitle"](),
          });
          notificationFeed.readNotification(notification.id).catch((err) => {
            notify.error(UserFriendlyError.fromAny(err));
          });
          return;
        } else {
          // invite is accepted — refresh list, then show switch dialog
          await workspacesService.list.waitForRevalidation();
          notificationFeed.readNotification(notification.id).catch((err) => {
            notify.error(UserFriendlyError.fromAny(err));
          });
          // P100-WF-G-04: show inline workspace-switch prompt instead of auto-navigating
          setAcceptedWorkspaceName(workspaceName);
        }
      })
      .catch((err) => {
        const userFriendlyError = UserFriendlyError.fromAny(err);
        notify.error(userFriendlyError);
      })
      .finally(() => {
        setIsAccepting(false);
      });
  }, [
    invitationService,
    inviteId,
    notification,
    notificationFeed,
    t,
    workspaceName,
    workspacesService,
  ]);

  // P100-WF-G-04: post-accept workspace-switch prompt
  if (acceptedWorkspaceName !== null) {
    return (
      <NotificationPanelItem>
        <NotificationPanelItemMain>
          <NotificationPanelItemMessage>
            {t["com.myoxus.notification.invitation.joined"]()}
          </NotificationPanelItemMessage>
          <Button variant="primary" onClick={handleReadAndOpenWorkspace}>
            {t["com.myoxus.notification.invitation.switch"]()}
          </Button>
        </NotificationPanelItemMain>
        <MarkReadButton notification={notification} />
      </NotificationPanelItem>
    );
  }

  return (
    <NotificationPanelItem>
      <Avatar
        size="xs"
        name={body.createdByUser?.name ?? undefined}
        url={body.createdByUser?.avatarUrl ?? undefined}
      />
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          <Trans
            i18nKey={"com.myoxus.notification.invitation"}
            components={{
              1: <NotificationPanelEntity inactive={memberInactived} />,
              2: <WorkspaceNameWithIcon data-inactived={workspaceInactived} />,
            }}
            values={{
              username:
                body.createdByUser?.name ?? t["com.myoxus.inactive-member"](),
              workspaceName:
                body.workspace?.name ?? t["com.myoxus.inactive-workspace"](),
            }}
          />
        </NotificationPanelItemMessage>
        {!workspaceInactived && (
          <Button
            variant="secondary"
            onClick={handleAcceptInvite}
            loading={isAccepting}
          >
            {t["com.myoxus.notification.invitation.accept"]()}
          </Button>
        )}
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, {
            relative: true,
          })}
        </NotificationPanelItemDate>
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};

const MarkReadButton = ({
  notification,
  onClick,
}: {
  notification: Notification;
  onClick?: () => void;
}) => {
  const notificationFeed = useNotificationFeed();
  const t = useI18n();

  const handleMarkRead = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation(); // prevent trigger the click event of the parent element

      track.$.sidebar.notifications.clickNotification({
        type: notification.type,
        item: "dismiss",
      });

      notificationFeed.readNotification(notification.id).catch((err) => {
        notify.error(UserFriendlyError.fromAny(err));
      });
      onClick?.();
    },
    [notificationFeed, notification, onClick],
  );

  if (notification.read) return null;

  return (
    <NotificationPanelReadAction
      aria-label={t["com.myoxus.notification.mark-read"]()}
      icon={<CheckIcon />}
      onClick={handleMarkRead}
    />
  );
};

const WorkspaceNameWithIcon = ({
  children,
  ...props
}: React.PropsWithChildren<React.HTMLAttributes<HTMLSpanElement>>) => {
  const inactive = Boolean(
    (props as Record<string, unknown>)["data-inactived"],
  );
  return (
    <NotificationPanelEntity inactive={inactive}>
      <NotificationPanelEntityIcon>
        <CollaborationIcon />
      </NotificationPanelEntityIcon>
      {children}
    </NotificationPanelEntity>
  );
};

const DocNameWithIcon = ({
  children,
  mode,
  ...props
}: React.PropsWithChildren<
  React.HTMLAttributes<HTMLSpanElement> & { mode: "page" | "edgeless" }
>) => {
  const { emoji, rest: titleWithoutEmoji } = useMemo(() => {
    if (typeof children === "string") {
      return extractEmojiIcon(children);
    }
    if (
      children instanceof Array &&
      children.length === 1 &&
      typeof children[0] === "string"
    ) {
      return extractEmojiIcon(children[0]);
    }
    return { rest: children, emoji: null };
  }, [children]);
  return (
    <NotificationPanelEntity {...props}>
      {emoji ? (
        <NotificationPanelEntityIcon>{emoji}</NotificationPanelEntityIcon>
      ) : mode === "page" ? (
        <NotificationPanelEntityIcon>
          <PageIcon />
        </NotificationPanelEntityIcon>
      ) : (
        <NotificationPanelEntityIcon>
          <EdgelessIcon />
        </NotificationPanelEntityIcon>
      )}
      {titleWithoutEmoji}
    </NotificationPanelEntity>
  );
};

const CommentNotificationItem = ({
  notification,
}: {
  notification: Notification;
}) => {
  const notificationFeed = useNotificationFeed();
  const notificationService = useService(NotificationService);
  const { jumpToPageComment } = useNavigateHelper();
  const t = useI18n();
  const body = notification.body as CommentNotificationBodyType;
  const [targetError, setTargetError] = useState<string | null>(null);
  const messageKey =
    notification.type === NotificationType.CommentMention
      ? "com.myoxus.notification.comment-mention"
      : "com.myoxus.notification.comment";

  const memberInactived = !body.createdByUser;

  const handleClick = useCallback(async () => {
    track.$.sidebar.notifications.clickNotification({
      type: notification.type,
      item: "read",
    });
    if (!body.workspaceId || !body.doc?.id) {
      return;
    }
    setTargetError(null);
    try {
      const targetExists = await notificationService.documentTargetExists(
        body.workspaceId,
        body.doc.id,
      );
      if (!targetExists) {
        setTargetError(t["com.myoxus.workbench.route.not-found.description"]());
        return;
      }
    } catch (error) {
      setTargetError(UserFriendlyError.fromAny(error).message);
      return;
    }
    jumpToPageComment(
      body.workspaceId,
      body.doc.id,
      body.commentId,
      body.doc.mode,
    );
    notificationFeed.readNotification(notification.id).catch((err) => {
      notify.error(UserFriendlyError.fromAny(err));
    });
  }, [
    body,
    jumpToPageComment,
    notificationFeed,
    notification,
    notificationService,
    t,
  ]);

  return (
    <NotificationPanelItem onClick={handleClick}>
      <Avatar
        size="xs"
        name={body.createdByUser?.name ?? undefined}
        url={body.createdByUser?.avatarUrl ?? undefined}
      />
      <NotificationPanelItemMain>
        <NotificationPanelItemMessage>
          <Trans
            i18nKey={messageKey}
            components={{
              1: <NotificationPanelEntity inactive={memberInactived} />,
              2: <DocNameWithIcon mode={body.doc!.mode} />,
            }}
            values={{
              username:
                body.createdByUser?.name ?? t["com.myoxus.inactive-member"](),
              docTitle: body.doc!.title || t["Untitled"](),
            }}
          />
        </NotificationPanelItemMessage>
        <NotificationPanelItemDate>
          {i18nTime(notification.createdAt, {
            relative: true,
          })}
        </NotificationPanelItemDate>
        {targetError ? (
          <NotificationPanelError>{targetError}</NotificationPanelError>
        ) : null}
      </NotificationPanelItemMain>
      <MarkReadButton notification={notification} />
    </NotificationPanelItem>
  );
};
