// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { AiLoginRequiredModal } from "@myoxus/core/components/myoxus/auth/ai-login-required";
import { SWRConfigProvider } from "@myoxus/core/components/providers/swr-config-provider";
import { WorkspaceRuntime } from "@myoxus/core/components/providers/workspace-runtime";
import { WorkspaceContentOperationResume } from "@myoxus/core/components/workspace-content-operation/resume";
import { AIIsland } from "@myoxus/core/desktop/components/ai-island";
import { AppContainer } from "@myoxus/core/desktop/components/app-container";
import { DocumentTitle } from "@myoxus/core/desktop/components/document-title";
import { WorkspaceDialogs } from "@myoxus/core/desktop/dialogs/workspace";
import { PeekViewManagerModal } from "@myoxus/core/modules/peek-view";
import { QuotaCheck, QuotaUploadWatcher } from "@myoxus/core/modules/quota";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import type { PropsWithChildren } from "react";

function WorkspaceLayoutContainer({ children }: PropsWithChildren) {
  const workbench = useService(WorkbenchService).workbench;
  const currentPath = useLiveData(
    LiveData.computed(
      (get) => get(workbench.basename$) + get(workbench.location$).pathname,
    ),
  );

  return (
    <AppContainer data-current-path={currentPath}>{children}</AppContainer>
  );
}

export function WorkspaceLayout({ children }: PropsWithChildren) {
  const workspace = useService(WorkspaceService).workspace;

  return (
    <SWRConfigProvider>
      <WorkspaceContentOperationResume />
      <WorkspaceDialogs />
      {workspace?.flavour !== "local" ? (
        <>
          <QuotaCheck workspaceMeta={workspace.meta} />
          <QuotaUploadWatcher />
        </>
      ) : null}
      <AiLoginRequiredModal />
      <WorkspaceRuntime />
      <PeekViewManagerModal />
      <DocumentTitle />
      <WorkspaceLayoutContainer>{children}</WorkspaceLayoutContainer>
      <AIIsland />
    </SWRConfigProvider>
  );
}
