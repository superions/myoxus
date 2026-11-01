// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { CopilotClient, setupAIProvider } from "@myoxus/core/editor/ai";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import {
  AuthService,
  EventSourceService,
  FetchService,
  GraphQLService,
} from "@myoxus/core/modules/server";
import { useService } from "@myoxus/infra";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useEffect } from "react";

const WorkspaceAIProviderRuntime = () => {
  const globalDialogService = useService(GlobalDialogService);
  const graphqlService = useService(GraphQLService);
  const fetchService = useService(FetchService);
  const eventSourceService = useService(EventSourceService);
  const authService = useService(AuthService);
  const workspaceService = useService(WorkspaceService);

  useEffect(
    () =>
      setupAIProvider(
        new CopilotClient(
          graphqlService.gql,
          eventSourceService.eventSource,
          fetchService.fetch,
        ),
        globalDialogService,
        authService,
        workspaceService,
      ),
    [
      authService,
      eventSourceService,
      fetchService,
      globalDialogService,
      graphqlService,
      workspaceService,
    ],
  );

  return null;
};

export const WorkspaceAIRuntime = WorkspaceAIProviderRuntime;
