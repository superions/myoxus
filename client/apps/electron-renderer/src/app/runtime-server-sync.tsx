// SPDX-License-Identifier: AGPL-3.0-or-later

import { GlobalContextService } from "@myoxus/core/modules/global-context";
import {
  DefaultServerService,
  ServersService,
} from "@myoxus/core/modules/server";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { useLiveData, useService } from "@myoxus/infra";
import { getRuntimeWorkspaceIdFromPathname } from "@myoxus/theme";
import { useEffect } from "react";

/** Core owns workspace/server resolution. Publish that existing identity into
 * the existing tab metadata so App, Shell and Popup consume the same owner.
 * Local workspaces must not inherit the last cloud workspace's theme. */
export function DesktopRuntimeServerSync() {
  const context = useService(GlobalContextService).globalContext;
  const contextId = useLiveData(context.serverId.$);
  const flavour = useLiveData(context.workspaceFlavour.$);
  const workspaceId = useLiveData(context.workspaceId.$);
  const selected = useLiveData(useService(DefaultServerService).server$);
  const servers = useLiveData(useService(ServersService).servers$);
  const routedWorkspace = getRuntimeWorkspaceIdFromPathname();
  // During workspace bootstrap, the global default is not proof of ownership.
  // Wait for Core's workspace and server contexts to agree before publishing.
  const candidate = routedWorkspace
    ? workspaceId === routedWorkspace &&
      flavour !== "local" &&
      flavour === contextId
      ? contextId
      : null
    : (contextId ?? selected?.id);
  // Null proves a resolved local workspace; undefined means unresolved.
  // Recording must never bind a bootstrapping cloud workspace as local.
  const serverId =
    routedWorkspace && workspaceId === routedWorkspace && flavour === "local"
      ? null
      : servers.some((server) => server.id === candidate)
        ? candidate!
        : undefined;

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (bridge?.appInfo.viewId) {
      void bridge.apis.ui
        .updateWorkbenchMeta(bridge.appInfo.viewId, { serverId })
        .catch(console.error);
    }
  }, [serverId]);
  return null;
}
