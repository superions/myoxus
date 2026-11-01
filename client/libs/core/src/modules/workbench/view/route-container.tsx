import { MyoxusErrorBoundary } from "@myoxus/core/components/myoxus/myoxus-error-boundary";
import { useI18n } from "@myoxus/i18n";
import { InformationPanelIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Box,
  WorkbenchContextPanelToggleButton,
  WorkbenchRouteEdgeActionSlot,
  WorkbenchRouteHeader,
  WorkbenchRouteHeaderSlot,
  WorkbenchRouteRoot,
  WorkbenchRouteSurface,
} from "@myoxus/ui-facade";
import { Suspense, useCallback, useRef } from "react";
import { Outlet } from "react-router";

import { AppSidebarService } from "../../app-sidebar";
import { AppSidebarToggle } from "../../app-sidebar/views/app-sidebar-toggle";
import { ViewService } from "../services/view";
import { WorkbenchService } from "../services/workbench";
import { WorkbenchContextPanel } from "./context-panel/workbench-context-panel";
import { useIsActiveView } from "./use-is-active-view";
import { useViewPosition } from "./use-view-position";
import { ViewBodyTarget, ViewHeaderTarget } from "./view-islands";
import { WorkbenchSurfaceScrollProvider } from "./workbench-surface-scroll";

export interface Props {
  route: {
    Component: React.ComponentType;
  };
}

const ToggleButton = ({
  buttonRef,
  onToggle,
  open,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onToggle?: () => void;
  open: boolean;
}) => {
  const t = useI18n();
  return (
    <WorkbenchContextPanelToggleButton
      ref={buttonRef}
      onClick={onToggle}
      aria-expanded={open}
      aria-label={t["com.myoxus.keyboardShortcuts.expandOrCollapseSidebar"]()}
      data-testid="context-panel-toggle"
      variant={open ? "secondary" : "plain"}
    >
      <InformationPanelIcon />
    </WorkbenchContextPanelToggleButton>
  );
};

export const RouteContainer = () => {
  const viewPosition = useViewPosition();
  const isActiveView = useIsActiveView();
  const appSidebarService = useService(AppSidebarService).sidebar;
  const leftSidebarOpen = useLiveData(appSidebarService.open$);
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const contextSurfaces = useLiveData(view.contextSurfaces$);
  const toolLayout = useLiveData(view.toolLayout$);
  const contextPanelOpen = useLiveData(workbench.contextPanelOpen$);
  const viewportBounded = useLiveData(view.bodyViewportBounded$);
  const contextPanelToggleRef = useRef<HTMLButtonElement | null>(null);
  const surfaceScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const handleToggleContextPanel = useCallback(() => {
    workbench.toggleContextPanel();
  }, [workbench]);

  const showSwitch = !BUILD_CONFIG.isElectron && viewPosition.isFirst;

  const contextAvailable =
    isActiveView &&
    contextSurfaces.some((surface) =>
      toolLayout.visibleToolIds.includes(surface.id),
    );
  const contextVisible = contextAvailable && Boolean(contextPanelOpen);

  return (
    <WorkbenchSurfaceScrollProvider viewportRef={surfaceScrollViewportRef}>
      <WorkbenchRouteRoot data-workbench-view-id={view.id}>
        <WorkbenchRouteHeader
          showSwitch={showSwitch && !leftSidebarOpen}
          data-testid="workbench-view-header"
        >
          {showSwitch && !leftSidebarOpen && (
            <WorkbenchRouteEdgeActionSlot>
              <AppSidebarToggle />
            </WorkbenchRouteEdgeActionSlot>
          )}
          <WorkbenchRouteHeaderSlot>
            <ViewHeaderTarget
              viewId={view.id}
              data-myoxus-ui-role="workbench-view-header-target"
            />
          </WorkbenchRouteHeaderSlot>
          {!BUILD_CONFIG.isElectron &&
            isActiveView &&
            contextSurfaces.length > 0 && (
              <WorkbenchRouteEdgeActionSlot>
                <ToggleButton
                  buttonRef={contextPanelToggleRef}
                  open={Boolean(contextPanelOpen)}
                  onToggle={handleToggleContextPanel}
                />
              </WorkbenchRouteEdgeActionSlot>
            )}
        </WorkbenchRouteHeader>

        <MyoxusErrorBoundary>
          <Suspense>
            <Outlet />
          </Suspense>
        </MyoxusErrorBoundary>
        <WorkbenchRouteSurface
          viewportBounded={viewportBounded}
          context={
            contextAvailable ? (
              <WorkbenchContextPanel returnFocusRef={contextPanelToggleRef} />
            ) : null
          }
          contextVisible={contextVisible}
          ref={surfaceScrollViewportRef}
        >
          <Box
            component={ViewBodyTarget}
            viewId={view.id}
            data-myoxus-ui-role="workbench-view-body-target"
            display="flex"
            flex="1 1 auto"
            mih={0}
            miw={0}
            w="100%"
          />
        </WorkbenchRouteSurface>
      </WorkbenchRouteRoot>
    </WorkbenchSurfaceScrollProvider>
  );
};
