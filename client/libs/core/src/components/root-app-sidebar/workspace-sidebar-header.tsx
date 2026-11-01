// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { SearchIcon } from "@myoxus/icons/react";
import {
  Group,
  IconButton,
  ShellBrandWordmark,
  SidebarHeaderControls,
  SidebarHeaderMainSlot,
} from "@myoxus/ui-facade";

import { AppSidebarToggle } from "../../modules/app-sidebar/views/app-sidebar-toggle";
import { NotificationButton } from "./notification-button";

export function WorkspaceSidebarHeader({
  onSearch,
  showNotifications,
}: {
  onSearch: () => void;
  showNotifications: boolean;
}) {
  const t = useI18n();

  return (
    <SidebarHeaderControls data-myoxus-ui-role="workspace-sidebar-header">
      <SidebarHeaderMainSlot>
        <ShellBrandWordmark
          alt="Myoxus"
          data-myoxus-ui-role="app-sidebar-brand-logo"
        />
      </SidebarHeaderMainSlot>
      <Group gap="xs" wrap="nowrap">
        <IconButton
          aria-label={t["Quick search"]()}
          data-testid="slider-bar-quick-search-button"
          onClick={onSearch}
          tooltip={t["Quick search"]()}
          variant="plain"
        >
          <SearchIcon />
        </IconButton>
        {showNotifications ? <NotificationButton compact /> : null}
        <AppSidebarToggle />
      </Group>
    </SidebarHeaderControls>
  );
}
