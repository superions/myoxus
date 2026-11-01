// SPDX-License-Identifier: AGPL-3.0-or-later

import { NotificationList } from "@myoxus/core/components/notification/list";
import {
  NotificationService,
  NotificationType,
} from "@myoxus/core/modules/notification";
import { useI18n } from "@myoxus/i18n";
import { ActivityIcon, CalendarClockIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { useMemo } from "react";

import { DashboardSection } from "./section";

type DashboardNotificationKind = "activity" | "reminders";

export const DashboardNotificationIcon = ({
  kind,
}: {
  kind: DashboardNotificationKind;
}) =>
  kind === "reminders" ? (
    <CalendarClockIcon aria-hidden />
  ) : (
    <ActivityIcon aria-hidden />
  );

const ACTIVITY_TYPES = [
  NotificationType.General,
  NotificationType.DatabaseRowAssigned,
  NotificationType.DatabaseTaskChanged,
  NotificationType.DocumentChanged,
  NotificationType.Mention,
  NotificationType.CommentMention,
  NotificationType.Invitation,
  NotificationType.InvitationAccepted,
  NotificationType.InvitationBlocked,
  NotificationType.MemberApproval,
  NotificationType.MemberApproved,
  NotificationType.MemberApprovalDeclined,
  NotificationType.MemberRemoved,
  NotificationType.RoleChanged,
] as const;

export const DashboardNotificationSection = ({
  kind,
  onOpenInbox,
}: {
  kind: DashboardNotificationKind;
  onOpenInbox: () => void;
}) => {
  const t = useI18n();
  const notifications = useService(NotificationService);
  const reminders = kind === "reminders";
  const feed = useMemo(
    () =>
      notifications.createFeed({
        includeRead: reminders,
        types: reminders
          ? [NotificationType.DatabaseRowReminder]
          : [...ACTIVITY_TYPES],
      }),
    [notifications, reminders],
  );

  return (
    <DashboardSection
      action={{
        label: t["com.myoxus.notification.open-inbox"](),
        onClick: onOpenInbox,
      }}
      icon={<DashboardNotificationIcon kind={kind} />}
      scope={t["com.myoxus.workspace-home.server-account"]()}
      title={
        reminders
          ? t["com.myoxus.notification.filter.reminders"]()
          : t["com.myoxus.sidebar.tab.activity"]()
      }
      uiRole={`workspace-home-${kind}`}
    >
      <NotificationList
        emptyDescription={
          reminders
            ? t["com.myoxus.workspace-home.reminders-empty-description"]()
            : t["com.myoxus.notification.empty.description"]()
        }
        emptyIcon={<DashboardNotificationIcon kind={kind} />}
        emptyTitle={
          reminders
            ? t["com.myoxus.workspace-home.reminders-empty"]()
            : t["com.myoxus.notification.empty"]()
        }
        feed={feed}
        limit={6}
        mode="embedded"
        showHeader={false}
        showWorkspaceContext
      />
    </DashboardSection>
  );
};
