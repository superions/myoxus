import type { WorkspaceServerService } from "@myoxus/core/modules/server";
import {
  getWorkspaceConfigQuery,
  getWorkspaceShareInviteLinkQuery,
  setEnableAiMutation,
  setEnableSharingMutation,
  setEnableUrlPreviewMutation,
  setWorkspacePublicByIdMutation,
  updateWorkspaceDescriptionMutation,
} from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

export class WorkspaceShareSettingStore extends Store {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  async fetchWorkspaceConfig(workspaceId: string, signal?: AbortSignal) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const data = await this.workspaceServerService.server.gql({
      query: getWorkspaceConfigQuery,
      variables: {
        id: workspaceId,
      },
      context: {
        signal,
      },
    });
    if (!data.workspace) {
      throw new Error("Workspace share settings not found");
    }
    let inviteLink = null;
    try {
      const inviteData = await this.workspaceServerService.server.gql({
        query: getWorkspaceShareInviteLinkQuery,
        variables: { id: workspaceId },
        context: { signal },
      });
      inviteLink = inviteData.workspace?.inviteLink ?? null;
    } catch {
      // Invite-link visibility is settings-scoped; normal workspace readers
      // still consume the public-delivery projection from the base query.
    }
    return { ...data.workspace, inviteLink };
  }

  async updateWorkspaceEnableAi(
    workspaceId: string,
    enableAi: boolean,
    signal?: AbortSignal,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    await this.workspaceServerService.server.gql({
      query: setEnableAiMutation,
      variables: {
        id: workspaceId,
        enableAi,
      },
      context: {
        signal,
      },
    });
  }

  async updateWorkspaceEnableSharing(
    workspaceId: string,
    enableSharing: boolean,
    signal?: AbortSignal,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    await this.workspaceServerService.server.gql({
      query: setEnableSharingMutation,
      variables: {
        id: workspaceId,
        enableSharing,
      },
      context: {
        signal,
      },
    });
  }

  async updateWorkspacePublic(
    workspaceId: string,
    publicAccess: boolean,
    signal?: AbortSignal,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    await this.workspaceServerService.server.gql({
      query: setWorkspacePublicByIdMutation,
      variables: {
        id: workspaceId,
        public: publicAccess,
      },
      context: {
        signal,
      },
    });
  }

  async updateWorkspaceDescription(
    workspaceId: string,
    description: string,
    signal?: AbortSignal,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    await this.workspaceServerService.server.gql({
      query: updateWorkspaceDescriptionMutation,
      variables: { id: workspaceId, description },
      context: { signal },
    });
  }

  async updateWorkspaceEnableUrlPreview(
    workspaceId: string,
    enableUrlPreview: boolean,
    signal?: AbortSignal,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    await this.workspaceServerService.server.gql({
      query: setEnableUrlPreviewMutation,
      variables: {
        id: workspaceId,
        enableUrlPreview,
      },
      context: {
        signal,
      },
    });
  }
}
