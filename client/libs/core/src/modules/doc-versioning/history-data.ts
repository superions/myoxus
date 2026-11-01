// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { GraphQLService } from "@myoxus/core/modules/server";
import { DebugLogger } from "@myoxus/debug";
import { I18n } from "@myoxus/i18n";
import {
  type ListHistoryQuery,
  listHistoryQuery,
  historyMetadataQuery,
  type HistoryMetadataQuery,
  historyDiffQuery,
  type HistoryDiffQuery,
} from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import type { Workspace } from "@myoxus/core/modules/workspace";
import { waitForDocumentVersionSync } from "./document-sync";

import {
  type DocumentVersion,
  type DocumentVersioningOverviewResponse,
  documentVersioningOverviewQuery,
} from "./types";

const logger = new DebugLogger("document-history");
const HISTORY_REFRESH_INTERVAL_MS = 30_000;

async function retryHistoryRequest(revalidate: () => Promise<unknown>) {
  try {
    await revalidate();
  } catch (error) {
    // SWR retains this error for the visible retry notice. Consuming the event
    // promise prevents a failed manual refresh from becoming unhandled too.
    logger.warn("History reload failed", error);
  }
}

function useHistoryVisibility(
  visible: boolean,
  refresh: () => Promise<unknown>,
) {
  const wasVisible = useRef(visible);
  useEffect(() => {
    // Completed history reads expire their dedupe entries immediately, so
    // mounting fetches fresh data; reopening a retained surface also refreshes.
    if (visible && !wasVisible.current) void retryHistoryRequest(refresh);
    wasVisible.current = visible;
  }, [visible, refresh]);
}

export type DocHistory = NonNullable<
  ListHistoryQuery["workspace"]
>["histories"][number];

export function historySourceI18nKey(origin: DocHistory["origin"]) {
  switch (origin) {
    case "manual":
      return "com.myoxus.history.source.manual" as const;
    case "automatic":
      return "com.myoxus.history.source.automatic" as const;
    case "publish":
      return "com.myoxus.history.source.publish" as const;
    case "pdf_export":
      return "com.myoxus.history.source.pdf-export" as const;
    case "daily":
      return "com.myoxus.history.source.daily" as const;
    case "api":
      return "com.myoxus.history.source.api" as const;
    case "restore":
      return "com.myoxus.history.source.restore" as const;
    case "recovery":
      return "com.myoxus.history.source.recovery" as const;
    default:
      return "com.myoxus.history.source.legacy" as const;
  }
}

export function sortNamedDocumentVersions(
  versions: DocumentVersion[],
): DocumentVersion[] {
  return [...versions].sort((a, b) => {
    return (
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.id.localeCompare(b.id)
    );
  });
}

export function getInitialPageHistorySnapshotId(
  histories: DocHistory[],
  namedVersions: DocumentVersion[],
): string | undefined {
  return (
    mergeHistorySnapshots(histories)[0]?.snapshotId ??
    sortNamedDocumentVersions(namedVersions)[0]?.docHistoryId
  );
}

/** Cursor pages can overlap after refresh. Snapshot IDs, not timestamps or
 * version IDs, own row identity; bigint IDs must remain strings. */
export function mergeHistorySnapshots(histories: DocHistory[]): DocHistory[] {
  return [
    ...new Map(
      histories.map((history) => [history.snapshotId, history]),
    ).values(),
  ].sort(
    (a, b) =>
      Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
      (BigInt(a.snapshotId) < BigInt(b.snapshotId)
        ? 1
        : BigInt(a.snapshotId) > BigInt(b.snapshotId)
          ? -1
          : 0),
  );
}

/** Shared paginated history owner for the recent context list and full view. */
export const useDocumentHistory = (
  workspaceId: string,
  pageDocId: string,
  namedOnly = false,
  visible = true,
) => {
  const pageSize = 10;
  const graphql = useService(GraphQLService);
  // Bound request functions keep service identity without SWR recursively
  // hashing the service's entire framework graph into every history key.
  const {
    data,
    error,
    mutate: refresh,
    size,
    setSize,
  } = useSWRInfinite<ListHistoryQuery>(
    (_, previousPageData) => {
      if (
        previousPageData &&
        (previousPageData.workspace?.histories.length ?? 0) < pageSize
      )
        return null;
      return [
        graphql.gql,
        listHistoryQuery.id,
        {
          pageDocId,
          workspaceId,
          cursor: previousPageData?.workspace?.histories.at(-1)?.cursor,
          take: pageSize,
          namedOnly,
        },
      ];
    },
    ([gql, , variables]) => gql({ query: listHistoryQuery, variables }),
    {
      suspense: false,
      shouldRetryOnError: false,
      refreshInterval: visible ? HISTORY_REFRESH_INTERVAL_MS : 0,
      refreshWhenHidden: false,
      revalidateOnFocus: visible,
      keepPreviousData: false,
      dedupingInterval: 0,
      revalidateOnMount: true,
    },
  );
  useHistoryVisibility(visible, refresh);
  const loadingMore = !!data && !data[size - 1];

  const shouldLoadMore = useMemo(() => {
    const lastPage = data?.at(-1);
    return (
      !!lastPage && (lastPage.workspace?.histories.length ?? 0) === pageSize
    );
  }, [data]);

  const histories = useMemo(
    () =>
      mergeHistorySnapshots(
        data?.flatMap((page) => page.workspace?.histories ?? []) ?? [],
      ),
    [data],
  );

  return [
    histories,
    shouldLoadMore
      ? () => {
          void retryHistoryRequest(() => setSize((current) => current + 1));
        }
      : false,
    !!loadingMore,
    {
      error,
      retry: () => retryHistoryRequest(refresh),
      refresh,
      loading: !data && !error,
    },
  ] as const;
};

const documentVersioningOverviewFetcher = async ([
  gql,
  _key,
  workspaceId,
  docId,
]: [
  GraphQLService["gql"],
  "documentVersioningOverview",
  string,
  string,
]): Promise<DocumentVersioningOverviewResponse> => {
  return gql({
    query: documentVersioningOverviewQuery,
    variables: { workspaceId, docId },
  });
};

/** One service-scoped read owns settings, references and metadata for both surfaces. */
export const useDocumentVersioningOverview = (
  graphQLService: GraphQLService,
  workspaceId: string,
  docId: string,
  visible = true,
) => {
  const { data, error, isValidating, mutate } =
    useSWR<DocumentVersioningOverviewResponse>(
      [graphQLService.gql, "documentVersioningOverview", workspaceId, docId],
      {
        fetcher: documentVersioningOverviewFetcher,
        revalidateOnMount: true,
        refreshInterval: visible ? HISTORY_REFRESH_INTERVAL_MS : 0,
        refreshWhenHidden: false,
        suspense: false,
        shouldRetryOnError: false,
        revalidateOnFocus: visible,
        keepPreviousData: false,
        dedupingInterval: 0,
      },
    );
  useHistoryVisibility(visible, mutate);

  return [
    data,
    (!data && !error) || isValidating,
    { error, retry: () => retryHistoryRequest(mutate), refresh: mutate },
  ] as const;
};

/** Capture metadata is independent of cursor pages and named-reference dates. */
export function useHistoryMetadata(
  workspaceId: string,
  docId: string,
  snapshotId?: string,
  visible = true,
) {
  const graphql = useService(GraphQLService);
  const state = useSWR<HistoryMetadataQuery>(
    snapshotId
      ? [graphql.gql, historyMetadataQuery.id, workspaceId, docId, snapshotId]
      : null,
    ([gql, , workspaceId, pageDocId, snapshotId]) =>
      gql({
        query: historyMetadataQuery,
        variables: { workspaceId, pageDocId, snapshotId },
      }),
    {
      suspense: false,
      revalidateOnMount: true,
      revalidateOnFocus: visible,
      refreshInterval: visible ? HISTORY_REFRESH_INTERVAL_MS : 0,
      refreshWhenHidden: false,
      keepPreviousData: false,
      shouldRetryOnError: false,
      dedupingInterval: 0,
    },
  );
  useHistoryVisibility(visible, state.mutate);
  return {
    metadata: state.data?.workspace?.history,
    loading: state.isLoading || state.isValidating,
    error: state.error,
    retry: () => retryHistoryRequest(state.mutate),
    refresh: state.mutate,
  };
}

/** The selected capture is always the source; acknowledged server state is the
 * only target. SWR fences concurrent revalidation and scope changes. */
export function useHistoryComparison(
  graphql: GraphQLService,
  workspace: Workspace,
  docId: string,
  snapshotId: string | undefined,
  visible: boolean,
) {
  const scope = useMemo(
    () => ({ graphql, workspace, docId, snapshotId }),
    [graphql, workspace, docId, snapshotId],
  );
  const [sync, setSync] = useState<{ scope: typeof scope; pending: boolean }>();
  const state = useSWR<HistoryDiffQuery>(
    snapshotId && visible
      ? [graphql.gql, historyDiffQuery.id, workspace.id, docId, snapshotId]
      : null,
    async ([gql, , workspaceId, pageDocId, selectedId]: [
      GraphQLService["gql"],
      string,
      string,
      string,
      string,
    ]) => {
      await waitForDocumentVersionSync(workspace, pageDocId);
      const response = await gql({
        query: historyDiffQuery,
        variables: { workspaceId, pageDocId, snapshotId: selectedId },
      });
      if (response.workspace?.historyDiff.snapshotId !== selectedId)
        throw new Error(
          I18n.t("com.myoxus.sidebar.document-versions.diff.compare-failed"),
        );
      return response;
    },
    {
      suspense: false,
      revalidateOnMount: true,
      revalidateOnFocus: visible,
      refreshInterval: visible ? HISTORY_REFRESH_INTERVAL_MS : 0,
      refreshWhenHidden: false,
      keepPreviousData: false,
      shouldRetryOnError: false,
      dedupingInterval: 0,
    },
  );
  useHistoryVisibility(visible, state.mutate);
  useEffect(() => {
    if (!visible || !snapshotId) return;
    let pending = false;
    const subscription = workspace.engine.doc
      .docState$(docId)
      .subscribe((next) => {
        const nextPending = !next.synced || next.updating;
        setSync({ scope, pending: nextPending });
        // Acknowledged writes invalidate even an in-flight older server read.
        if (pending && !nextPending) void retryHistoryRequest(state.mutate);
        pending = nextPending;
      });
    return () => subscription.unsubscribe();
  }, [workspace, docId, snapshotId, visible, scope, state.mutate]);
  const pending = sync?.scope === scope && sync.pending;
  return {
    comparison: pending ? undefined : state.data?.workspace?.historyDiff,
    pending,
    loading: state.isLoading || state.isValidating,
    error: state.error,
    retry: () => retryHistoryRequest(state.mutate),
  };
}
