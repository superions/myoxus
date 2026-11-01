import { FrameworkScope, useLiveData } from "@myoxus/infra";
import { useLayoutEffect, useMemo } from "react";
import {
  createMemoryRouter,
  type RouteObject,
  RouterProvider,
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
} from "react-router";

import type { View } from "../entities/view";

export const ViewRoot = ({
  view,
  routes,
}: {
  view: View;
  routes: RouteObject[];
}) => {
  const viewRouter = useMemo(() => createMemoryRouter(routes), [routes]);
  const routeContextValue = useMemo(
    () => ({ outlet: null, matches: [], isDataRoute: false }),
    [],
  );

  const location = useLiveData(view.location$);

  useLayoutEffect(() => {
    viewRouter.navigate(location).catch((err) => {
      console.error("navigate error", err);
    });
  }, [location, view, viewRouter]);

  // Reset the location context so nested routers do not inherit the parent
  // router's location. See: https://github.com/remix-run/react-router/issues/7375

  const nullLocationContext = null as any;
  return (
    <FrameworkScope scope={view.scope}>
      <UNSAFE_LocationContext.Provider value={nullLocationContext}>
        <UNSAFE_RouteContext.Provider value={routeContextValue}>
          <RouterProvider router={viewRouter} />
        </UNSAFE_RouteContext.Provider>
      </UNSAFE_LocationContext.Provider>
    </FrameworkScope>
  );
};
