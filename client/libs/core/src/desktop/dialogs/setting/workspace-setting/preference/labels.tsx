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

type LabelProps = {
  value: string;
  status: WorkspaceStatus;
};

type WorkspaceStatusTone = "neutral" | "success" | "warning" | "info";

type LabelMap = {
  [key in WorkspaceStatus]: LabelProps;
};
type labelConditionsProps = {
  condition: boolean;
  label: WorkspaceStatus;
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
  const normalizedServerName = serverName?.trim();
  const normalizedBaseUrl = baseUrl?.trim();
  // Built-in product defaults are not instance names; prefer the selected URL
  // until the server exposes an operator-configured name.
  if (normalizedServerName && !GENERIC_SERVER_NAMES.has(normalizedServerName)) {
    return normalizedServerName;
  }
  return normalizedBaseUrl || normalizedServerName || fallback;
}

const Label = ({ value, status }: LabelProps) => {
  const toneByStatus: Record<WorkspaceStatus, WorkspaceStatusTone> = {
    availableOffline: "success",
    joinedWorkspace: "warning",
    local: "warning",
    publishedToWeb: "info",
    server: "info",
    selfHosted: "neutral",
    sharedWorkspace: "info",
  };
  return (
    <BadgeListItem data-status={status}>
      <Badge tone={toneByStatus[status]}>{value}</Badge>
    </BadgeListItem>
  );
};

const getConditions = (
  isOwner: boolean | null,
  flavour: string,
  isShared: boolean | null,
): labelConditionsProps[] => {
  return [
    { condition: !isOwner, label: "joinedWorkspace" },
    { condition: flavour === "local", label: "local" },
    {
      condition: flavour !== "local",
      label: "server",
    },
    {
      condition: !!isShared,
      label: "sharedWorkspace",
    },
  ];
};

const getLabelMap = (
  t: ReturnType<typeof useI18n>,
  serverDisplayName: string,
): LabelMap => ({
  local: {
    value: t["com.myoxus.settings.workspace.state.local"](),
    status: "local",
  },
  server: {
    value: serverDisplayName,
    status: "server",
  },
  selfHosted: {
    value: t["com.myoxus.settings.workspace.state.self-hosted"](),
    status: "selfHosted",
  },
  joinedWorkspace: {
    value: t["com.myoxus.settings.workspace.state.joined"](),
    status: "joinedWorkspace",
  },
  availableOffline: {
    value: t["com.myoxus.settings.workspace.state.available-offline"](),
    status: "availableOffline",
  },
  publishedToWeb: {
    value: t["com.myoxus.settings.workspace.state.published"](),
    status: "publishedToWeb",
  },
  sharedWorkspace: {
    value: t["com.myoxus.workspace.type.shared"](),
    status: "sharedWorkspace",
  },
});

export const LabelsPanel = () => {
  const workspace = useService(WorkspaceService).workspace;
  const server = workspace.scope.get(WorkspaceServerService).server;
  const serverConfig = useLiveData(server?.config$);
  const permissionService = useService(WorkspacePermissionService);
  const isOwner = useLiveData(permissionService.permission.isOwner$);
  const isShared = useLiveData(permissionService.permission.isShared$);
  const t = useI18n();

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

  const labelMap = useMemo(
    () => getLabelMap(t, serverDisplayName),
    [serverDisplayName, t],
  );

  const labelConditions = useMemo(
    () => getConditions(isOwner, workspace.flavour, isShared),
    [isOwner, isShared, workspace.flavour],
  );

  return (
    <BadgeList grow>
      {labelConditions.map(
        ({ condition, label }) =>
          condition && (
            <Label
              key={label}
              value={labelMap[label].value}
              status={labelMap[label].status}
            />
          ),
      )}
    </BadgeList>
  );
};
