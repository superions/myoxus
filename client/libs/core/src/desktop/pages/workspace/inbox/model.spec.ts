/**
 * @vitest-environment happy-dom
 */

import { NotificationType } from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import {
  inboxWorkbenchPath,
  normalizeInboxSearch,
  toInboxFeedFilter,
} from "./model";

describe("inbox route contract", () => {
  test("normalizes unknown or partial URL state to the canonical unread feed", () => {
    expect(
      normalizeInboxSearch(
        new URLSearchParams("read=unexpected&type=unknown&stale=value"),
      ),
    ).toEqual({
      read: "unread",
      type: "all",
      canonicalSearch: "read=unread&type=all",
    });
    expect(normalizeInboxSearch(new URLSearchParams("read=all"))).toEqual({
      read: "all",
      type: "all",
      canonicalSearch: "read=all&type=all",
    });
    expect(inboxWorkbenchPath("all", "comments")).toBe(
      "/inbox?read=all&type=comments",
    );
  });

  test("maps every visible type scope to the authoritative GraphQL filter", () => {
    expect(toInboxFeedFilter("unread", "all")).toEqual({
      includeRead: false,
      types: undefined,
    });
    expect(toInboxFeedFilter("all", "mentions")).toEqual({
      includeRead: true,
      types: [NotificationType.Mention],
    });
    expect(toInboxFeedFilter("unread", "comments").types).toEqual([
      NotificationType.Comment,
      NotificationType.CommentMention,
      NotificationType.CommentReply,
    ]);
    expect(toInboxFeedFilter("unread", "reminders").types).toEqual([
      NotificationType.CalendarReminder,
      NotificationType.DatabaseRowReminder,
    ]);
    expect(
      normalizeInboxSearch(
        new URLSearchParams("read=all&type=document-changes"),
      ),
    ).toEqual({
      read: "all",
      type: "document-changes",
      canonicalSearch: "read=all&type=document-changes",
    });
    expect(toInboxFeedFilter("all", "document-changes")).toEqual({
      includeRead: true,
      types: [NotificationType.DocumentChanged],
    });
    expect(toInboxFeedFilter("unread", "invites").types).toEqual([
      NotificationType.Invitation,
      NotificationType.InvitationAccepted,
      NotificationType.InvitationBlocked,
      NotificationType.MemberApproval,
      NotificationType.MemberApprovalDeclined,
      NotificationType.MemberApproved,
      NotificationType.MemberRemoved,
      NotificationType.RoleChanged,
    ]);
  });
});
