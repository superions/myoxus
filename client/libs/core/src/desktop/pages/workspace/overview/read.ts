// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkspaceServerService } from "@myoxus/core/modules/server";
import type { Workspace } from "@myoxus/core/modules/workspace";
import {
  workspaceOverviewQuery,
  workspaceOverviewSettingsQuery,
} from "@myoxus/graphql";
import { useEffect, useReducer, useRef } from "react";
import useSWR from "swr";
import type { Doc } from "yjs";

const unavailableOverview = new Error("Workspace overview is unavailable");

/** Reuse native lifecycle generations; no combined projection is persisted. */
export function useWorkspaceOverviewRead({
  server,
  accountId,
  workspace,
  folders,
  folderId,
  offset = 0,
  metadataGeneration,
  tagRevision,
  visibilityKey,
  onResetPage,
}: {
  server: WorkspaceServerService["server"] | undefined;
  accountId: string | undefined;
  workspace: Workspace;
  folders: Doc;
  folderId: string | null;
  offset?: number;
  metadataGeneration: number;
  tagRevision: number;
  visibilityKey: string;
  onResetPage: () => void;
}) {
  const identity =
    server && accountId
      ? [server.id, server.baseUrl, accountId, workspace.id]
      : null;
  const options = {
    suspense: false,
    keepPreviousData: false,
    revalidateOnMount: true,
    dedupingInterval: 0,
    shouldRetryOnError: false,
    suppressErrorNotification: true,
  } as const;
  // This is the configuration dialog's existing cache key and native contract.
  const settings = useSWR(
    identity ? [workspaceOverviewSettingsQuery.id, ...identity] : null,
    () =>
      server!.gql({
        query: workspaceOverviewSettingsQuery,
        variables: { id: workspace.id },
      }),
    options,
  );
  const [organizerGeneration, advanceOrganizer] = useReducer(
    (value: number) => value + 1,
    0,
  );
  useEffect(() => {
    const refresh = () => advanceOrganizer();
    folders.on("update", refresh);
    workspace.rootYDoc.on("update", refresh);
    return () => {
      folders.off("update", refresh);
      workspace.rootYDoc.off("update", refresh);
    };
  }, [folders, workspace]);
  const configuration = settings.data?.workspace?.overviewSettings;
  const scope = JSON.stringify([
    identity,
    folderId,
    configuration,
    organizerGeneration,
    metadataGeneration,
    tagRevision,
    visibilityKey,
  ]);
  const previousScope = useRef<string | undefined>(undefined);
  const changed =
    previousScope.current !== undefined && previousScope.current !== scope;
  const effectiveOffset = changed ? 0 : offset;
  useEffect(() => {
    if (!configuration || settings.error) return;
    const changed =
      previousScope.current !== undefined && previousScope.current !== scope;
    previousScope.current = scope;
    if (changed && offset) onResetPage();
  }, [scope, configuration, settings.error, offset, onResetPage]);
  const read = useSWR(
    identity && configuration && !settings.error
      ? [workspaceOverviewQuery.id, scope, effectiveOffset]
      : null,
    async () => {
      // Organizer updates precede their remote commit; wait for its native ACK.
      const signal = AbortSignal.timeout(30_000);
      await Promise.all(
        [folders.guid, workspace.rootYDoc.guid].map((id) =>
          workspace.engine.doc.waitForSynced(id, signal),
        ),
      );
      return server!.gql({
        query: workspaceOverviewQuery,
        variables: { id: workspace.id, folderId, offset: effectiveOffset },
      });
    },
    options,
  );
  return {
    ...read,
    error:
      settings.error ??
      read.error ??
      ((settings.data && !configuration) ||
      (read.data && !read.data.workspace?.overview)
        ? unavailableOverview
        : undefined),
    isLoading: settings.isLoading || read.isLoading,
    isValidating: settings.isValidating || read.isValidating,
    refresh: () => (settings.error ? settings.mutate() : read.mutate()),
  };
}
