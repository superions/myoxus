import {
  WorkbenchRouteError,
  WorkbenchRouteHydrationFallback,
} from "@myoxus/core/desktop/pages/404";
import { workbenchRoutes } from "@myoxus/core/desktop/workbench-router";
import { useLiveData, useService } from "@myoxus/infra";
import { Stack } from "@myoxus/ui-facade";
import { memo, useCallback, useEffect, useRef } from "react";
import { type RouteObject, useLocation } from "react-router";

import type { View } from "../entities/view";
import { WorkbenchService } from "../services/workbench";
import { useBindWorkbenchToBrowserRouter } from "./browser-adapter";
import { useBindWorkbenchToDesktopRouter } from "./desktop-adapter";
import { RouteContainer } from "./route-container";
import { SplitView } from "./split-view/split-view";
import { ViewIslandRegistryProvider } from "./view-islands";
import { ViewRoot } from "./view-root";

const useAdapter = BUILD_CONFIG.isElectron
  ? useBindWorkbenchToDesktopRouter
  : useBindWorkbenchToBrowserRouter;

export const workbenchRootRoutes: RouteObject[] = [
  {
    element: <RouteContainer />,
    errorElement: <WorkbenchRouteError />,
    hydrateFallbackElement: <WorkbenchRouteHydrationFallback />,
    children: workbenchRoutes,
  },
];

export const WorkbenchRoot = memo(() => {
  const workbench = useService(WorkbenchService).workbench;

  // Expose workbench on window for debugging in development only
  if (process.env.NODE_ENV === "development") {
    (window as any).workbench = workbench;
  }

  const views = useLiveData(workbench.views$);

  const location = useLocation();
  const basename = location.pathname.match(/\/workspace\/[^/]+/g)?.[0] ?? "/";

  useAdapter(workbench, basename);

  const panelRenderer = useCallback((view: View) => {
    return <WorkbenchView view={view} />;
  }, []);

  const onMove = useCallback(
    (from: number, to: number) => {
      workbench.moveView(from, to);
    },
    [workbench],
  );

  useEffect(() => {
    workbench.updateBasename(basename);
  }, [basename, workbench]);

  return (
    <ViewIslandRegistryProvider>
      <SplitView
        data-fill="true"
        data-myoxus-ui-role="workbench-root-container"
        views={views}
        renderer={panelRenderer}
        onMove={onMove}
      />
    </ViewIslandRegistryProvider>
  );
});

WorkbenchRoot.displayName = "memo(WorkbenchRoot)";

const WorkbenchView = ({ view }: { view: View }) => {
  const workbench = useService(WorkbenchService).workbench;

  const handleOnFocus = useCallback(() => {
    workbench.active(view);
  }, [workbench, view]);

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      const element = containerRef.current;
      element.addEventListener("pointerdown", handleOnFocus, {
        capture: true,
      });
      return () => {
        element.removeEventListener("pointerdown", handleOnFocus, {
          capture: true,
        });
      };
    }
    return;
  }, [handleOnFocus]);

  return (
    <Stack
      flex={1}
      gap={0}
      h="100%"
      mih={0}
      miw={0}
      style={{ overflow: "hidden" }}
      ref={containerRef}
      data-myoxus-ui-role="workbench-view-container"
    >
      <ViewRoot routes={workbenchRootRoutes} key={view.id} view={view} />
    </Stack>
  );
};
