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
  ShellPanelScroll,
  ShellRightPanel,
  ShellSidebarBrand,
  ShellSidebarInner,
  ShellSidebarPanel,
  ShellSidebarToggle,
} from "@myoxus/ui-facade";
import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "react-router";

import { PageConfigErrorBoundary } from "../components/page-config-error-boundary";
import { Nav } from "./nav/nav";
import {
  AdminDetailPanelContext,
  type AdminDetailPanelController,
} from "./panel/context";

const DETAIL_PANEL_OPEN_SIZE = 30;

export function Layout({ children }: PropsWithChildren) {
  const location = useLocation();
  const [sizes, setSizes] = useState<SplitterPaneSize[]>([
    shellPanelSizes.navigationExpanded,
    85,
    0,
  ]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailContent, setDetailContent] = useState<ReactNode>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsDirty, setDetailsDirty] = useState(false);

  const setPanelContent = useCallback((content: ReactNode) => {
    setDetailsDirty(false);
    setDetailContent(content);
  }, []);
  const openDetails = useCallback(() => {
    setSizes(([navigation]) => [navigation, 55, DETAIL_PANEL_OPEN_SIZE]);
    setDetailsOpen(true);
  }, []);
  const closeDetails = useCallback(() => {
    setSizes(([navigation]) => [navigation, 85, 0]);
    setDetailsOpen(false);
    setDetailsDirty(false);
  }, []);
  const toggleDetails = useCallback(() => {
    if (!detailsOpen) openDetails();
    else closeDetails();
  }, [closeDetails, detailsOpen, openDetails]);
  const controller = useMemo<AdminDetailPanelController>(
    () => ({
      isOpen: detailsOpen,
      panelContent: detailContent,
      setPanelContent,
      openPanel: openDetails,
      closePanel: closeDetails,
      togglePanel: toggleDetails,
      hasDirtyChanges: detailsDirty,
      setHasDirtyChanges: setDetailsDirty,
    }),
    [
      closeDetails,
      detailContent,
      detailsDirty,
      detailsOpen,
      openDetails,
      setPanelContent,
      toggleDetails,
    ],
  );

  useEffect(() => {
    setPanelContent(null);
    closeDetails();
  }, [closeDetails, location.pathname, setPanelContent]);

  const openSidebar = useCallback(() => {
    setSizes(([, main, detail]) => [
      shellPanelSizes.navigationExpanded,
      main,
      detail,
    ]);
    setSidebarCollapsed(false);
  }, []);
  const closeSidebar = useCallback(() => {
    setSizes(([, main, detail]) => [
      shellPanelSizes.navigationCollapsed,
      main,
      detail,
    ]);
    setSidebarCollapsed(true);
  }, []);

  return (
    <AdminDetailPanelContext.Provider value={controller}>
      <AppShellRoot>
        <Splitter
          sizes={sizes}
          onSizeChange={setSizes}
          onCollapseChange={(index, collapsed) => {
            if (index === 2) setDetailsOpen(!collapsed);
          }}
        >
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
          <ShellRightPanel
            id="admin-details"
            defaultSize={0}
            min={0}
            max={shellPanelSizes.detailMax}
            collapsible
          >
            <ShellPanelScroll>
              <PageConfigErrorBoundary>{detailContent}</PageConfigErrorBoundary>
            </ShellPanelScroll>
          </ShellRightPanel>
        </Splitter>
      </AppShellRoot>
    </AdminDetailPanelContext.Provider>
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
