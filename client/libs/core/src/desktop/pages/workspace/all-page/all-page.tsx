/**
 * All-contents view — the workspace's typed content inventory
 * (`/workspace/:id/all`).
 *
 * Provides a filterable, sortable, and groupable list/grid/masonry view of all
 * non-trash documents in the current workspace. Key features:
 *
 * - **Saved filters**: user-specific filter shortcuts stored in
 *   `WorkspaceLocalState`. Selecting a saved filter scopes the document list to
 *   its persisted rules; "All" shows all non-trash, non-empty-journal docs.
 * - **Temporary filters**: the user can add ad-hoc filters without saving them
 *   first. A save button persists them as a personal saved filter.
 * - **Display preferences**: view mode (list / grid / masonry) and column
 *   layout are persisted per-mode to `WorkspaceLocalState` so each split-view
 *   tab starts with the last-used preference.
 * - **Typed inventory**: server workspaces combine Documents and Databases;
 *   Collections remain intentionally Document-scoped.
 * - **Multi-select**: `Escape` clears the selection mode.
 *
 * State is intentionally stored in local component state (initialised once
 * from `WorkspaceLocalState`) so that multiple split-pane all-docs tabs
 * maintain independent view states.
 */
import {
  createDocExplorerContext,
  DocExplorerContext,
} from "@myoxus/core/components/explorer/context";
import type { AllContentView } from "@myoxus/core/components/explorer/display-menu/view-toggle";
import { DocsExplorer } from "@myoxus/core/components/explorer/docs-view/docs-list";
import { WorkspacePagesExplorer } from "@myoxus/core/components/explorer/pages-view";
import type {
  ExplorerDisplayPreference,
  ExplorerPreviewSize,
} from "@myoxus/core/components/explorer/types";
import { Filters } from "@myoxus/core/components/filter";
import { EmptyCollectionDetail } from "@myoxus/core/components/myoxus/empty/collection-detail";
import { PageListNewPageButton } from "@myoxus/core/components/page-list/docs/page-list-new-page-button";
import { PageRegistrationRecovery } from "@myoxus/core/components/page-registration-recovery";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { AllDocsSavedFiltersService } from "@myoxus/core/modules/all-docs";
import {
  allDocsDefaultFilters,
  allDocsFavoriteFilter,
  allDocsFavoriteFilters,
  allDocsNavigationTo,
  parseAllDocsDisplayView,
  parseAllDocsNavigationSearch,
} from "@myoxus/core/modules/all-docs/navigation";
import { CollectionService } from "@myoxus/core/modules/collection";
import { CollectionRulesService } from "@myoxus/core/modules/collection-rules";
import type { FilterParams } from "@myoxus/core/modules/collection-rules/types";
import { getDatabaseWorkspaceAvailability } from "@myoxus/core/modules/database/availability";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import {
  type TemplateCategoryFilter,
  TemplateDocService,
  TemplateSuggestionSurface,
} from "@myoxus/core/modules/template-doc";
import { useTemplateApplicationAction } from "@myoxus/core/modules/template-doc/view/use-template-application";
import { ViewService, WorkbenchService } from "@myoxus/core/modules/workbench";
import {
  WorkspaceLocalState,
  WorkspaceService,
} from "@myoxus/core/modules/workspace";
import {
  composeWorkspacePageGroups,
  useDatabasePages,
} from "@myoxus/core/modules/workspace-pages";
import { inferOpenMode } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  Box,
  Button,
  FilterBar,
  Loading,
  Notice,
  PageContentRail,
  Stack,
  ToolbarSurface,
  usePromptModal,
} from "@myoxus/ui-facade";
import {
  lazy,
  type MouseEvent as ReactMouseEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  useIsActiveView,
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchToolLayoutBinding,
} from "../../../../modules/workbench";
import { AllDocsHeader } from "./all-page-header";
import { AllDocsSavedFilters } from "./saved-filters";
import {
  AllContentTagGroupFrame,
  AllContentTagCatalogState,
  isTagsGroupBy,
  tagsGroupBy,
  useAllContentTagScope,
} from "./tag-scope";

const DocumentGraphWorkspaceView = lazy(() =>
  import("@myoxus/core/modules/document-graph/view/document-graph-workspace-view").then(
    (module) => ({ default: module.DocumentGraphWorkspaceView }),
  ),
);

const genericTemplateFilter: TemplateCategoryFilter = {
  exclude: ["onboarding"],
};

/**
 * Default display preferences for each view mode.
 *
 * Applied when no persisted preference is found for the current mode. Each
 * entry specifies the default sort column (most-recently-updated), visible
 * metadata columns, group-by behaviour, and UI toggles (drag handle, quick
 * favourite button, etc.).
 */
const DefaultDisplayPreference: {
  [key in ViewMode]: ExplorerDisplayPreference;
} = {
  grid: {
    view: "grid",
    previewSize: "normal",
    displayProperties: [
      "system:createdAt",
      "system:updatedAt",
      "system:createdBy",
      "system:tags",
    ],
    orderBy: {
      type: "system",
      key: "updatedAt",
      desc: true,
    },
    groupBy: undefined,
    showDocIcon: true,
    showDocPreview: true,
    quickFavorite: true,
    showDragHandle: true,
    showMoreOperation: true,
  },
  masonry: {
    view: "masonry",
    previewSize: "normal",
    displayProperties: [
      "system:createdAt",
      "system:updatedAt",
      "system:createdBy",
      "system:tags",
    ],
    orderBy: {
      type: "system",
      key: "updatedAt",
      desc: true,
    },
    groupBy: undefined,
    showDocIcon: true,
    showDocPreview: true,
    quickFavorite: true,
    showDragHandle: true,
    showMoreOperation: true,
  },
  list: {
    view: "list",
    previewSize: "normal",
    displayProperties: [
      "system:createdAt",
      "system:updatedAt",
      "system:createdBy",
      "system:tags",
    ],
    orderBy: {
      type: "system",
      key: "updatedAt",
      desc: true,
    },
    groupBy: {
      type: "system",
      key: "updatedAt",
    },
    showDocIcon: true,
    showDocPreview: true,
    quickFavorite: true,
    showDragHandle: true,
    showMoreOperation: true,
  },
};

type ViewMode = NonNullable<ExplorerDisplayPreference["view"]>;

/**
 * All-pages workbench view component.
 *
 * Orchestrates saved-filter selection, temporary filter management, and display
 * preference changes. Subscribes to `CollectionRulesService` to compute the
 * document list reactively as filters/groups/order change, then pushes results
 * into `DocExplorerContext` for the typed inventory to consume.
 */
const AllDocsInventoryPage = ({
  displayPreference,
  setDisplayPreference,
  setViewMode,
  viewMode,
}: {
  displayPreference: ExplorerDisplayPreference;
  setDisplayPreference: (displayPreference: ExplorerDisplayPreference) => void;
  setViewMode: (viewMode: ViewMode) => void;
  viewMode: ViewMode;
}) => {
  const t = useI18n();

  const collectionService = useService(CollectionService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const globalContext = useService(GlobalContextService).globalContext;
  const savedFiltersService = useService(AllDocsSavedFiltersService);
  const workspaceService = useService(WorkspaceService);
  const docsService = useService(DocsService);
  const favoriteService = useService(FavoriteService);
  const templateDocService = useService(TemplateDocService);
  const workbench = useService(WorkbenchService).workbench;
  const regionalPreferences = useRegionalPreferences();
  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );
  const view = useService(ViewService).view;
  const activeAllDocsTarget = useLiveData(
    view.location$.selector((location) =>
      parseAllDocsNavigationSearch(location.search),
    ),
  );
  const selectedCollectionId =
    activeAllDocsTarget.kind === "collection"
      ? activeAllDocsTarget.collectionId
      : null;
  const selectedSavedFilterId =
    activeAllDocsTarget.kind === "savedFilter"
      ? activeAllDocsTarget.savedFilterId
      : null;
  const tagsActive = activeAllDocsTarget.kind === "tags";

  const isCollectionDataReady = useLiveData(
    collectionService.collectionDataReady$,
  );

  const savedFilters = useLiveData(savedFiltersService.savedFilters$);
  const selectedSavedFilter = useMemo(
    () =>
      selectedSavedFilterId
        ? (savedFilters.find((filter) => filter.id === selectedSavedFilterId) ??
          null)
        : null,
    [savedFilters, selectedSavedFilterId],
  );

  const selectedCollection = useLiveData(
    selectedCollectionId
      ? collectionService.collection$(selectedCollectionId)
      : null,
  );

  useEffect(() => {
    if (selectedSavedFilterId && !selectedSavedFilter) {
      view.replace(allDocsNavigationTo({ kind: "all" }));
    }
  }, [selectedSavedFilter, selectedSavedFilterId, view]);

  useEffect(() => {
    // if selected collection is not found, set selected collection id to null
    if (!selectedCollection && selectedCollectionId && isCollectionDataReady) {
      view.replace(allDocsNavigationTo({ kind: "all" }));
    }
  }, [isCollectionDataReady, selectedCollection, selectedCollectionId, view]);

  const selectedCollectionInfo = useLiveData(
    selectedCollection ? selectedCollection.info$ : null,
  );
  const selectedCollectionName = selectedCollectionInfo
    ? selectedCollectionInfo.name?.trim() || t["Untitled"]()
    : null;
  const creationAction = selectedCollection ? "collection" : "all-pages";
  const templateApplication = useTemplateApplicationAction(creationAction);
  const enablePageTemplate = useLiveData(
    templateDocService.setting.enablePageTemplate$,
  );
  const pageTemplateDocId = useLiveData(
    templateDocService.setting.pageTemplateDocId$,
  );
  const isActiveView = useIsActiveView();

  useEffect(() => {
    if (!isActiveView || !selectedCollection) {
      return;
    }

    globalContext.collectionId.set(selectedCollection.id);
    globalContext.isCollection.set(true);

    return () => {
      globalContext.collectionId.set(null);
      globalContext.isCollection.set(false);
    };
  }, [globalContext, isActiveView, selectedCollection]);

  const handleEditCollectionRules = useCallback(() => {
    if (!selectedCollectionId) {
      return;
    }
    track.collection.collection.$.editCollection();
    workspaceDialogService.open("collection-editor", {
      collectionId: selectedCollectionId,
      mode: "rule",
    });
  }, [selectedCollectionId, workspaceDialogService]);

  const [tempFilters, setTempFilters] = useState<FilterParams[] | null>(null);
  const [previewFilters, setPreviewFilters] = useState<FilterParams[] | null>(
    null,
  );
  const [tempFiltersInitial, setTempFiltersInitial] =
    useState<FilterParams | null>(null);

  const effectiveDocumentFilters = useMemo(
    () =>
      tempFilters !== null
        ? (previewFilters ?? tempFilters)
        : selectedSavedFilter
          ? selectedSavedFilter.filters
          : activeAllDocsTarget.kind === "favorites"
            ? allDocsFavoriteFilters
            : allDocsDefaultFilters,
    [
      activeAllDocsTarget.kind,
      previewFilters,
      selectedSavedFilter,
      tempFilters,
    ],
  );
  const databaseFilters = useMemo(
    () =>
      tempFilters !== null
        ? (previewFilters ?? tempFilters)
        : selectedSavedFilter
          ? selectedSavedFilter.filters
          : activeAllDocsTarget.kind === "favorites"
            ? [allDocsFavoriteFilter]
            : [],
    [
      activeAllDocsTarget.kind,
      previewFilters,
      selectedSavedFilter,
      tempFilters,
    ],
  );

  const effectiveDisplayPreference = useMemo(
    () =>
      tagsActive
        ? {
            ...displayPreference,
            groupBy: tagsGroupBy,
          }
        : displayPreference,
    [displayPreference, tagsActive],
  );

  const [explorerContextValue] = useState(() =>
    createDocExplorerContext(effectiveDisplayPreference),
  );

  useEffect(() => {
    explorerContextValue.displayPreference$.next(effectiveDisplayPreference);
  }, [effectiveDisplayPreference, explorerContextValue]);

  const groupBy = effectiveDisplayPreference.groupBy;
  const orderBy = effectiveDisplayPreference.orderBy;

  const { openPromptModal } = usePromptModal();

  const [documentGroups, setDocumentGroups] = useState<
    Array<{ key: string; items: string[] }>
  >([]);
  const documentMetadata$ = useMemo(
    () =>
      LiveData.computed((get) => {
        const records = get(docsService.list.docsMap$);
        return new Map(
          [...records.values()].map((record) => {
            const meta = get(record.meta$);
            return [
              record.id,
              {
                id: record.id,
                title: meta.title ?? "",
                createdAt: meta.createDate,
                updatedAt: meta.updatedDate,
              },
            ] as const;
          }),
        );
      }),
    [docsService],
  );
  const documentMetadata = useLiveData(documentMetadata$);
  const favoriteRecords = useLiveData(favoriteService.favoriteList.list$);
  const tagScope = useAllContentTagScope(documentGroups, tagsActive);
  const effectiveDocumentGroups = tagScope.groups;

  useEffect(() => {
    explorerContextValue.groups$.next(effectiveDocumentGroups);
  }, [effectiveDocumentGroups, explorerContextValue]);

  const databaseWorkspaceId = getDatabaseWorkspaceAvailability(
    workspaceService.workspace,
  ).serverWorkspaceId;
  const databaseLoad = useDatabasePages(
    selectedCollection || tagsActive ? null : databaseWorkspaceId,
  );
  const databaseFavorites = useMemo(
    () =>
      new Set(
        favoriteRecords
          .filter((favorite) => favorite.type === "database")
          .map((favorite) => favorite.id),
      ),
    [favoriteRecords],
  );
  const workspacePageGroups = useMemo(
    () =>
      composeWorkspacePageGroups({
        databaseFavorites,
        databases: databaseLoad.records,
        documentGroups: effectiveDocumentGroups,
        documentMetadata,
        filters: databaseFilters,
        groupBy,
        orderBy,
      }),
    [
      databaseFavorites,
      databaseFilters,
      databaseLoad.records,
      effectiveDocumentGroups,
      documentMetadata,
      groupBy,
      orderBy,
    ],
  );

  const collectionRulesService = useService(CollectionRulesService);
  const documentMetadataCache = useService(DocumentMetadataCacheService);
  const documentMetadataIndex = useLiveData(
    documentMetadataCache.watchIndexState(),
  );
  const documentMetadataIndexUnavailable =
    workspaceService.workspace.flavour !== "local" &&
    documentMetadataIndex.rows.length === 0 &&
    (documentMetadataIndex.phase === "unloaded" ||
      documentMetadataIndex.phase === "loading" ||
      documentMetadataIndex.phase === "error");
  const retryDocumentMetadataIndex = useCallback(() => {
    documentMetadataCache.invalidateIndex("all-pages-retry");
    void documentMetadataCache.hydrateIndex().catch(() => {
      // The reactive state retains the error for the visible retry surface.
    });
  }, [documentMetadataCache]);
  useEffect(() => {
    const subscription = collectionRulesService
      .watch(
        selectedCollectionInfo
          ? {
              filters: selectedCollectionInfo.rules.filters,
              groupBy,
              orderBy,
              extraAllowList: selectedCollectionInfo.allowList,
              extraFilters: [
                {
                  type: "system",
                  key: "empty-journal",
                  method: "is",
                  value: "false",
                },
                {
                  type: "system",
                  key: "trash",
                  method: "is",
                  value: "false",
                },
                {
                  type: "system",
                  key: "template",
                  method: "is",
                  value: "false",
                },
              ],
            }
          : {
              filters: effectiveDocumentFilters,
              groupBy,
              orderBy,
              extraFilters: [
                {
                  type: "system",
                  key: "empty-journal",
                  method: "is",
                  value: "false",
                },
                {
                  type: "system",
                  key: "trash",
                  method: "is",
                  value: "false",
                },
                {
                  type: "system",
                  key: "template",
                  method: "is",
                  value: "false",
                },
              ],
            },
      )
      .subscribe({
        next: (result) => {
          setDocumentGroups(result.groups);
        },
        error: (error) => {
          console.error(error);
        },
      });
    return () => {
      subscription.unsubscribe();
    };
  }, [
    collectionRulesService,
    groupBy,
    orderBy,
    selectedCollection,
    selectedCollectionInfo,
    effectiveDocumentFilters,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        explorerContextValue.selectMode$.next(false);
        explorerContextValue.selectedDocIds$.next([]);
        explorerContextValue.selectedItemKeys$.next([]);
        explorerContextValue.prevCheckAnchorId$.next(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [explorerContextValue]);

  const handleFilterChange = useCallback((filters: FilterParams[]) => {
    setTempFilters(filters);
  }, []);

  const handleSelectSavedFilter = useCallback(
    (savedFilterId: string) => {
      view.push(allDocsNavigationTo({ kind: "savedFilter", savedFilterId }));
      setTempFilters(null);
      setPreviewFilters(null);
      setTempFiltersInitial(null);
    },
    [view],
  );

  const handleRemoveSavedFilter = useCallback(
    (savedFilterId: string) => {
      const activeIndex = savedFilters.findIndex(
        (filter) => filter.id === savedFilterId,
      );
      const remainingFilters = savedFilters.filter(
        (filter) => filter.id !== savedFilterId,
      );
      const fallback =
        remainingFilters[Math.max(0, activeIndex - 1)] ?? remainingFilters[0];

      savedFiltersService.removeSavedFilter(savedFilterId);

      if (selectedSavedFilterId === savedFilterId && fallback) {
        view.push(
          allDocsNavigationTo({
            kind: "savedFilter",
            savedFilterId: fallback.id,
          }),
        );
      } else if (selectedSavedFilterId === savedFilterId) {
        view.push(allDocsNavigationTo({ kind: "all" }));
      }
    },
    [savedFilters, savedFiltersService, selectedSavedFilterId, view],
  );

  const handleSelectAll = useCallback(() => {
    view.push(allDocsNavigationTo({ kind: "all" }));
    setTempFilters(null);
    setPreviewFilters(null);
    setTempFiltersInitial(null);
  }, [view]);

  const handleSelectTags = useCallback(() => {
    view.push(allDocsNavigationTo({ kind: "tags" }));
    setTempFilters(null);
    setPreviewFilters(null);
    setTempFiltersInitial(null);
  }, [view]);

  const handleSaveFilters = useCallback(() => {
    if (selectedSavedFilterId && selectedSavedFilter) {
      savedFiltersService.updateSavedFilter(selectedSavedFilterId, {
        filters: tempFilters ?? [],
      });
      setTempFilters(null);
      setPreviewFilters(null);
      setTempFiltersInitial(null);
    } else {
      openPromptModal({
        title: t["com.myoxus.all-docs.saved-filters.save-title"](),
        label: t["com.myoxus.all-docs.saved-filters.name"](),
        inputOptions: {
          placeholder:
            t["com.myoxus.all-docs.saved-filters.name-placeholder"](),
        },
        children: t["com.myoxus.all-docs.saved-filters.save-description"](),
        confirmText: t["com.myoxus.all-docs.saved-filters.save-confirm"](),
        cancelText: t["Cancel"](),
        confirmButtonOptions: {
          variant: "primary",
        },
        onConfirm(name) {
          const savedFilter = savedFiltersService.createSavedFilter({
            name,
            filters: tempFilters ?? [],
          });
          setTempFilters(null);
          setPreviewFilters(null);
          setTempFiltersInitial(null);
          view.push(
            allDocsNavigationTo({
              kind: "savedFilter",
              savedFilterId: savedFilter.id,
            }),
          );
        },
      });
    }
  }, [
    openPromptModal,
    savedFiltersService,
    selectedSavedFilter,
    selectedSavedFilterId,
    t,
    tempFilters,
    view,
  ]);

  const handleEditSavedFilter = useCallback(() => {
    if (!selectedSavedFilter) {
      return;
    }

    openPromptModal({
      title: t["com.myoxus.all-docs.saved-filters.rename-title"](),
      label: t["com.myoxus.all-docs.saved-filters.name"](),
      defaultValue: selectedSavedFilter.name,
      inputOptions: {
        placeholder: t["com.myoxus.all-docs.saved-filters.name-placeholder"](),
      },
      confirmText: t["com.myoxus.all-docs.saved-filters.update-confirm"](),
      cancelText: t["Cancel"](),
      confirmButtonOptions: {
        variant: "primary",
      },
      onConfirm(name) {
        savedFiltersService.updateSavedFilter(selectedSavedFilter.id, { name });
      },
    });
  }, [openPromptModal, savedFiltersService, selectedSavedFilter, t]);

  const handleNewTempFilter = useCallback(
    (params: FilterParams) => {
      if (
        activeAllDocsTarget.kind !== "savedFilter" &&
        activeAllDocsTarget.kind !== "tags"
      ) {
        view.push(allDocsNavigationTo({ kind: "all" }));
      }
      setTempFilters([]);
      setPreviewFilters([params]);
      setTempFiltersInitial(params);
    },
    [activeAllDocsTarget.kind, view],
  );

  const handleDisplayPreferenceChange = useCallback(
    (nextDisplayPreference: ExplorerDisplayPreference) => {
      if (!tagsActive) {
        setDisplayPreference(nextDisplayPreference);
        return;
      }

      if (!isTagsGroupBy(nextDisplayPreference.groupBy)) {
        setDisplayPreference(nextDisplayPreference);
        view.replace(allDocsNavigationTo({ kind: "all" }));
        return;
      }

      setDisplayPreference({
        ...nextDisplayPreference,
        groupBy: displayPreference.groupBy,
      });
    },
    [displayPreference.groupBy, setDisplayPreference, tagsActive, view],
  );

  const handleInventoryViewChange = useCallback(
    (nextView: AllContentView) => {
      if (nextView === "graph") {
        view.replace(allDocsNavigationTo({ kind: "all" }, { view: "graph" }));
        return;
      }
      setViewMode(nextView);
    },
    [setViewMode, view],
  );

  const finishCreatedDoc = useCallback(
    (docId: string, event?: ReactMouseEvent | MouseEvent) => {
      selectedCollection?.addDoc(docId);
      workbench.openDoc(docId, { at: inferOpenMode(event) });
    },
    [selectedCollection, workbench],
  );
  const handleCreateBlank = useCallback(
    (mode?: "page" | "edgeless", event?: ReactMouseEvent | MouseEvent) => {
      const record = createPage(mode, { show: false });
      selectedCollection?.addDoc(record.id);
      workbench.openDoc(mode ? { docId: record.id, mode } : record.id, {
        at: inferOpenMode(event),
      });
    },
    [createPage, selectedCollection, workbench],
  );
  const handleCreateFromTemplate = useCallback(
    async (sourceDocId: string, event?: ReactMouseEvent | MouseEvent) => {
      const result = await templateApplication.apply(sourceDocId, {
        creationContext: {},
        date: new Date(),
        regionalPreferences,
      });
      if (!result.ok) return false;
      finishCreatedDoc(result.docId, event);
      return true;
    },
    [finishCreatedDoc, regionalPreferences, templateApplication.apply],
  );
  const handleCreateDefault = useCallback(
    async (event?: ReactMouseEvent | MouseEvent) => {
      if (enablePageTemplate && pageTemplateDocId) {
        return await handleCreateFromTemplate(pageTemplateDocId, event);
      } else {
        handleCreateBlank(undefined, event);
        return true;
      }
    },
    [
      enablePageTemplate,
      handleCreateBlank,
      handleCreateFromTemplate,
      pageTemplateDocId,
    ],
  );
  const createAction = (
    <PageListNewPageButton
      aria-busy={templateApplication.pending}
      data-myoxus-ui-role="all-docs-create-document"
      disabled={templateApplication.pending}
      onCreateDoc={handleCreateDefault}
      onCreatePage={(event) => handleCreateBlank("page", event)}
      onCreateEdgeless={(event) => handleCreateBlank("edgeless", event)}
      onCreateFromTemplate={handleCreateFromTemplate}
      size="small"
      templateCategoryFilter={genericTemplateFilter}
      templateSuggestionSurface={
        selectedCollection
          ? TemplateSuggestionSurface.CollectionNewPage
          : TemplateSuggestionSurface.AllPagesNewPage
      }
    >
      {t["New Page"]()}
    </PageListNewPageButton>
  );

  return (
    <DocExplorerContext.Provider value={explorerContextValue}>
      <ViewTitle title={selectedCollectionName ?? t["All content"]()} />
      <ViewIcon icon="allDocs" />
      <ViewHeader>
        <AllDocsHeader
          displayPreference={effectiveDisplayPreference}
          onEditCollectionRules={
            selectedCollection ? handleEditCollectionRules : undefined
          }
          onDisplayPreferenceChange={handleDisplayPreferenceChange}
          title={selectedCollectionName ?? undefined}
          view={viewMode}
          onViewChange={handleInventoryViewChange}
          includeGraph={
            activeAllDocsTarget.kind === "all" ||
            activeAllDocsTarget.kind === "tags"
          }
        />
      </ViewHeader>
      <ViewBody>
        <PageContentRail
          fill
          width="wide"
          data-myoxus-ui-role="all-docs-content-rail"
        >
          <Stack
            component="section"
            flex="1 1 auto"
            mih={0}
            miw={0}
            w="100%"
            data-testid="all-docs-body"
            data-myoxus-ui-role="all-docs-body-stack"
          >
            <PageRegistrationRecovery />
            {!selectedCollection ? (
              <AllDocsSavedFilters
                activeSavedFilterId={selectedSavedFilterId}
                allActive={
                  activeAllDocsTarget.kind === "all" && tempFilters === null
                }
                tagsActive={tagsActive}
                savedFilters={savedFilters}
                onActiveAll={handleSelectAll}
                onActiveTags={handleSelectTags}
                onActiveSavedFilter={handleSelectSavedFilter}
                onEditSavedFilter={handleEditSavedFilter}
                onRemoveSavedFilter={handleRemoveSavedFilter}
                onAddFilter={handleNewTempFilter}
                createAction={createAction}
                previewSize={
                  !selectedCollectionId &&
                  (viewMode === "grid" || viewMode === "masonry")
                    ? (displayPreference.previewSize ?? "normal")
                    : undefined
                }
                onPreviewSizeChange={(previewSize) =>
                  setDisplayPreference({ ...displayPreference, previewSize })
                }
                hiddenAdd={tempFilters !== null}
              />
            ) : (
              <FilterBar data-myoxus-ui-role="all-docs-create-bar">
                {createAction}
              </FilterBar>
            )}
            {!selectedCollection && tempFilters !== null ? (
              <ToolbarSurface
                justify="flex-start"
                data-myoxus-ui-role="all-docs-filter-editor-surface"
              >
                <Box flex="1 1 auto" miw={0}>
                  <Filters
                    // Reset the filter builder when the active saved filter changes.
                    key={selectedSavedFilterId ?? "all"}
                    filters={tempFilters}
                    onChange={handleFilterChange}
                    onPreviewChange={setPreviewFilters}
                    defaultDraftFilter={tempFiltersInitial}
                    includeAllPagesOnly
                  />
                </Box>
                <FilterBar data-myoxus-ui-role="all-docs-filter-actions">
                  <Button
                    variant="plain"
                    onClick={() => {
                      setTempFilters(null);
                      setPreviewFilters(null);
                      setTempFiltersInitial(null);
                    }}
                  >
                    {t["Cancel"]()}
                  </Button>
                  <Button onClick={handleSaveFilters}>{t["save"]()}</Button>
                </FilterBar>
              </ToolbarSurface>
            ) : null}
            {tagsActive ? (
              <AllContentTagCatalogState
                state={tagScope.catalogState}
                onRetry={tagScope.retry}
              />
            ) : null}
            {workspaceService.workspace.flavour !== "local" &&
            documentMetadataIndex.phase === "error" ? (
              <Notice
                title={t["com.myoxus.error.unexpected-error.title"]()}
                tone="error"
                data-testid="all-pages-document-metadata-error"
              >
                <Button
                  variant="secondary"
                  onClick={retryDocumentMetadataIndex}
                >
                  {t["Retry"]()}
                </Button>
              </Notice>
            ) : workspaceService.workspace.flavour !== "local" &&
              documentMetadataIndex.rows.length === 0 &&
              (documentMetadataIndex.phase === "loading" ||
                documentMetadataIndex.phase === "unloaded") ? (
              <Notice
                title={t["Loading"]()}
                data-testid="all-pages-document-metadata-loading"
              >
                <Loading />
              </Notice>
            ) : null}
            <Box
              display="flex"
              flex="1 1 auto"
              mih={0}
              miw={0}
              w="100%"
              data-myoxus-ui-role="all-docs-docs-viewport"
            >
              {documentMetadataIndexUnavailable ? null : selectedCollection &&
                selectedCollectionInfo?.allowList.length === 0 &&
                selectedCollectionInfo.rules.filters.length === 0 ? (
                <EmptyCollectionDetail collection={selectedCollection} />
              ) : selectedCollection ? (
                <DocsExplorer listScrollOwner="parent" />
              ) : tagsActive ? (
                tagScope.catalogState.status === "ready" ||
                tagScope.catalogState.tags.length > 0 ? (
                  <DocsExplorer
                    ListGroupFrameComponent={AllContentTagGroupFrame}
                    listScrollOwner="parent"
                    measuredCards
                    preserveEmptyGroups
                  />
                ) : null
              ) : databaseWorkspaceId ? (
                <WorkspacePagesExplorer
                  databases={databaseLoad.records}
                  groups={workspacePageGroups}
                  loadState={databaseLoad}
                  reload={databaseLoad.reload}
                  retry={databaseLoad.retry}
                  workspaceId={databaseWorkspaceId}
                />
              ) : BUILD_CONFIG.isWeb ? (
                <Notice
                  title={t["com.myoxus.database.server-backed-only.title"]()}
                  tone="error"
                >
                  {t["com.myoxus.database.server-backed-only.description"]()}
                </Notice>
              ) : (
                <DocsExplorer listScrollOwner="parent" measuredCards />
              )}
            </Box>
          </Stack>
        </PageContentRail>
      </ViewBody>
    </DocExplorerContext.Provider>
  );
};

export const AllPage = () => {
  const t = useI18n();
  const view = useService(ViewService).view;
  const { displayPreference, setDisplayPreference, setViewMode, viewMode } =
    useAllDocsOptions();
  const workspaceId = useService(WorkspaceService).workspace.id;
  const graphActive = useLiveData(
    view.location$.selector(
      (location) =>
        parseAllDocsNavigationSearch(location.search).kind === "all" &&
        parseAllDocsDisplayView(location.search) === "graph",
    ),
  );
  const handleGraphViewChange = useCallback(
    (nextView: AllContentView) => {
      if (nextView === "graph") return;
      setViewMode(nextView);
      view.replace(allDocsNavigationTo({ kind: "all" }));
    },
    [setViewMode, view],
  );

  if (!graphActive) {
    return (
      <AllDocsInventoryPage
        displayPreference={displayPreference}
        setDisplayPreference={setDisplayPreference}
        setViewMode={setViewMode}
        viewMode={viewMode}
      />
    );
  }

  return (
    <>
      <ViewTitle title={t["All content"]()} />
      <ViewIcon icon="allDocs" />
      <WorkbenchToolLayoutBinding
        workspaceId={workspaceId}
        viewFamily="graph"
      />
      <ViewHeader>
        <AllDocsHeader
          displayPreference={displayPreference}
          onDisplayPreferenceChange={setDisplayPreference}
          view="graph"
          onViewChange={handleGraphViewChange}
          includeGraph
        />
      </ViewHeader>
      <ViewBody>
        <Suspense
          fallback={
            <PageContentRail fill width="full">
              <Loading />
            </PageContentRail>
          }
        >
          <DocumentGraphWorkspaceView />
        </Suspense>
      </ViewBody>
    </>
  );
};
/** Lazy route entry point for the all-pages view. */
export const Component = () => {
  return <AllPage />;
};

/**
 * Manages the persistent display options for the all-docs page.
 *
 * State is intentionally initialised once from `WorkspaceLocalState` so that
 * multiple simultaneously open split-view all-docs tabs each maintain their
 * own independent state (rather than sharing a global atom that would force
 * all tabs to synchronise).
 *
 * Persists changes back to `WorkspaceLocalState` on every update so the
 * preferences survive page reloads. Navigation filters live in the Workbench
 * view URL, not this local option bucket, so sidebar links and split views can
 * represent the active All Docs filter explicitly.
 *
 * @returns An object containing the current view mode, display preference,
 *   and their respective setters.
 */
const useAllDocsOptions = () => {
  const workspaceLocalState = useService(WorkspaceLocalState);

  const readSavedViewMode = useCallback(() => {
    return workspaceLocalState.get<ViewMode>("allDocsMode") ?? "list";
  }, [workspaceLocalState]);

  const readSavedDisplayPreference = useCallback(
    (mode: ViewMode) => {
      const saved = workspaceLocalState.get<ExplorerDisplayPreference>(
        "allDocsDisplayPreference:" + mode,
      );
      return {
        ...DefaultDisplayPreference[mode],
        ...saved,
        view: mode,
        previewSize: isExplorerPreviewSize(saved?.previewSize)
          ? saved.previewSize
          : "normal",
      };
    },
    [workspaceLocalState],
  );

  const [viewMode, setViewMode] = useState(readSavedViewMode);
  const [displayPreference, setDisplayPreference] =
    useState<ExplorerDisplayPreference>(() =>
      readSavedDisplayPreference(viewMode),
    );
  const handleViewModeChange = useCallback(
    (mode: ViewMode) => {
      workspaceLocalState.set("allDocsMode", mode);
      setViewMode(mode);
      setDisplayPreference(readSavedDisplayPreference(mode));
    },
    [workspaceLocalState, readSavedDisplayPreference],
  );

  const handleDisplayPreferenceChange = useCallback(
    (displayPreference: ExplorerDisplayPreference) => {
      workspaceLocalState.set(
        "allDocsDisplayPreference:" + viewMode,
        displayPreference,
      );
      setDisplayPreference(displayPreference);
    },
    [viewMode, workspaceLocalState],
  );

  return {
    viewMode,
    setViewMode: handleViewModeChange,
    displayPreference,
    setDisplayPreference: handleDisplayPreferenceChange,
  };
};

function isExplorerPreviewSize(value: unknown): value is ExplorerPreviewSize {
  return value === "compact" || value === "normal" || value === "large";
}
