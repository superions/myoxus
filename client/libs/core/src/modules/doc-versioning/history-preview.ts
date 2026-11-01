// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import type { DocHistory } from "@myoxus/core/modules/doc-versioning/history-data";
import { waitForDocumentVersionSync } from "@myoxus/core/modules/doc-versioning/document-sync";
import {
  prepareHistoryRestore,
  restoreHistory,
  type PreparedHistoryRestore,
  type HistoryRestoreTarget,
} from "@myoxus/core/modules/doc-versioning/restore-action";
import { FetchService, GraphQLService } from "@myoxus/core/modules/server";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import {
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { createReadonlySnapshotWorkspace } from "../doc/services/readonly-snapshot-workspace";
import { useService } from "@myoxus/infra";
import type { Store, Workspace } from "@virgultum/editor/store";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";

async function retrySnapshotRequest(revalidate: () => Promise<unknown>) {
  try {
    await revalidate();
  } catch (error) {
    console.warn("History snapshot reload failed", error);
  }
}

const snapshotFetcher = async ([fetch, workspaceId, pageDocId, snapshotId]: [
  FetchService["fetch"],
  workspaceId: string,
  pageDocId: string,
  snapshotId: string,
]) => {
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(pageDocId)}/histories/by-id/${encodeURIComponent(snapshotId)}`,
  );

  if (!res.ok) {
    throw new Error("Failed to fetch snapshot");
  }

  const snapshot = await res.arrayBuffer();
  if (!snapshot.byteLength) {
    throw new Error("Invalid snapshot");
  }
  return snapshot;
};

export const usePageHistory = (
  workspaceId: string,
  pageDocId: string,
  snapshotId?: string,
  visible = true,
) => {
  const fetchService = useService(FetchService);
  // The bound function is an opaque service identity; the service object would
  // make SWR serialize its framework and retain enormous snapshot keys.
  // Stored history is immutable; its workspace reference projection changes
  // after Move/Undo. Revalidate every selection and hide cached projections
  // until their current lineage has been fetched.
  const { data, error, mutate, isLoading, isValidating } = useSWR<ArrayBuffer>(
    snapshotId
      ? [fetchService.fetch, workspaceId, pageDocId, snapshotId]
      : null,
    {
      fetcher: snapshotFetcher,
      // SWR's structural comparison treats distinct ArrayBuffers as equal.
      // Every response owns a new projection even for the same history ID.
      compare: Object.is,
      revalidateOnMount: true,
      dedupingInterval: 0,
      revalidateOnFocus: visible,
      suspense: false,
      keepPreviousData: false,
      shouldRetryOnError: false,
    },
  );
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) void retrySnapshotRequest(mutate);
    wasVisible.current = visible;
  }, [visible, mutate]);
  return {
    data: isValidating ? undefined : data,
    error,
    retry: () => retrySnapshotRequest(mutate),
    isLoading: isLoading || isValidating,
  };
};

export const useSnapshotPage = (
  docCollection: Workspace,
  pageDocId: string,
  snapshotId?: string,
  visible = true,
) => {
  const myoxusWorkspace = useService(WorkspaceService).workspace;
  const workspacesService = useService(WorkspacesService);
  const featureFlagService = useService(FeatureFlagService);
  const { data: snapshot, ...state } = usePageHistory(
    docCollection.id,
    pageDocId,
    snapshotId,
    visible,
  );
  const [preview, setPreview] = useState<{
    snapshot: ArrayBuffer;
    key: string;
    page?: Store;
    error?: unknown;
  }>();
  const key = `${docCollection.id}:${pageDocId}:${snapshotId}`;
  useEffect(() => {
    if (!snapshotId || !snapshot) {
      return;
    }
    const historyShellWorkspace = createReadonlySnapshotWorkspace(
      docCollection.id,
      featureFlagService,
      workspacesService.getWorkspaceFlavourProvider(myoxusWorkspace.meta),
    );
    try {
      const page = historyShellWorkspace.loadSnapshot(
        pageDocId,
        new Uint8Array(snapshot),
      );
      setPreview({ snapshot, key, page });
    } catch (error) {
      setPreview({ snapshot, key, error });
    }
    return () => {
      historyShellWorkspace.dispose();
    };
  }, [
    snapshotId,
    pageDocId,
    docCollection.id,
    workspacesService,
    featureFlagService,
    myoxusWorkspace.meta,
    snapshot,
    key,
  ]);
  // A selection change hides the previous store in the same render, before the
  // effect creates its successor. A slow earlier request cannot relabel content.
  const current =
    preview?.key === key && preview.snapshot === snapshot ? preview : undefined;
  return {
    ...state,
    error: state.error ?? current?.error,
    page: current?.page,
  };
};

export const historyListGroupByDay = (
  histories: DocHistory[],
  formatDay: (timestamp: string) => string,
) => {
  const map = new Map<string, DocHistory[]>();
  for (const history of histories) {
    const day = formatDay(history.timestamp);
    const list = map.get(day) ?? [];
    list.push(history);
    map.set(day, list);
  }
  return [...map.entries()];
};

export const useRestorePage = (
  pageId: string,
  refreshHistory: () => Promise<unknown>,
) => {
  const workspace = useService(WorkspaceService).workspace;
  const graphql = useService(GraphQLService);
  const metadata = useService(DocumentMetadataCacheService);
  const [isMutating, setMutating] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const synchronize = () => waitForDocumentVersionSync(workspace, pageId);
  const refresh = () =>
    Promise.all([
      refreshHistory(),
      metadata.hydrateMetadata(pageId, undefined, { refresh: true }),
    ]);
  const prepare = async (target: HistoryRestoreTarget) => {
    setMutating(true);
    setRestoreError(null);
    try {
      return await prepareHistoryRestore(
        graphql,
        workspace.id,
        pageId,
        synchronize,
        target,
      );
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setMutating(false);
    }
  };
  const onRestore = async (prepared: PreparedHistoryRestore) => {
    setMutating(true);
    setRestoreError(null);
    try {
      const result = await restoreHistory(
        graphql,
        workspace.id,
        pageId,
        synchronize,
        prepared,
        refresh,
      );
      return result;
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setMutating(false);
    }
  };
  return { prepare, onRestore, refresh, isMutating, restoreError };
};
