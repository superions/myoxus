import {
  type NotificationFilter,
  NotificationType,
} from "@myoxus/core/modules/notification";

export type InboxReadScope = "all" | "unread";
export type InboxTypeScope =
  | "all"
  | "comments"
  | "document-changes"
  | "invites"
  | "mentions"
  | "reminders";

const READ_SCOPES = new Set<InboxReadScope>(["all", "unread"]);
const TYPE_SCOPES = new Set<InboxTypeScope>([
  "all",
  "comments",
  "document-changes",
  "invites",
  "mentions",
  "reminders",
]);

const TYPE_FILTERS: Record<
  Exclude<InboxTypeScope, "all">,
  NotificationType[]
> = {
  "document-changes": [NotificationType.DocumentChanged],
  comments: [
    NotificationType.Comment,
    NotificationType.CommentMention,
    NotificationType.CommentReply,
  ],
  invites: [
    NotificationType.Invitation,
    NotificationType.InvitationAccepted,
    NotificationType.InvitationBlocked,
    NotificationType.MemberApproval,
    NotificationType.MemberApprovalDeclined,
    NotificationType.MemberApproved,
    NotificationType.MemberRemoved,
    NotificationType.RoleChanged,
  ],
  mentions: [NotificationType.Mention],
  reminders: [
    NotificationType.CalendarReminder,
    NotificationType.DatabaseRowReminder,
  ],
};

export function normalizeReadScope(value: string | null): InboxReadScope {
  return value && READ_SCOPES.has(value as InboxReadScope)
    ? (value as InboxReadScope)
    : "unread";
}

export function normalizeTypeScope(value: string | null): InboxTypeScope {
  return value && TYPE_SCOPES.has(value as InboxTypeScope)
    ? (value as InboxTypeScope)
    : "all";
}

export function normalizeInboxSearch(search: URLSearchParams) {
  const read = normalizeReadScope(search.get("read"));
  const type = normalizeTypeScope(search.get("type"));
  return {
    read,
    type,
    canonicalSearch: `read=${read}&type=${type}`,
  };
}

export function inboxWorkbenchPath(
  readScope: InboxReadScope,
  typeScope: InboxTypeScope,
) {
  return `/inbox?read=${readScope}&type=${typeScope}`;
}

export function toInboxFeedFilter(
  readScope: InboxReadScope,
  typeScope: InboxTypeScope,
): NotificationFilter {
  return {
    includeRead: readScope === "all",
    types: typeScope === "all" ? undefined : TYPE_FILTERS[typeScope],
  };
}
