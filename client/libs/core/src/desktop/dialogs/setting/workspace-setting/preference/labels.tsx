// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspacePermissionService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect, useMemo } from "react";

import { Badge, BadgeList, BadgeListItem } from "../../primitives";

type WorkspaceStatus =
  | "local"
  | "server"
  | "selfHosted"
  | "joinedWorkspace"
  | "availableOffline"
  | "sharedWorkspace"
  | "publishedToWeb";

type WorkspaceStatusTone = "neutral" | "success" | "warning" | "info";

const STATUS_TONE: Record<WorkspaceStatus, WorkspaceStatusTone> = {
  availableOffline: "success",
  joinedWorkspace: "warning",
  local: "warning",
  publishedToWeb: "info",
  server: "info",
  selfHosted: "neutral",
  sharedWorkspace: "info",
};

const GENERIC_SERVER_NAMES = new Set([
  "Myoxus Cloud",
  "Myoxus Server",
  "Myoxus Standalone",
]);

export function getWorkspaceServerDisplayName({
  baseUrl,
  fallback,
  serverName,
}: {
  baseUrl?: string | null;
  fallback: string;
  serverName?: string | null;
}) {
  const trimmedName = serverName?.trim();
  const trimmedUrl = baseUrl?.trim();
  // Prefer the configured server URL over generic built-in product defaults.
  if (trimmedName && !GENERIC_SERVER_NAMES.has(trimmedName)) {
    return trimmedName;
  }
  return trimmedUrl || trimmedName || fallback;
}

export const LabelsPanel = () => {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const server = workspace.scope.get(WorkspaceServerService).server;
  const serverConfig = useLiveData(server?.config$);
  const permissionService = useService(WorkspacePermissionService);
  const isOwner = useLiveData(permissionService.permission.isOwner$);
  const isShared = useLiveData(permissionService.permission.isShared$);

  useEffect(() => {
    permissionService.permission.revalidate();
  }, [permissionService]);

  const serverDisplayName = useMemo(
    () =>
      getWorkspaceServerDisplayName({
        baseUrl: server?.baseUrl,
        fallback: t["com.myoxus.settings.workspace.state.self-hosted"](),
        serverName: serverConfig?.serverName,
      }),
    [server?.baseUrl, serverConfig?.serverName, t],
  );

  const visibleBadges = useMemo(() => {
    const entries: Array<{ status: WorkspaceStatus; label: string }> = [];
    if (!isOwner) {
      entries.push({
        status: "joinedWorkspace",
        label: t["com.myoxus.settings.workspace.state.joined"](),
      });
    }
    if (workspace.flavour === "local") {
      entries.push({
        status: "local",
        label: t["com.myoxus.settings.workspace.state.local"](),
      });
    } else {
      entries.push({
        status: "server",
        label: serverDisplayName,
      });
    }
    if (isShared) {
      entries.push({
        status: "sharedWorkspace",
        label: t["com.myoxus.workspace.type.shared"](),
      });
    }
    return entries;
  }, [isOwner, isShared, serverDisplayName, t, workspace.flavour]);

  return (
    <BadgeList grow>
      {visibleBadges.map(({ status, label }) => (
        <BadgeListItem key={status} data-status={status}>
          <Badge tone={STATUS_TONE[status]}>{label}</Badge>
        </BadgeListItem>
      ))}
    </BadgeList>
  );
};
