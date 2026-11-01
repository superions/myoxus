import { NavigateContext } from "@myoxus/core/components/hooks/use-navigate-helper";
import { wrapCreateBrowserRouterV7 } from "@sentry/react";
import { useEffect, useState } from "react";
import {
  createBrowserRouter as reactRouterCreateBrowserRouter,
  redirect,
  type RouteObject,
  useNavigate,
} from "react-router";

import { AppFallback } from "./components/app-fallback";
import { RootWrapper } from "./pages/root";

function RootRouter() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // a hack to make sure router is ready
    setReady(true);
  }, []);

  return (
    ready && (
      <NavigateContext.Provider value={navigate}>
        <RootWrapper />
      </NavigateContext.Provider>
    )
  );
}

export const topLevelRoutes = [
  {
    element: <RootRouter />,
    // v7: without a HydrateFallback the screen stays blank while lazy route
    // chunks resolve on initial hydration. Mirrors the removed v6 fallbackElement.
    hydrateFallbackElement: <AppFallback />,
    children: [
      {
        path: "/",
        lazy: () => import("./pages/index"),
      },
      {
        path: "/workspace/:workspaceId/*",
        lazy: () => import("./pages/workspace/index"),
      },
      {
        path: "/share/:workspaceId/:pageId",
        loader: ({ params }) => {
          return redirect(`/workspace/${params.workspaceId}/${params.pageId}`);
        },
      },
      {
        path: "/404",
        lazy: () => import("./pages/404"),
      },
      {
        path: "/auth/:authType",
        lazy: () => import("./pages/auth"),
      },
      {
        path: "/sign-in",
        lazy: () => import("./pages/sign-in"),
      },
      {
        path: "/magic-link",
        lazy: () =>
          import(
            /* webpackChunkName: "auth" */ "@myoxus/core/desktop/pages/auth/magic-link"
          ),
      },
      {
        path: "/oauth/login",
        lazy: () =>
          import(
            /* webpackChunkName: "auth" */ "@myoxus/core/desktop/pages/auth/oauth-login"
          ),
      },
      {
        path: "/oauth/callback",
        lazy: () =>
          import(
            /* webpackChunkName: "auth" */ "@myoxus/core/desktop/pages/auth/oauth-callback"
          ),
      },
      {
        path: "/redirect-proxy",
        lazy: () => import("@myoxus/core/desktop/pages/redirect"),
      },
      {
        path: "/open-app/:action",
        lazy: () => import("@myoxus/core/desktop/pages/open-app"),
      },
      {
        path: "*",
        lazy: () => import("./pages/404"),
      },
    ],
  },
] satisfies [RouteObject, ...RouteObject[]];

const createBrowserRouter = wrapCreateBrowserRouterV7(
  reactRouterCreateBrowserRouter,
);
export const router = (
  window.SENTRY_RELEASE ? createBrowserRouter : reactRouterCreateBrowserRouter
)(topLevelRoutes);
