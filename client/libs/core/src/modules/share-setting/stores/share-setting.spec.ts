/**
 * @vitest-environment happy-dom
 */

import {
  getWorkspaceConfigQuery,
  getWorkspaceShareInviteLinkQuery,
} from "@myoxus/graphql";
import { Framework } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { WorkspaceServerService } from "../../server";
import { WorkspaceShareSettingStore } from "./share-setting";

describe("WorkspaceShareSettingStore", () => {
  test("keeps public workspace state available when invite-link access is denied", async () => {
    const workspace = {
      name: "Public notes",
      description: "A reader-visible overview",
      public: true,
      publicDeliveryEnabled: true,
      publiclyAccessible: true,
      enableAi: false,
      enableSharing: true,
      enableUrlPreview: false,
      enableDocEmbedding: false,
    };
    const gql = vi.fn(async ({ query }: { query: unknown }) => {
      if (query === getWorkspaceConfigQuery) {
        return { workspace };
      }
      if (query === getWorkspaceShareInviteLinkQuery) {
        throw new Error("Forbidden");
      }
      throw new Error("Unexpected GraphQL operation");
    });
    const framework = new Framework();
    framework
      .service(WorkspaceServerService, {
        server: { gql },
      } as unknown as WorkspaceServerService)
      .store(WorkspaceShareSettingStore, [WorkspaceServerService]);
    const store = framework.provider().get(WorkspaceShareSettingStore);

    await expect(store.fetchWorkspaceConfig("workspace-id")).resolves.toEqual({
      ...workspace,
      inviteLink: null,
    });
    expect(gql).toHaveBeenCalledTimes(2);
  });
});
