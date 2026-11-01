// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegisterFindInPageCommands } from "@myoxus/core/components/hooks/myoxus/use-register-find-in-page-commands";
import { useRegisterWorkspaceCommands } from "@myoxus/core/components/hooks/use-register-workspace-commands";
import { useRegisterNavigationCommands } from "@myoxus/core/modules/navigation/view/use-register-navigation-commands";
import { QuickSearchContainer } from "@myoxus/core/modules/quicksearch";
import { ServerService } from "@myoxus/core/modules/server";
import { useLiveData, useService } from "@myoxus/infra";
import { lazy, Suspense } from "react";

const WorkspaceAIRuntime = lazy(async () => {
  const { WorkspaceAIRuntime } = await import("./workspace-ai-runtime");
  return { default: WorkspaceAIRuntime };
});

const WorkspaceCommandRuntime = () => {
  useRegisterWorkspaceCommands();
  useRegisterNavigationCommands();
  useRegisterFindInPageCommands();

  return <QuickSearchContainer />;
};

/**
 * Mounts workspace-scoped runtime integrations. The normal command/search path
 * stays small; editor-aware AI and template code is loaded only for servers
 * that actually advertise Copilot support.
 */
export const WorkspaceRuntime = () => {
  const server = useService(ServerService).server;
  const features = useLiveData(server.features$);

  return (
    <>
      <WorkspaceCommandRuntime />
      {features?.copilot ? (
        <Suspense fallback={null}>
          <WorkspaceAIRuntime />
        </Suspense>
      ) : null}
    </>
  );
};
