import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useCatchEventCallback } from "@myoxus/core/components/hooks/use-catch-event-hook";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { CloseIcon, PlusIcon, RightSidebarIcon } from "@myoxus/icons/react";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  AppTabStripActionButton,
  AppTabStripCloseButton,
  AppTabStripCloseSlot,
  AppTabStripDivider,
  AppTabStripDropIndicator,
  AppTabStripLeadingSlot,
  AppTabStripList,
  AppTabStripRoot,
  AppTabStripSpacer,
  AppTabStripTab,
  AppTabStripTabSlot,
  AppTabStripViewButton,
  AppTabStripViewIcon,
  AppTabStripViewLabel,
  AppTabStripWindowsControlsPlaceholder,
  type DropTargetDropEvent,
  type DropTargetOptions,
  Loading,
  useDraggable,
  useDropTarget,
} from "@myoxus/ui-facade";
import { partition } from "lodash-es";
import {
  Fragment,
  type MouseEventHandler,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import { AppSidebarService } from "../../app-sidebar";
import { DesktopApiService } from "../../desktop-api";
import { resolveLinkToDoc } from "../../navigation";
import { iconNameToIcon } from "../../workbench/constants";
import { DesktopStateSynchronizer } from "../../workbench/services/desktop-state-synchronizer";
import {
  AppTabsHeaderService,
  type TabStatus,
} from "../services/app-tabs-header-service";

const TabSupportType = new Set(["collection", "tag", "doc"]);

const tabCanDrop =
  (tab?: TabStatus): NonNullable<DropTargetOptions<MyoxusDNDData>["canDrop"]> =>
  (ctx) => {
    if (
      ctx.source.data.from?.at === "app-header:tabs" &&
      ctx.source.data.from.tabId !== tab?.id
    ) {
      return true;
    }

    if (
      ctx.source.data.entity?.type &&
      TabSupportType.has(ctx.source.data.entity?.type)
    ) {
      return true;
    }

    return false;
  };

const WorkbenchView = ({
  workbench,
  view,
  activeViewIndex,
  viewIdx,
  tabActive,
}: {
  workbench: TabStatus;
  view: TabStatus["views"][number];
  activeViewIndex: number;
  viewIdx: number;
  tabActive: boolean;
  dnd?: boolean;
}) => {
  const tabsHeaderService = useService(AppTabsHeaderService);

  const onActivateView = useAsyncCallback(
    async (viewIdx: number) => {
      if (viewIdx === activeViewIndex && tabActive) {
        return;
      }
      await tabsHeaderService.activateView?.(workbench.id, viewIdx);
      if (tabActive) {
        track.$.appTabsHeader.$.tabAction({
          control: "click",
          action: "switchSplitView",
        });
      } else {
        track.$.appTabsHeader.$.tabAction({
          control: "click",
          action: "switchTab",
        });
      }
    },
    [activeViewIndex, tabActive, tabsHeaderService, workbench.id],
  );

  const handleClick: MouseEventHandler = useCatchEventCallback(
    async (e) => {
      e.stopPropagation();
      onActivateView(viewIdx);
    },
    [onActivateView, viewIdx],
  );

  const handleAuxClick: MouseEventHandler = useCatchEventCallback(
    async (e) => {
      if (e.button === 1) {
        await tabsHeaderService.closeTab?.(workbench.id);
        track.$.appTabsHeader.$.tabAction({
          control: "midClick",
          action: "close",
        });
      }
    },
    [tabsHeaderService, workbench.id],
  );

  const onContextMenu = useAsyncCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const action = await tabsHeaderService.showContextMenu?.(
        workbench.id,
        viewIdx,
      );
      switch (action?.type) {
        case "open-in-split-view": {
          track.$.appTabsHeader.$.tabAction({
            control: "contextMenu",
            action: "openInSplitView",
          });
          break;
        }
        case "separate-view": {
          track.$.appTabsHeader.$.tabAction({
            control: "contextMenu",
            action: "separateTabs",
          });
          break;
        }
        case "pin-tab": {
          if (action.payload.shouldPin) {
            track.$.appTabsHeader.$.tabAction({
              control: "contextMenu",
              action: "pin",
            });
          } else {
            track.$.appTabsHeader.$.tabAction({
              control: "contextMenu",
              action: "unpin",
            });
          }
          break;
        }
        // fixme: when close tab the view may already be gc'ed
        case "close-tab": {
          track.$.appTabsHeader.$.tabAction({
            control: "contextMenu",
            action: "close",
          });
          break;
        }
        default:
          break;
      }
    },
    [tabsHeaderService, viewIdx, workbench.id],
  );

  const contentNode = useMemo(() => {
    return (
      <>
        <AppTabStripViewIcon>
          {workbench.ready || !workbench.loaded ? (
            iconNameToIcon[view.iconName ?? "allDocs"]
          ) : (
            <Loading />
          )}
        </AppTabStripViewIcon>
        {!view.title ? null : (
          <AppTabStripViewLabel title={view.title}>
            {view.title}
          </AppTabStripViewLabel>
        )}
      </>
    );
  }, [workbench, view]);
  return (
    <AppTabStripViewButton
      data-testid="split-view-label"
      active={activeViewIndex === viewIdx && tabActive}
      onContextMenu={onContextMenu}
      onAuxClick={handleAuxClick}
      onClick={handleClick}
    >
      {contentNode}
    </AppTabStripViewButton>
  );
};

const WorkbenchTab = ({
  workbench,
  active: tabActive,
  tabsLength,
  dnd,
  onDrop,
}: {
  workbench: TabStatus;
  active: boolean;
  tabsLength: number;
  dnd?: boolean;
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
}) => {
  const t = useI18n();
  useServiceOptional(DesktopStateSynchronizer);
  const tabsHeaderService = useService(AppTabsHeaderService);
  const activeViewIndex = workbench.activeViewIndex ?? 0;

  const handleCloseTab = useCatchEventCallback(async () => {
    await tabsHeaderService.closeTab?.(workbench.id);
    track.$.appTabsHeader.$.tabAction({
      control: "xButton",
      action: "close",
    });
  }, [tabsHeaderService, workbench.id]);

  const { dropTargetRef, closestEdge } = useDropTarget<MyoxusDNDData>(
    () => ({
      closestEdge: {
        allowedEdges: ["left", "right"],
      },
      onDrop,
      dropEffect: "move",
      canDrop: dnd ? tabCanDrop(workbench) : false,
      isSticky: true,
      allowExternal: true,
    }),
    [dnd, onDrop, workbench],
  );

  const { dragRef } = useDraggable<MyoxusDNDData>(() => {
    const urls = workbench.views.map((view) => {
      const url = new URL(
        workbench.basename + (view.path?.pathname ?? ""),
        location.origin,
      );
      url.search = view.path?.search ?? "";
      return url.toString();
    });

    let entity: MyoxusDNDData["draggable"]["entity"];

    for (const url of urls) {
      const maybeDocLink = resolveLinkToDoc(url);
      if (maybeDocLink && maybeDocLink.docId) {
        entity = {
          type: "doc",
          id: maybeDocLink.docId,
        };
      }
    }

    return {
      canDrag: dnd,
      data: {
        from: {
          at: "app-header:tabs",
          tabId: workbench.id,
        },
        entity,
      },
      dragPreviewPosition: "pointer-outside",
      toExternalData: () => {
        return {
          "text/uri-list": urls.join("\n"),
        };
      },
      onDragStart: () => {
        track.$.appTabsHeader.$.dragStart({
          type: "tab",
        });
      },
    };
  }, [dnd, workbench.basename, workbench.id, workbench.views]);

  return (
    <AppTabStripTabSlot
      ref={(node) => {
        dropTargetRef.current = node;
        dragRef.current = node;
      }}
    >
      <AppTabStripTab
        key={workbench.id}
        data-testid="workbench-tab"
        active={tabActive}
        pinned={workbench.pinned}
        viewCount={workbench.views.length}
      >
        {workbench.views.map((view, viewIdx) => {
          return (
            <Fragment key={view.id}>
              <WorkbenchView
                workbench={workbench}
                view={view}
                activeViewIndex={activeViewIndex}
                viewIdx={viewIdx}
                tabActive={tabActive}
                dnd={dnd}
              />

              {viewIdx !== workbench.views.length - 1 ? (
                <AppTabStripDivider orientation="split-view" />
              ) : null}
            </Fragment>
          );
        })}
        <AppTabStripCloseSlot>
          {tabsLength > 1 && !workbench.pinned ? (
            <AppTabStripCloseButton
              data-testid="close-tab-button"
              aria-label={t["com.myoxus.workbench.split-view-menu.close"]()}
              onClick={handleCloseTab}
            >
              <CloseIcon />
            </AppTabStripCloseButton>
          ) : null}
        </AppTabStripCloseSlot>
      </AppTabStripTab>
      <AppTabStripDropIndicator edge={closestEdge} />
    </AppTabStripTabSlot>
  );
};

const useIsFullScreen = () => {
  const desktopApi = useServiceOptional(DesktopApiService);
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    desktopApi?.handler.ui
      .isFullScreen()
      .then((value) => setFullScreen(value ?? false))
      .then(() => {
        desktopApi?.events.ui.onFullScreen(setFullScreen);
      })
      .catch(console.error);
  }, [desktopApi?.events.ui, desktopApi?.handler.ui]);
  return fullScreen;
};

export const AppTabsHeader = ({
  style,
  mode = "app",
  className,
  left,
}: {
  style?: React.CSSProperties;
  mode?: "app" | "shell";
  className?: string;
  left?: ReactNode;
}) => {
  const t = useI18n();
  const appSidebarService = useService(AppSidebarService).sidebar;
  const sidebarWidth = useLiveData(appSidebarService.width$);
  const sidebarOpen = useLiveData(appSidebarService.open$);
  const sidebarResizing = useLiveData(appSidebarService.resizing$);

  const isMacosDesktop = BUILD_CONFIG.isElectron && environment.isMacOs;
  const isWindowsDesktop = BUILD_CONFIG.isElectron && environment.isWindows;
  const fullScreen = useIsFullScreen();

  const desktopApi = useService(DesktopApiService);

  const tabsHeaderService = useService(AppTabsHeaderService);
  const tabs = useLiveData(tabsHeaderService.tabsStatus$);

  const [pinned, unpinned] = partition(tabs, (tab) => tab.pinned);

  const onAddTab = useAsyncCallback(async () => {
    await tabsHeaderService.onAddTab?.();
    track.$.appTabsHeader.$.tabAction({
      control: "click",
      action: "openInNewTab",
    });
  }, [tabsHeaderService]);

  const onToggleRightSidebar = useAsyncCallback(async () => {
    await tabsHeaderService.onToggleRightSidebar?.();
  }, [tabsHeaderService]);

  useEffect(() => {
    if (mode === "app") {
      desktopApi.handler.ui.pingAppLayoutReady().catch(console.error);
    }
  }, [mode, desktopApi]);

  const onDrop = useAsyncCallback(
    async (data: DropTargetDropEvent<MyoxusDNDData>, targetId?: string) => {
      const edge = data.closestEdge ?? "right";
      targetId = targetId ?? tabs.at(-1)?.id;

      if (!targetId || edge === "top" || edge === "bottom") {
        return;
      }

      if (data.source.data.from?.at === "app-header:tabs") {
        if (targetId === data.source.data.from.tabId) {
          return;
        }
        track.$.appTabsHeader.$.tabAction({
          control: "dnd",
          action: "moveTab",
        });
        return await tabsHeaderService.moveTab?.(
          data.source.data.from.tabId,
          targetId,
          edge,
        );
      }

      if (data.source.data.entity?.type === "doc") {
        track.$.appTabsHeader.$.tabAction({
          control: "dnd",
          action: "openInNewTab",
          type: "doc",
        });
        return await tabsHeaderService.onAddDocTab?.(
          data.source.data.entity.id,
          targetId,
          edge,
        );
      }

      if (data.source.data.entity?.type === "tag") {
        track.$.appTabsHeader.$.tabAction({
          type: "tag",
          control: "dnd",
          action: "openInNewTab",
        });
        return await tabsHeaderService.onAddTagTab?.(
          data.source.data.entity.id,
          targetId,
          edge,
        );
      }

      if (data.source.data.entity?.type === "collection") {
        track.$.appTabsHeader.$.tabAction({
          type: "collection",
          control: "dnd",
          action: "openInNewTab",
        });
        return await tabsHeaderService.onAddCollectionTab?.(
          data.source.data.entity.id,
          targetId,
          edge,
        );
      }
    },
    [tabs, tabsHeaderService],
  );

  const { dropTargetRef: spacerDropTargetRef, draggedOver } =
    useDropTarget<MyoxusDNDData>(
      () => ({
        onDrop,
        dropEffect: "move",
        canDrop: tabCanDrop(),
      }),
      [onDrop],
    );

  return (
    <AppTabStripRoot
      className={className}
      style={style}
      mode={mode}
      windows={isWindowsDesktop}
    >
      <AppTabStripLeadingSlot
        expandedInlineSize={sidebarOpen ? sidebarWidth : undefined}
        open={sidebarOpen}
        resizing={sidebarResizing}
        trafficLightReserve={isMacosDesktop && !fullScreen ? "macos" : "none"}
      >
        {left}
      </AppTabStripLeadingSlot>
      <AppTabStripList>
        {pinned.map((tab) => {
          return (
            <WorkbenchTab
              dnd={mode === "app"}
              tabsLength={pinned.length}
              key={tab.id}
              workbench={tab}
              onDrop={(data) => onDrop(data, tab.id)}
              active={tab.active}
            />
          );
        })}
        {pinned.length > 0 && unpinned.length > 0 && (
          <AppTabStripDivider orientation="pinned" />
        )}
        {unpinned.map((tab) => {
          return (
            <WorkbenchTab
              dnd={mode === "app"}
              tabsLength={tabs.length}
              key={tab.id}
              workbench={tab}
              onDrop={(data) => onDrop(data, tab.id)}
              active={tab.active}
            />
          );
        })}
      </AppTabStripList>
      <AppTabStripSpacer ref={spacerDropTargetRef} draggedOver={draggedOver}>
        <AppTabStripActionButton
          onClick={onAddTab}
          tooltip={t["com.myoxus.multi-tab.new-tab"]()}
          tooltipShortcut={["$mod", "T"]}
          data-testid="add-tab-view-button"
          size="small"
          icon={<PlusIcon />}
        />
      </AppTabStripSpacer>
      <AppTabStripActionButton
        onClick={onToggleRightSidebar}
        tooltip={t["com.myoxus.keyboardShortcuts.expandOrCollapseSidebar"]()}
      >
        <RightSidebarIcon />
      </AppTabStripActionButton>
      {isWindowsDesktop && <AppTabStripWindowsControlsPlaceholder />}
    </AppTabStripRoot>
  );
};
