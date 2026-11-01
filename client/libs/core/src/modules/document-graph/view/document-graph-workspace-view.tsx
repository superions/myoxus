import { useQuery } from "@myoxus/core/components/hooks/use-query";
import {
  type DocumentGraphSelection,
  normalizeDocumentGraphResponse,
} from "@myoxus/core/modules/document-graph/model";
import { DocumentGraphFlow } from "@myoxus/core/modules/document-graph/visual/graph-flow";
import {
  ViewContextSurface,
  ViewService,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { GuardService } from "@myoxus/core/modules/permissions";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import {
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import {
  DocumentGraphDirection,
  type DocumentGraphMetadataFilterInput,
  type DocumentGraphQuery,
  documentGraphQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { NetworkIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  EmptyState,
  EmptyStateTitle,
  Group,
  Loading,
  PageContentRail,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DocumentGraphDetails } from "./document-graph-details";
import { DocumentGraphToolbar } from "./document-graph-toolbar";
import { useDocumentGraphFilterOptions } from "./filter-options";

const GRAPH_QUERY_CONFIG = {
  suspense: false,
  suppressErrorNotification: true,
} as const;
const GRAPH_VIEW_FAMILY = ["graph"] as const;

export function DocumentGraphWorkspaceView() {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const workspaceId = workspace.id;
  const workspaces = useService(WorkspacesService);
  const { jumpToPage } = useNavigateHelper();
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const filterOptions = useDocumentGraphFilterOptions(workspaceId);
  const [direction, setDirection] = useState<DocumentGraphDirection>(
    DocumentGraphDirection.Both,
  );
  const [metadataFilter, setMetadataFilter] =
    useState<DocumentGraphMetadataFilterInput>();
  const [selection, setSelection] = useState<DocumentGraphSelection | null>(
    null,
  );
  const { data, error, isLoading } = useQuery(
    {
      query: documentGraphQuery,
      variables: {
        workspaceId,
        input: {
          direction,
          first: 100,
          includeOccurrences: false,
          metadataFilter: metadataFilter
            ? {
                statuses: metadataFilter.statuses,
                documentTypes: metadataFilter.documentTypes,
                classifications: metadataFilter.classifications,
              }
            : undefined,
        },
      },
    },
    GRAPH_QUERY_CONFIG,
  );
  const graph = useMemo(() => {
    const response = (data as DocumentGraphQuery | undefined)?.workspace
      ?.documentGraph;
    return response
      ? normalizeDocumentGraphResponse(response, workspaceId)
      : null;
  }, [data, workspaceId]);

  const openDocument = useCallback(
    async (docId: string, targetWorkspaceId: string) => {
      const opened =
        targetWorkspaceId !== workspaceId
          ? workspaces.openByWorkspaceId(targetWorkspaceId)
          : undefined;
      const target =
        targetWorkspaceId === workspaceId ? workspace : opened?.workspace;
      if (!target) return;
      try {
        if (!(await target.scope.get(GuardService).can("Doc_Read", docId)))
          return;
        if (targetWorkspaceId === workspaceId)
          workbench.openDoc(docId, { at: "active" });
        else jumpToPage(targetWorkspaceId, docId);
      } finally {
        opened?.dispose();
      }
    },
    [workbench, workspace, workspaceId, workspaces, jumpToPage],
  );
  const openDatabase = useCallback(
    (databaseId: string) =>
      workbench.open(`/databases/${databaseId}`, { at: "active" }),
    [workbench],
  );
  const select = useCallback((nextSelection: DocumentGraphSelection | null) => {
    setSelection(nextSelection);
  }, []);
  const showDetails = useCallback(() => {
    view.showTool("graph-details");
  }, [view]);

  useEffect(() => {
    if (!graph || !selection) return;
    const stillAvailable =
      selection?.kind === "document"
        ? graph.nodes.some((node) => node.key === selection.id)
        : selection?.kind === "database"
          ? graph.databases.some((database) => database.id === selection.id)
          : false;
    if (!stillAvailable) setSelection(null);
  }, [graph, selection]);

  useEffect(() => {
    if (selection) view.showDefaultTool("graph-details");
  }, [selection, view]);

  return (
    <>
      <PageContentRail
        fill
        scroll
        width="full"
        data-myoxus-ui-role="document-graph-content-rail"
      >
        {isLoading ? (
          <Group justify="center" data-testid="document-graph-loading">
            <Loading />
          </Group>
        ) : error ? (
          <EmptyState
            title={
              <EmptyStateTitle icon={<NetworkIcon />}>
                {t["com.myoxus.documentGraph.error.title"]()}
              </EmptyStateTitle>
            }
            description={t["com.myoxus.documentGraph.error.description"]()}
            data-testid="document-graph-error"
          />
        ) : !graph ||
          (graph.edges.length === 0 &&
            graph.databaseReferences.length === 0) ? (
          <EmptyState
            title={
              <EmptyStateTitle icon={<NetworkIcon />}>
                {t["com.myoxus.documentGraph.empty.title"]()}
              </EmptyStateTitle>
            }
            description={t["com.myoxus.documentGraph.empty.description"]()}
            data-testid="document-graph-empty"
          />
        ) : (
          <Stack
            flex="1 1 auto"
            mih={0}
            data-myoxus-ui-role="document-graph-workspace"
          >
            <DocumentGraphToolbar
              direction={direction}
              filterOptions={filterOptions.options}
              filterOptionsLoading={filterOptions.loading}
              graph={graph}
              metadataFilter={metadataFilter}
              selection={selection}
              onDirectionChange={setDirection}
              onMetadataFilterChange={setMetadataFilter}
              onSelect={select}
              onShowDetails={showDetails}
            />
            <DocumentGraphFlow
              graph={graph}
              selection={selection}
              onSelect={select}
              onOpenDocument={openDocument}
              onOpenDatabase={openDatabase}
              labels={{
                redacted: t["com.myoxus.documentGraph.state.redacted"](),
                deleted: t["com.myoxus.documentGraph.state.deleted"](),
                document: t["Page"](),
                database: t["com.myoxus.database.template.profile.database"](),
                edgeCount: (count) =>
                  t["com.myoxus.documentGraph.status.edges"]({
                    count: String(count),
                  }),
              }}
            />
          </Stack>
        )}
      </PageContentRail>
      {graph && selection ? (
        <ViewContextSurface
          surfaceId="graph-details"
          order={10}
          label={t["com.myoxus.documentGraph.title"]()}
          tooltip={t["com.myoxus.documentGraph.title"]()}
          icon={<NetworkIcon />}
          viewFamilies={GRAPH_VIEW_FAMILY}
        >
          <DocumentGraphDetails
            graph={graph}
            selection={selection}
            onOpenDocument={openDocument}
            onOpenDatabase={openDatabase}
          />
        </ViewContextSurface>
      ) : null}
    </>
  );
}
