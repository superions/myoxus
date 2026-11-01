import type { SettingTab } from "@myoxus/core/modules/dialogs/constant";
import { toDocSearchParams } from "@myoxus/core/modules/navigation";
import { getOpenUrlInDesktopAppLink } from "@myoxus/core/modules/open-in-app";
import type { WorkspaceContentResourceKindType } from "@myoxus/graphql";
import type { DocMode } from "@virgultum/editor/model";
import { nanoid } from "nanoid";
import { createContext, useCallback, useContext, useMemo } from "react";
import type { NavigateFunction, NavigateOptions } from "react-router";

/**
 * In workbench, we use nested react-router, so default `useNavigate` can't get correct navigate function in workbench.
 * We use this context to provide navigate function for whole app.
 */
export const NavigateContext = createContext<NavigateFunction | null>(null);

export enum RouteLogic {
  REPLACE = "replace",
  PUSH = "push",
}

// TODO(@eyhn): add a name -> path helper in the results
/**
 * Use this for over workbench navigate, for navigate in workbench, use `WorkbenchService`.
 */
export function useNavigateHelper() {
  const navigate = useContext(NavigateContext);

  if (!navigate) {
    throw new Error("useNavigateHelper must be used within a NavigateProvider");
  }

  const jumpToPage = useCallback(
    (
      workspaceId: string,
      pageId: string,
      logic: RouteLogic = RouteLogic.PUSH,
    ) => {
      // External document keys are not UUID-only path fragments.
      return navigate(
        `/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(pageId)}`,
        {
          replace: logic === RouteLogic.REPLACE,
        },
      );
    },
    [navigate],
  );
  const jumpToPageBlock = useCallback(
    (
      workspaceId: string,
      pageId: string,
      mode?: DocMode,
      blockIds?: string[],
      elementIds?: string[],
      logic: RouteLogic = RouteLogic.PUSH,
    ) => {
      const search = toDocSearchParams({
        mode,
        blockIds,
        elementIds,
        refreshKey: nanoid(),
      });
      const query = search?.size ? `?${search.toString()}` : "";
      return navigate(`/workspace/${workspaceId}/${pageId}${query}`, {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToPageComment = useCallback(
    (
      workspaceId: string,
      pageId: string,
      commentId: string,
      mode: DocMode,
      logic: RouteLogic = RouteLogic.PUSH,
    ) => {
      const search = toDocSearchParams({
        mode,
        refreshKey: nanoid(),
        commentId,
      });
      const query = search?.size ? `?${search.toString()}` : "";
      return navigate(`/workspace/${workspaceId}/${pageId}${query}`, {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToCollections = useCallback(
    (workspaceId: string, logic: RouteLogic = RouteLogic.PUSH) => {
      return navigate(`/workspace/${workspaceId}/collection`, {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToDatabaseRow = useCallback(
    (workspaceId: string, databaseId: string, rowId: string) => {
      const search = new URLSearchParams({ rowId });
      return navigate(
        `/workspace/${workspaceId}/databases/${databaseId}?${search}`,
      );
    },
    [navigate],
  );
  const jumpToDatabase = useCallback(
    (
      workspaceId: string,
      databaseId: string,
      logic: RouteLogic = RouteLogic.PUSH,
    ) => {
      return navigate(`/workspace/${workspaceId}/databases/${databaseId}`, {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToWorkspaceHome = useCallback(
    (workspaceId: string, logic: RouteLogic = RouteLogic.PUSH) => {
      return navigate(`/workspace/${workspaceId}/home`, {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToWorkspaceOverview = useCallback(
    (
      workspaceId: string,
      logic: RouteLogic = RouteLogic.PUSH,
      folderId?: string,
    ) => {
      const search = folderId
        ? `?${new URLSearchParams({ folder: folderId })}`
        : "";
      return navigate(
        `/workspace/${encodeURIComponent(workspaceId)}/overview${search}`,
        {
          replace: logic === RouteLogic.REPLACE,
        },
      );
    },
    [navigate],
  );
  const jumpToTags = useCallback(
    (workspaceId: string, logic: RouteLogic = RouteLogic.PUSH) => {
      return navigate(`/workspace/${workspaceId}/tags`, {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToTag = useCallback(
    (
      workspaceId: string,
      tagId: string,
      logic: RouteLogic = RouteLogic.PUSH,
    ) => {
      return navigate(`/workspace/${workspaceId}/tag/${tagId}`, {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToCollection = useCallback(
    (
      workspaceId: string,
      collectionId: string,
      logic: RouteLogic = RouteLogic.PUSH,
    ) => {
      const search = new URLSearchParams({ collection: collectionId });
      return navigate(`/workspace/${workspaceId}/all?${search.toString()}`, {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToWorkspaceResource = useCallback(
    (resource: {
      workspaceId: string;
      kind: WorkspaceContentResourceKindType;
      id: string;
    }) => {
      switch (resource.kind) {
        case "Document":
          return jumpToPage(resource.workspaceId, resource.id);
        case "Database":
          return jumpToDatabase(resource.workspaceId, resource.id);
        case "Collection":
          return jumpToCollection(resource.workspaceId, resource.id);
        case "Tag":
          return jumpToTag(resource.workspaceId, resource.id);
        case "Folder":
          return jumpToWorkspaceOverview(
            resource.workspaceId,
            RouteLogic.PUSH,
            resource.id,
          );
        default:
          return jumpToWorkspaceHome(resource.workspaceId);
      }
    },
    [
      jumpToCollection,
      jumpToDatabase,
      jumpToPage,
      jumpToTag,
      jumpToWorkspaceHome,
      jumpToWorkspaceOverview,
    ],
  );

  const openPage = useCallback(
    (workspaceId: string, pageId: string, logic?: RouteLogic) => {
      return jumpToPage(workspaceId, pageId, logic);
    },
    [jumpToPage],
  );

  const jumpToIndex = useCallback(
    (logic: RouteLogic = RouteLogic.PUSH, opt?: { search?: string }) => {
      return navigate(
        { pathname: "/", search: opt?.search },
        {
          replace: logic === RouteLogic.REPLACE,
        },
      );
    },
    [navigate],
  );

  const jumpTo404 = useCallback(
    (logic: RouteLogic = RouteLogic.PUSH) => {
      return navigate("/404", {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToExpired = useCallback(
    (logic: RouteLogic = RouteLogic.PUSH) => {
      return navigate("/expired", {
        replace: logic === RouteLogic.REPLACE,
      });
    },
    [navigate],
  );
  const jumpToSignIn = useCallback(
    (
      redirectUri?: string,
      logic: RouteLogic = RouteLogic.PUSH,
      otherOptions?: Omit<NavigateOptions, "replace">,
      params?: Record<string, string>,
    ) => {
      const searchParams = new URLSearchParams();

      if (redirectUri) {
        searchParams.set("redirect_uri", redirectUri);
      }

      if (params) {
        for (const key in params) searchParams.set(key, params[key]);
      }

      return navigate(
        "/sign-in" +
          (searchParams.toString() ? "?" + searchParams.toString() : ""),
        {
          replace: logic === RouteLogic.REPLACE,
          ...otherOptions,
        },
      );
    },
    [navigate],
  );

  const jumpToOpenInApp = useCallback(
    (url: string, newTab = true) => {
      const deeplink = getOpenUrlInDesktopAppLink(url, newTab);

      if (!deeplink) {
        return;
      }

      const encodedUrl = encodeURIComponent(deeplink);
      return navigate(`/open-app/url?url=${encodedUrl}`);
    },
    [navigate],
  );

  const jumpToImportTemplate = useCallback(
    (name: string, snapshotUrl: string) => {
      return navigate(
        `/template/import?name=${encodeURIComponent(name)}&snapshotUrl=${encodeURIComponent(snapshotUrl)}`,
      );
    },
    [navigate],
  );

  const jumpToWorkspaceSettings = useCallback(
    (
      workspaceId: string,
      tab?: SettingTab,
      logic: RouteLogic = RouteLogic.PUSH,
    ) => {
      const searchParams = new URLSearchParams();
      if (tab) {
        searchParams.set("tab", tab);
      }
      return navigate(
        `/workspace/${workspaceId}/settings?${searchParams.toString()}`,
        {
          replace: logic === RouteLogic.REPLACE,
        },
      );
    },
    [navigate],
  );
  return useMemo(
    () => ({
      jumpToPage,
      jumpToPageBlock,
      jumpToPageComment,
      jumpToIndex,
      jumpTo404,
      openPage,
      jumpToExpired,
      jumpToSignIn,
      jumpToCollection,
      jumpToCollections,
      jumpToDatabaseRow,
      jumpToDatabase,
      jumpToWorkspaceHome,
      jumpToWorkspaceOverview,
      jumpToWorkspaceResource,
      jumpToTags,
      jumpToTag,
      jumpToOpenInApp,
      jumpToImportTemplate,
      jumpToWorkspaceSettings,
    }),
    [
      jumpToPage,
      jumpToPageBlock,
      jumpToPageComment,
      jumpToIndex,
      jumpTo404,
      openPage,
      jumpToExpired,
      jumpToSignIn,
      jumpToCollection,
      jumpToCollections,
      jumpToDatabaseRow,
      jumpToDatabase,
      jumpToWorkspaceHome,
      jumpToWorkspaceOverview,
      jumpToWorkspaceResource,
      jumpToTags,
      jumpToTag,
      jumpToOpenInApp,
      jumpToImportTemplate,
      jumpToWorkspaceSettings,
    ],
  );
}
