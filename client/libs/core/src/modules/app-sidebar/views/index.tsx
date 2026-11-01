// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import {
  Box,
  type DropTargetGetFeedback,
  ResponsiveSidePanel,
  ShellBrandWordmark,
  SidebarHeaderControls,
  SidebarHeaderMainSlot,
  Stack,
} from "@myoxus/ui-facade";
import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useMemo,
} from "react";

import { WorkbenchService } from "../../workbench";
import { allowedSplitViewEntityTypes } from "../../workbench/view/split-view/types";
import { AppSidebarService } from "../services/app-sidebar";

export type History = {
  stack: string[];
  current: number;
};

const resizeHandleShortcutClassName = "myoxus-app-sidebar-resize-shortcut";

export function AppSidebar({
  children,
  header,
}: PropsWithChildren<{ header?: ReactNode }>) {
  const appSidebarService = useService(AppSidebarService).sidebar;
  const workbenchService = useService(WorkbenchService).workbench;
  const t = useI18n();

  const open = useLiveData(appSidebarService.open$);
  const width = useLiveData(appSidebarService.width$);
  const resizing = useLiveData(appSidebarService.resizing$);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      appSidebarService.setOpen(open);
    },
    [appSidebarService],
  );

  const handleResizing = useCallback(
    (resizing: boolean) => {
      appSidebarService.setResizing(resizing);
    },
    [appSidebarService],
  );

  const handleWidthChange = useCallback(
    (width: number) => {
      appSidebarService.setWidth(width);
    },
    [appSidebarService],
  );

  const resizeHandleDropTargetOptions = useMemo(() => {
    return () => ({
      data: () => {
        const firstView = workbenchService.views$.value.at(0);

        if (!firstView) {
          return {};
        }

        return {
          at: "workbench:resize-handle",
          edge: "left", // left of the first view
          viewId: firstView.id,
        };
      },
      canDrop: (data: DropTargetGetFeedback<MyoxusDNDData>) => {
        return (
          (!!data.source.data.entity?.type &&
            allowedSplitViewEntityTypes.has(data.source.data.entity?.type)) ||
          data.source.data.from?.at === "workbench:link"
        );
      },
    });
  }, [workbenchService.views$.value]);

  return (
    <ResponsiveSidePanel
      opened={open}
      onOpenChange={handleOpenChange}
      side="left"
      drawerOnNarrow={!BUILD_CONFIG.isElectron && !BUILD_CONFIG.isMobileEdition}
      desktopResize={{
        resizeHandleDropTargetOptions,
        resizing,
        width,
        resizeHandlePos: "right",
        onResizing: handleResizing,
        onWidthChange: handleWidthChange,
        resizeHandleTooltip: <ResizeHandleTooltipContent />,
        resizeHandleTooltipOptions: {
          side: "right",
          align: "center",
        },
        resizeHandleTooltipShortcut: ["$mod", "/"],
        resizeHandleTooltipShortcutClassName: resizeHandleShortcutClassName,
      }}
      data-testid="app-sidebar-wrapper"
      data-myoxus-ui-role="app-sidebar-shell"
      surface="navigation"
    >
      <Stack
        aria-label={t["com.myoxus.cmdk.category.navigation"]()}
        component="nav"
        c="var(--myoxus-text-primary-color)"
        data-myoxus-ui-role="app-sidebar"
        data-testid="app-sidebar"
        gap={0}
        h="100%"
        pos="relative"
        w="100%"
      >
        {!BUILD_CONFIG.isElectron && header}
        <Box
          data-myoxus-ui-role="app-sidebar-container"
          data-testid="sliderBar-inner"
          display="flex"
          flex="1 1 auto"
          mih={0}
        >
          {children}
        </Box>
      </Stack>
    </ResponsiveSidePanel>
  );
}

const ResizeHandleTooltipContent = () => {
  const t = useI18n();
  return (
    <div>
      <div>{t["com.myoxus.rootAppSidebar.resize-handle.tooltip.drag"]()}</div>
      <div>{t["com.myoxus.rootAppSidebar.resize-handle.tooltip.click"]()}</div>
    </div>
  );
};

function SidebarFallbackFrame({ forceOpen = false }: { forceOpen?: boolean }) {
  const appSidebarService = useServiceOptional(AppSidebarService)?.sidebar;
  const storedOpen = useLiveData(appSidebarService?.open$);
  const width = useLiveData(appSidebarService?.width$);
  const opened = forceOpen || storedOpen || !appSidebarService;
  const t = useI18n();
  const handleOpenChange = useCallback(
    (open: boolean) => appSidebarService?.setOpen(open),
    [appSidebarService],
  );

  return (
    <ResponsiveSidePanel
      opened={opened}
      onOpenChange={handleOpenChange}
      side="left"
      drawerOnNarrow={!BUILD_CONFIG.isElectron && !BUILD_CONFIG.isMobileEdition}
      style={{ width }}
      data-myoxus-ui-role="app-sidebar-shell"
      surface="navigation"
    >
      <Stack
        aria-label={t["com.myoxus.cmdk.category.navigation"]()}
        component="nav"
        c="var(--myoxus-text-primary-color)"
        data-myoxus-ui-role="app-sidebar"
        gap={0}
        h="100%"
        pos="relative"
        w="100%"
      >
        {!BUILD_CONFIG.isElectron ? (
          <SidebarHeaderControls data-myoxus-ui-role="app-sidebar-fallback-header">
            <SidebarHeaderMainSlot>
              <ShellBrandWordmark
                alt="Myoxus"
                data-myoxus-ui-role="app-sidebar-brand-logo"
              />
            </SidebarHeaderMainSlot>
          </SidebarHeaderControls>
        ) : null}
        <Box
          aria-busy="true"
          data-myoxus-ui-role="app-sidebar-fallback-body"
          flex="1 1 auto"
          mih={0}
        />
      </Stack>
    </ResponsiveSidePanel>
  );
}

export const AppSidebarFallback = () => <SidebarFallbackFrame />;

export const ShellAppSidebarFallback = () => <SidebarFallbackFrame forceOpen />;

export * from "./add-page-button";
export * from "./app-download-button";
export * from "./app-sidebar-toggle";
export * from "./app-updater-button";
export * from "./category-divider";
export * from "./menu-item";
export * from "./open-in-app-card";
export * from "./quick-search-input";
