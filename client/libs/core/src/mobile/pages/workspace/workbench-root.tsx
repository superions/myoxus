import {
  useBindWorkbenchToBrowserRouter,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { ViewRoot } from "@myoxus/core/modules/workbench/view/view-root";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";
import { type RouteObject, useLocation } from "react-router";

export const MobileWorkbenchRoot = ({ routes }: { routes: RouteObject[] }) => {
  const workbench = useService(WorkbenchService).workbench;

  // Expose workbench on window for debugging in development only
  if (process.env.NODE_ENV === "development") {
    (window as any).workbench = workbench;
  }

  const views = useLiveData(workbench.views$);

  const location = useLocation();
  const basename = location.pathname.match(/\/workspace\/[^/]+/g)?.[0] ?? "/";

  useBindWorkbenchToBrowserRouter(workbench, basename);

  useEffect(() => {
    workbench.updateBasename(basename);
  }, [basename, workbench]);

  return <ViewRoot routes={routes} view={views[0]} />;
};
