import type { RouteObject } from "react-router";

import { Component as All } from "./pages/workspace/all";
import { Component as Collection } from "./pages/workspace/collection";
import { Component as CollectionDetail } from "./pages/workspace/collection/detail";
import { Component as Home } from "./pages/workspace/home";
import { Component as Journals } from "./pages/workspace/journals";
import { Component as Search } from "./pages/workspace/search";
import { Component as Tags } from "./pages/workspace/tags";
import { Component as TagDetail } from "./pages/workspace/tag/detail";

export const workbenchRoutes = [
  {
    path: "/home",
    Component: Home,
  },
  {
    path: "/overview",
    lazy: () => import("../desktop/pages/workspace/overview"),
  },
  {
    path: "/search",
    Component: Search,
  },
  {
    path: "/all",
    Component: All,
  },
  {
    path: "/collection",
    // lazy: () => import('./pages/workspace/collection/index'),
    Component: Collection,
  },
  {
    path: "/collection/:collectionId",
    // lazy: () => import('./pages/workspace/collection/detail'),
    Component: CollectionDetail,
  },
  {
    path: "/tag",
    lazy: () => import("../modules/tag/view/legacy-catalog-redirect"),
  },
  {
    path: "/tags",
    Component: Tags,
  },
  {
    path: "/tag/:tagId",
    // lazy: () => import('./pages/workspace/tag/detail'),
    Component: TagDetail,
  },
  {
    path: "/journals",
    // lazy: () => import('./pages/workspace/journals'),
    Component: Journals,
  },
  {
    path: "/trash",
    lazy: () => import("./pages/workspace/trash"),
  },
  {
    path: "/:pageId",
    lazy: () => import("./pages/workspace/detail/mobile-detail-page"),
  },
  {
    path: "*",
    lazy: () => import("./pages/404"),
  },
] satisfies [RouteObject, ...RouteObject[]];
