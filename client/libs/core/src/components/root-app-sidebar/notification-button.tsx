import { MenuItem } from "@myoxus/core/modules/app-sidebar/views";
import { NotificationCountService } from "@myoxus/core/modules/notification";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { NotificationIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { Badge, CountIndicator, IconButton, Menu } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { NotificationList } from "../notification/list";

const NotificationBadge = ({
  count,
  label,
}: {
  count: number;
  label: string;
}) => {
  if (count === 0) {
    return null;
  }
  return (
    <Badge
      aria-label={`${label}: ${count}`}
      data-myoxus-ui-role="sidebar-notification-badge"
      surface="floating"
      tone="info"
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
};

export const NotificationButton = ({
  compact = false,
}: {
  compact?: boolean;
}) => {
  const notificationCountService = useService(NotificationCountService);
  const workbench = useService(WorkbenchService).workbench;
  const notificationCount = useLiveData(notificationCountService.count$);

  const t = useI18n();

  const [notificationListOpen, setNotificationListOpen] = useState(false);

  const handleNotificationListOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        track.$.sidebar.notifications.openInbox({
          unreadCount: notificationCountService.count$.value,
        });
      }
      setNotificationListOpen(open);
    },
    [notificationCountService.count$.value],
  );

  const openInbox = useCallback(() => {
    setNotificationListOpen(false);
    workbench.open("/inbox?read=unread&type=all", { at: "active" });
  }, [workbench]);

  const menu = (
    <Menu
      rootOptions={{
        open: notificationListOpen,
        onOpenChange: handleNotificationListOpenChange,
      }}
      contentOptions={{ side: "right" }}
      items={<NotificationList onOpenInbox={openInbox} />}
    >
      {compact ? (
        <IconButton
          aria-label={t["com.myoxus.rootAppSidebar.notifications"]()}
          data-testid="notification-button"
          tooltip={t["com.myoxus.rootAppSidebar.notifications"]()}
          tooltipOptions={{
            opened: notificationListOpen ? false : undefined,
          }}
          variant={notificationListOpen ? "secondary" : "plain"}
        >
          <NotificationIcon />
        </IconButton>
      ) : (
        <MenuItem
          icon={<NotificationIcon />}
          postfix={
            <NotificationBadge
              count={notificationCount}
              label={t["com.myoxus.rootAppSidebar.notifications"]()}
            />
          }
          active={notificationListOpen}
        >
          <span data-testid="notification-button">
            {t["com.myoxus.rootAppSidebar.notifications"]()}
          </span>
        </MenuItem>
      )}
    </Menu>
  );

  return compact ? (
    <CountIndicator
      count={notificationCount}
      data-myoxus-ui-role="sidebar-notification-indicator"
    >
      {menu}
    </CountIndicator>
  ) : (
    menu
  );
};
