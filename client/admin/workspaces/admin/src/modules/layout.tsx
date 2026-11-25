// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { SidebarIcon } from "@myoxus/icons/react";
import {
  AppShellRoot,
  Badge,
  Splitter,
  type SplitterPaneSize,
  shellPanelSizes,
  ShellBrandInline,
  ShellBrandLogo,
  ShellSidebarBrand,
  ShellSidebarInner,
  ShellSidebarPanel,
  ShellSidebarToggle,
} from "@myoxus/ui-facade";
import { type PropsWithChildren, useCallback, useState } from "react";

import { Nav } from "./nav/nav";

export function Layout({ children }: PropsWithChildren) {
  const [sizes, setSizes] = useState<SplitterPaneSize[]>([
    shellPanelSizes.navigationExpanded,
    85,
  ]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const openSidebar = useCallback(() => {
    setSizes(([, main]) => [shellPanelSizes.navigationExpanded, main]);
    setSidebarCollapsed(false);
  }, []);
  const closeSidebar = useCallback(() => {
    setSizes(([, main]) => [shellPanelSizes.navigationCollapsed, main]);
    setSidebarCollapsed(true);
  }, []);

  return (
    <AppShellRoot>
      <Splitter sizes={sizes} onSizeChange={setSizes}>
        <ShellSidebarPanel
          defaultSize={sizes[0]}
          min={sizes[0]}
          max={sizes[0]}
          id="admin-navigation"
        >
          <AdminNavigationPanel
            collapsed={sidebarCollapsed}
            onOpen={openSidebar}
            onClose={closeSidebar}
          />
        </ShellSidebarPanel>
        <Splitter.Pane id="admin-main" min="50%" defaultSize={85}>
          {children}
        </Splitter.Pane>
      </Splitter>
    </AppShellRoot>
  );
}

function AdminNavigationPanel({
  collapsed,
  onOpen,
  onClose,
}: {
  collapsed: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const toggleLabel = i18n.t("admin.common.toggle-sidebar");

  return (
    <ShellSidebarInner>
      <ShellSidebarBrand collapsed={collapsed}>
        {collapsed ? null : (
          <ShellBrandLogo
            slot="logo"
            fallback={
              <ShellBrandInline>
                <Badge tone="neutral">M</Badge>
                Myoxus
              </ShellBrandInline>
            }
          />
        )}
        <ShellSidebarToggle
          collapsed={collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          data-testid={
            collapsed
              ? "shell-sidebar-toggle-collapsed"
              : "shell-sidebar-toggle-expanded"
          }
          onClick={collapsed ? onOpen : onClose}
        >
          <SidebarIcon />
        </ShellSidebarToggle>
      </ShellSidebarBrand>
      <Nav isCollapsed={collapsed} />
    </ShellSidebarInner>
  );
}
