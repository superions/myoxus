// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkspaceServerService } from "@myoxus/core/modules/server";
import type { Workspace } from "@myoxus/core/modules/workspace";
import {
  workspaceOverviewQuery,
  workspaceOverviewSettingsQuery,
  type WorkspaceOverviewSettingsQuery,
} from "@myoxus/graphql";
import { useEffect, useReducer, useRef, useState } from "react";
import useSWR from "swr";
import type { OverviewRegisterPresentation } from "./presentation";
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
  registerPresentation,
  sourceWorkspaceId = workspace.id,
  enabled = true,
  permissionChanges,
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
  registerPresentation?: OverviewRegisterPresentation;
  sourceWorkspaceId?: string;
  enabled?: boolean;
  permissionChanges?: {
    subscribe: (callback: () => void) => { unsubscribe: () => void };
  };
}) {
  const identity =
    server && accountId
      ? [server.id, server.baseUrl, accountId, sourceWorkspaceId]
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
  // Observe the existing settings cache, populated only by its authorized dialog.
  // Reading an overview must not require permission to edit workspace settings.
  const settings = useSWR<WorkspaceOverviewSettingsQuery>(
    identity ? [workspaceOverviewSettingsQuery.id, ...identity] : null,
    null,
    options,
  );
  const [online, setOnline] = useState(navigator.onLine);
  const [organizerGeneration, advanceOrganizer] = useReducer(
    (value: number) => value + 1,
    0,
  );
  useEffect(() => {
    const refresh = () => advanceOrganizer();
    folders.on("update", refresh);
    workspace.rootYDoc.on("update", refresh);
    const subscription = permissionChanges?.subscribe(refresh);
    const network = () => {
      setOnline(navigator.onLine);
      refresh();
    };
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => {
      subscription?.unsubscribe();
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
      folders.off("update", refresh);
      workspace.rootYDoc.off("update", refresh);
    };
  }, [folders, workspace, permissionChanges]);
  const configuration = settings.data?.workspace?.overviewSettings;
  const scope = JSON.stringify([
    identity,
    folderId,
    configuration?.revision,
    registerPresentation,
    online,
    enabled,
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
    if (!server || !accountId) return;
    const changed =
      previousScope.current !== undefined && previousScope.current !== scope;
    previousScope.current = scope;
    if (changed && offset) onResetPage();
  }, [scope, offset, onResetPage, server, accountId]);
  const read = useSWR(
    identity && online && enabled
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
        variables: {
          id: sourceWorkspaceId,
          folderId,
          registerPresentation,
          offset: effectiveOffset,
        },
      });
    },
    options,
  );
  return {
    ...read,
    error: !online
      ? unavailableOverview
      : (read.error ??
        (read.data && !read.data.workspace?.overview
          ? unavailableOverview
          : undefined)),
    isLoading: read.isLoading,
    offline: !online,
    isValidating: read.isValidating,
    refresh: () => read.mutate(),
  };
}
