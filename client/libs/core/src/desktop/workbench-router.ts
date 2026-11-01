/**
 * Workbench route manifest.
 *
 * Defines the routes rendered inside the workbench (the tabbed content area
 * within a workspace). These routes are nested under the workspace shell and
 * share the sidebar and header — they are NOT top-level browser routes.
 *
 * All entries are lazily loaded. The workbench uses these routes to determine
 * which view to render in each tab. The path prefix for each route is relative
 * to the workspace base path (e.g. `/workspace/:id`).
 *
 * Route map:
 * | Path                              | View                        |
 * |-----------------------------------|-----------------------------|
 * | `/chat`                           | AI chat workspace view      |
 * | `/home`                           | Workspace dashboard         |
 * | `/overview`                       | Workspace overview          |
 * | `/all`                            | All docs browser            |
 * | `/collection`                     | All collections list        |
 * | `/tags`                           | Workspace tag catalog       |
 * | `/templates`                      | Workspace template library  |
 * | `/tag/:tagId`                     | Single tag detail           |
 * | `/databases`                      | Workspace database index    |
 * | `/databases/:databaseId`          | Workspace database detail   |
 * | `/inbox`                          | Persistent activity inbox   |
 * | `/trash`                          | Trash (recycle bin)         |
 * | `/:pageId`                        | Document detail editor      |
 * | `/:pageId/attachments/:attachmentId` | Attachment viewer        |
 * | `/journals`                       | Journal / daily notes       |
 * | `/diagrams`                       | Diagram workspace           |
 * | `/settings`                       | Workspace settings          |
 * | `*`                               | 404 fallback                |
 */
import type { RouteObject } from "react-router";

export const workbenchRoutes = [
  {
    path: "/",
    lazy: () => import("./pages/workspace/home/redirect"),
  },
  {
    path: "/home",
    lazy: () => import("./pages/workspace/home"),
  },
  {
    path: "/overview",
    lazy: () => import("./pages/workspace/overview"),
  },
  {
    path: "/chat",
    lazy: () => import("./pages/workspace/chat/index"),
  },
  {
    path: "/all",
    lazy: () => import("./pages/workspace/all-page/all-page"),
  },
  {
    path: "/collection",
    lazy: () => import("./pages/workspace/all-collection"),
  },
  {
    path: "/tag",
    lazy: () => import("../modules/tag/view/legacy-catalog-redirect"),
  },
  {
    path: "/tags",
    lazy: () => import("./pages/workspace/tags"),
  },
  {
    path: "/templates",
    lazy: () => import("./pages/workspace/templates"),
  },
  {
    path: "/tag/:tagId",
    lazy: () => import("./pages/workspace/tag"),
  },
  {
    path: "/tasks",
    lazy: () => import("./pages/workspace/tasks"),
  },
  {
    path: "/databases",
    lazy: () => import("./pages/workspace/databases"),
  },
  {
    path: "/databases/:databaseId",
    lazy: () => import("./pages/workspace/database"),
  },
  {
    path: "/inbox",
    lazy: () => import("./pages/workspace/inbox"),
  },
  {
    path: "/trash",
    lazy: () => import("./pages/workspace/trash-page"),
  },
  {
    path: "/:pageId",
    lazy: () => import("./pages/workspace/detail-page/detail-page"),
  },
  {
    path: "/:pageId/attachments/:attachmentId",
    lazy: () => import("./pages/workspace/attachment/index"),
  },
  {
    path: "/journals",
    lazy: () => import("./pages/workspace/journals"),
  },
  {
    path: "/diagrams",
    lazy: () => import("./pages/workspace/diagrams"),
  },
  {
    path: "/settings",
    lazy: () => import("./pages/workspace/settings"),
  },
  {
    path: "*",
    lazy: () => import("./pages/404"),
  },
] satisfies RouteObject[];
