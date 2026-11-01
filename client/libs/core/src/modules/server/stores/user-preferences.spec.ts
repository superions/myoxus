// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AssistanceMode,
  AssistanceSource,
  getUserAssistanceQuery,
} from "@myoxus/graphql";
import { Framework, MemoryMemento } from "@myoxus/infra";
import { expect, test, vi } from "vitest";
import { GlobalState } from "../../storage";
import { GraphQLService } from "../services/graphql";
import { UserPreferencesStore } from "./user-preferences";

test("a contextual response from a different current cookie actor cannot confirm the opening person's mode", async () => {
  const gql = vi.fn(async () => ({
    currentUser: {
      id: "actor-b",
      preferences: {
        assistance: {
          mode: AssistanceMode.Automatic,
          source: AssistanceSource.Workspace,
          userDefaultExplicit: true,
          interactiveMode: AssistanceMode.Automatic,
        },
      },
    },
  }));
  const framework = new Framework();
  framework
    .impl(GlobalState, new MemoryMemento())
    .service(GraphQLService, { gql } as unknown as GraphQLService)
    .store(UserPreferencesStore, [GraphQLService, GlobalState]);
  const store = framework.provider().get(UserPreferencesStore);
  try {
    await expect(
      store.getAssistance("workspace-a", undefined, "actor-a"),
    ).rejects.toThrow("owner changed");
    expect(gql).toHaveBeenCalledWith({
      query: getUserAssistanceQuery,
      variables: { workspaceId: "workspace-a", projectId: undefined },
    });
  } finally {
    store.dispose();
  }
});
