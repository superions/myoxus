// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useMutateQueryResource,
  useMutation,
} from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import {
  DatabaseImportMenuSub,
  databaseRoute,
  type DatabaseRouteStatus,
  getDatabaseIndexRouteStatus,
  getDatabaseUnavailableWorkspaceRouteStatus,
  getDatabaseWorkspaceAvailability,
  useDatabaseImportController,
  WORKSPACE_DATABASE_PAGE_SIZE,
} from "@myoxus/core/modules/database";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { OrganizeService } from "@myoxus/core/modules/organize";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  collectWorkspaceFolderOptions,
  DatabasePagesService,
  linkDatabasePageToFolder,
} from "@myoxus/core/modules/workspace-pages";
import {
  createDatabaseFromTemplateMutation,
  DatabaseInventorySort,
  DatabaseProfileKind,
  ProjectStructurePreset,
  databasesQuery,
  databaseStarterTemplatesQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  DatabaseIcon,
  DatabaseTableViewIcon,
  ImportIcon,
  PlusIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  EmptyState,
  EmptyStateTitle,
  Group,
  HeaderMenuButton,
  Loading,
  MenuItem,
  MenuPanel,
  MenuSeparator,
  PageContentRail,
  WorkbenchHeaderFrame,
  WorkbenchHeaderTitle,
} from "@myoxus/ui-facade";
import {
  useRef,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "react-router";

import {
  consumeDatabaseCreationIntent,
  type CreationAssistantRequest,
  type CreationIntent,
  DatabaseCreationAssistant,
} from "./creation-assistant";
import {
  DatabaseInventory,
  type DatabaseInventorySortValue,
} from "./inventory";
import {
  type DatabaseInventoryScope,
  DatabaseInventoryScopeSwitcher,
} from "./inventory-scope-switcher";

const WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG = {
  // The index owns its P4 loading/error UI; Suspense would bypass that UI and
  // hand GraphQL failures to the Workbench error boundary.
  suspense: false,
  suppressErrorNotification: true,
} as const;

export function DatabasesHeaderMenuButton({
  createDatabaseIsMutating,
  csvBusy,
  jsonBusy,
  notionBusy,
  onCreateDatabase,
  onCreateProject,
  onImportCsv,
  onImportJson,
  onImportNotion,
}: {
  createDatabaseIsMutating: boolean;
  csvBusy: boolean;
  jsonBusy: boolean;
  notionBusy: boolean;
  onCreateDatabase: () => void;
  onCreateProject: () => void;
  onImportCsv: () => void;
  onImportJson: () => void;
  onImportNotion: () => void;
}) {
  const t = useI18n();
  return (
    <HeaderMenuButton
      ariaLabel={t["com.myoxus.common.open-menu"]()}
      data-testid="database-menu-trigger"
      items={
        <MenuPanel>
          <MenuItem
            prefixIcon={<DatabaseTableViewIcon />}
            disabled={createDatabaseIsMutating}
            onSelect={onCreateDatabase}
            data-testid="database-create-database"
          >
            {t["com.myoxus.database.create.database"]()}
          </MenuItem>
          <MenuItem
            prefixIcon={<DatabaseIcon />}
            disabled={createDatabaseIsMutating}
            onSelect={onCreateProject}
            data-testid="database-create-project"
          >
            {t["com.myoxus.database.create.project"]()}
          </MenuItem>
          <MenuSeparator />
          <DatabaseImportMenuSub
            csvBusy={csvBusy}
            jsonBusy={jsonBusy}
            notionBusy={notionBusy}
            onImportCsv={onImportCsv}
            onImportJson={onImportJson}
            onImportNotion={onImportNotion}
          />
        </MenuPanel>
      }
    />
  );
}

function DatabaseIndexRouteState({
  status,
}: {
  status: Exclude<DatabaseRouteStatus, "ready">;
}) {
  const t = useI18n();
  const title =
    status === "loading"
      ? t["com.myoxus.database.embed.loading"]()
      : status === "local-unavailable"
        ? t["com.myoxus.database.server-backed-only.title"]()
        : status === "forbidden"
          ? t["com.myoxus.database.selector.error-title"]()
          : status === "offline"
            ? t["com.myoxus.database.embed.offline"]()
            : t["com.myoxus.database.selector.error-title"]();
  const description =
    status === "loading"
      ? undefined
      : status === "local-unavailable"
        ? t["com.myoxus.database.server-backed-only.description"]()
        : status === "forbidden"
          ? t["com.myoxus.database.embed.forbidden"]()
          : t["com.myoxus.database.selector.error-description"]();

  if (status === "loading") {
    return (
      <Group justify="center" data-testid="database-index-loading">
        <Loading />
      </Group>
    );
  }

  return (
    <EmptyState
      title={<EmptyStateTitle icon={<DatabaseIcon />}>{title}</EmptyStateTitle>}
      description={description}
      data-testid={`database-index-${status}`}
    />
  );
}

export const DatabasesPage = () => {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const databasePagesService = useService(DatabasePagesService);
  const availability = getDatabaseWorkspaceAvailability(workspace);
  const workspaceId = availability.serverWorkspaceId;
  const workbench = useService(WorkbenchService).workbench;
  const [searchParams] = useSearchParams();
  const favoriteList = useService(FavoriteService).favoriteList;
  const revalidate = useMutateQueryResource();
  const projectCreationRetention =
    useRef<
      import("./creation-assistant/project-creation-assistant").ProjectCreationRetentionSlot["current"]
    >(undefined);
  const [page, setPage] = useState(0);
  const [inventorySearch, setInventorySearch] = useState("");
  const deferredSearch = useDeferredValue(inventorySearch.trim());
  const [inventoryScope, setInventoryScope] =
    useState<DatabaseInventoryScope>("all");
  const [inventorySort, setInventorySort] =
    useState<DatabaseInventorySortValue>("updated-desc");
  const favoriteRecords = useLiveData(favoriteList.list$);
  const favoriteDatabaseIds = useMemo(
    () =>
      favoriteRecords
        .filter((record) => record.type === "database")
        .map((record) => record.id),
    [favoriteRecords],
  );
  const favoriteDatabaseIdSet = useMemo(
    () => new Set(favoriteDatabaseIds),
    [favoriteDatabaseIds],
  );
  const inventoryProfileKind =
    inventoryScope === "database"
      ? DatabaseProfileKind.Generic
      : inventoryScope === "project"
        ? DatabaseProfileKind.Project
        : undefined;
  const inventorySortValue =
    inventorySort === "title-asc"
      ? DatabaseInventorySort.TitleAsc
      : inventorySort === "title-desc"
        ? DatabaseInventorySort.TitleDesc
        : DatabaseInventorySort.UpdatedDesc;
  const { data, error, isLoading } = useQuery(
    workspaceId
      ? {
          query: databasesQuery,
          variables: {
            workspaceId,
            first: WORKSPACE_DATABASE_PAGE_SIZE,
            offset: page * WORKSPACE_DATABASE_PAGE_SIZE,
            search: deferredSearch || undefined,
            profileKind: inventoryProfileKind,
            databaseIds:
              inventoryScope === "favorites" ? favoriteDatabaseIds : undefined,
            sort: inventorySortValue,
          },
        }
      : undefined,
    WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG,
  );
  const {
    data: starterTemplatesData,
    error: starterTemplatesError,
    isLoading: starterTemplatesLoading,
    mutate: retryStarterTemplates,
  } = useQuery(
    workspaceId
      ? {
          query: databaseStarterTemplatesQuery,
          variables: {
            workspaceId,
          },
        }
      : undefined,
    WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG,
  );
  const createDatabaseFromTemplate = useMutation(
    { mutation: createDatabaseFromTemplateMutation },
    { suppressErrorNotification: true },
  );
  const [creationIntent, setCreationIntent] = useState<CreationIntent | null>(
    null,
  );
  const [creationStructurePreset, setCreationStructurePreset] =
    useState<ProjectStructurePreset>();
  const organizerRoot = useService(OrganizeService).folderTree.rootFolder;
  const organizerRootChildren = useLiveData(organizerRoot.sortedChildren$);

  const routeStatus =
    availability.status === "available"
      ? getDatabaseIndexRouteStatus({
          dataLoaded: Boolean(data),
          error,
          hasWorkspace: Boolean(data?.workspace),
          isLoading,
        })
      : getDatabaseUnavailableWorkspaceRouteStatus({
          reason: availability.reason,
        });

  useEffect(() => {
    if (routeStatus !== "ready") return;
    const creationRequest = consumeDatabaseCreationIntent(searchParams);
    if (!creationRequest) return;

    // The route owns this transient hand-off. Removing it before the assistant
    // can close prevents refresh/back navigation from opening a second flow.
    const remainingQuery = creationRequest.remainingSearchParams.toString();
    workbench.open(`/databases${remainingQuery ? `?${remainingQuery}` : ""}`, {
      at: "active",
      replaceHistory: true,
    });
    setCreationStructurePreset(creationRequest.initialStructurePreset);
    setCreationIntent(creationRequest.intent);
  }, [routeStatus, searchParams, workbench]);
  const databases =
    routeStatus === "ready" ? (data?.workspace?.databases ?? []) : [];
  const starterTemplates =
    starterTemplatesData?.workspace?.databaseStarterTemplates ?? [];
  const organizerFolders = useMemo(() => {
    // Reading the live root children here keeps the flattened selector current;
    // the actual hierarchy and link mutations remain owned by OrganizeService.
    void organizerRootChildren;
    return collectWorkspaceFolderOptions(organizerRoot);
  }, [organizerRoot, organizerRootChildren]);

  const openDatabase = useCallback(
    (databaseId: string, viewId?: string | null, setupRequestId?: string) => {
      const route = databaseRoute(databaseId, viewId);
      const [path, query] = route.split("?");
      const search = new URLSearchParams(query);
      if (setupRequestId) search.set("projectSetup", setupRequestId);
      workbench.open(`${path}${search.size ? `?${search}` : ""}`, {
        at: "active",
        replaceHistory: true,
      });
    },
    [workbench],
  );
  const resetInventoryAfterImport = useCallback(() => {
    setPage(0);
    databasePagesService.invalidate();
  }, [databasePagesService]);
  const databaseImport = useDatabaseImportController({
    workspaceId: workspaceId ?? null,
    onImported: openDatabase,
    onApplied: resetInventoryAfterImport,
  });

  const openTemplateCreation = useCallback((intent: CreationIntent) => {
    setCreationStructurePreset(undefined);
    setCreationIntent(intent);
  }, []);

  const openProjectCreation = useCallback(() => {
    openTemplateCreation("project");
  }, [openTemplateCreation]);

  const changeInventorySearch = useCallback((search: string) => {
    setPage(0);
    setInventorySearch(search);
  }, []);

  const changeInventoryScope = useCallback((scope: DatabaseInventoryScope) => {
    setPage(0);
    setInventoryScope(scope);
  }, []);

  const changeInventorySort = useCallback(
    (sort: DatabaseInventorySortValue) => {
      setPage(0);
      setInventorySort(sort);
    },
    [],
  );

  const toggleDatabaseFavorite = useCallback(
    (databaseId: string) => {
      favoriteList.toggle("database", databaseId);
    },
    [favoriteList],
  );

  const onCreateFromTemplate = useCallback(
    async (request: CreationAssistantRequest) => {
      if (!workspaceId) {
        throw new Error(
          t["com.myoxus.database.server-backed-only.description"](),
        );
      }
      const response = await createDatabaseFromTemplate.trigger({
        input: {
          workspaceId,
          templateId: request.templateId,
          title: request.title,
          description: request.description,
          includeSampleRows: request.includeSampleRows,
          priorityPreset: request.priorityPreset,
          complexityPreset: request.complexityPreset,
          structurePreset: request.structurePreset,
          assistantConfirmation: request.assistantConfirmation,
        },
      });
      const databaseId = response.createDatabaseFromTemplate.database.id;

      // Creation already committed server-side. Inventory refresh failures must
      // never turn a successful response into a second create attempt.
      await Promise.allSettled([
        revalidate(
          databasesQuery,
          (variables) => variables.workspaceId === workspaceId,
        ),
      ]);
      setPage(0);
      databasePagesService.invalidate();
      return {
        databaseId,
        initialViewId: response.createDatabaseFromTemplate.initialViewId,
      };
    },
    [
      createDatabaseFromTemplate,
      databasePagesService,
      revalidate,
      t,
      workspaceId,
    ],
  );

  const linkCreatedDatabase = useCallback(
    async (databaseId: string, folderId: string) => {
      linkDatabasePageToFolder(organizerRoot, databaseId, folderId);
    },
    [organizerRoot],
  );

  const finishTemplateCreation = useCallback(
    (
      databaseId: string,
      initialViewId?: string | null,
      setupRequestId?: string,
    ) => {
      setCreationIntent(null);
      openDatabase(databaseId, initialViewId, setupRequestId);
    },
    [openDatabase],
  );

  return (
    <>
      <ViewTitle title={t["com.myoxus.database.index.title"]()} />
      <ViewIcon icon="collection" />
      <ViewHeader>
        <WorkbenchHeaderFrame
          left={
            routeStatus === "ready" ? (
              <DatabaseInventoryScopeSwitcher
                onChange={changeInventoryScope}
                value={inventoryScope}
              />
            ) : undefined
          }
          title={
            <WorkbenchHeaderTitle>
              {t["com.myoxus.database.index.title"]()}
            </WorkbenchHeaderTitle>
          }
          right={
            routeStatus === "ready" ? (
              <DatabasesHeaderMenuButton
                createDatabaseIsMutating={createDatabaseFromTemplate.isMutating}
                csvBusy={databaseImport.csvBusy}
                jsonBusy={databaseImport.jsonBusy}
                notionBusy={databaseImport.notionBusy}
                onCreateDatabase={() => openTemplateCreation("database")}
                onCreateProject={openProjectCreation}
                onImportCsv={databaseImport.openCsvPicker}
                onImportJson={databaseImport.openJsonPicker}
                onImportNotion={databaseImport.openNotionPicker}
              />
            ) : undefined
          }
        />
      </ViewHeader>
      <ViewBody>
        {routeStatus !== "ready" ? (
          <PageContentRail
            centerContent
            fill
            scroll
            data-testid="database-index"
          >
            <DatabaseIndexRouteState status={routeStatus} />
          </PageContentRail>
        ) : (
          <DatabaseInventory
            canGoNext={databases.length === WORKSPACE_DATABASE_PAGE_SIZE}
            emptyCta={
              <Group gap="xs" justify="center" wrap="wrap">
                <Button
                  prefix={<PlusIcon />}
                  onClick={() => openTemplateCreation("database")}
                  loading={createDatabaseFromTemplate.isMutating}
                >
                  {t["com.myoxus.database.create.database"]()}
                </Button>
                <Button
                  prefix={<DatabaseIcon />}
                  onClick={openProjectCreation}
                  loading={createDatabaseFromTemplate.isMutating}
                >
                  {t["com.myoxus.database.create.project"]()}
                </Button>
                <Button
                  prefix={<ImportIcon />}
                  variant="secondary"
                  onClick={databaseImport.openCsvPicker}
                  loading={databaseImport.csvBusy}
                >
                  {t["com.myoxus.database.csv-import.title"]()}
                </Button>
                <Button
                  prefix={<ImportIcon />}
                  variant="secondary"
                  onClick={databaseImport.openJsonPicker}
                  loading={databaseImport.jsonBusy}
                >
                  {t["com.myoxus.database.json-import.title"]()}
                </Button>
                <Button
                  prefix={<ImportIcon />}
                  variant="secondary"
                  onClick={databaseImport.openNotionPicker}
                  loading={databaseImport.notionBusy}
                >
                  {t["com.myoxus.database.notion-import.title"]()}
                </Button>
              </Group>
            }
            favoriteIds={favoriteDatabaseIdSet}
            isPristine={
              !deferredSearch && inventoryScope === "all" && page === 0
            }
            onOpen={openDatabase}
            onPageChange={setPage}
            onSearchChange={changeInventorySearch}
            onSortChange={changeInventorySort}
            onToggleFavorite={toggleDatabaseFavorite}
            page={page}
            records={databases}
            search={inventorySearch}
            sort={inventorySort}
          />
        )}
      </ViewBody>
      {creationIntent ? (
        <DatabaseCreationAssistant
          key={creationIntent}
          open
          intent={creationIntent}
          projectRetention={projectCreationRetention}
          initialStructurePreset={creationStructurePreset}
          templates={starterTemplates}
          templatesLoading={starterTemplatesLoading}
          templatesError={Boolean(starterTemplatesError)}
          folders={organizerFolders}
          creating={createDatabaseFromTemplate.isMutating}
          onOpenChange={(open) => {
            if (!open) setCreationIntent(null);
          }}
          onRetryTemplates={() => void retryStarterTemplates()}
          onCreate={onCreateFromTemplate}
          onLinkFolder={linkCreatedDatabase}
          onComplete={finishTemplateCreation}
        />
      ) : null}
      {databaseImport.surfaces}
    </>
  );
};

export const Component = () => <DatabasesPage />;
