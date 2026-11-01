import type { WorkspaceServerService } from "@myoxus/core/modules/server";
import {
  type DocRole,
  getPageGrantedUsersListQuery,
  type GrantDocUserRolesInput,
  grantDocUserRolesMutation,
  type PaginationInput,
  revokeDocUserRolesMutation,
  type UpdateDocDefaultRoleInput,
  updateDocDefaultRoleMutation,
  updateDocUserRoleMutation,
} from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

export class DocGrantedUsersStore extends Store {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  async fetchDocGrantedUsersList(
    workspaceId: string,
    docId: string,
    pagination: PaginationInput,
    signal?: AbortSignal,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const res = await this.workspaceServerService.server.gql({
      query: getPageGrantedUsersListQuery,
      variables: {
        workspaceId,
        docId,
        pagination,
      },
      context: { signal },
    });

    const grantedUsersList = res.workspace?.doc?.grantedUsersList;
    if (!grantedUsersList) {
      throw new Error("Doc granted users not found");
    }
    return grantedUsersList;
  }

  async grantDocUserRoles(input: GrantDocUserRolesInput) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const res = await this.workspaceServerService.server.gql({
      query: grantDocUserRolesMutation,
      variables: {
        input,
      },
    });

    return res.grantDocUserRoles;
  }

  async revokeDocUserRoles(
    workspaceId: string,
    externalDocId: string,
    userId: string,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const res = await this.workspaceServerService.server.gql({
      query: revokeDocUserRolesMutation,
      variables: {
        input: {
          workspaceId,
          externalDocId,
          userIds: [userId],
        },
      },
    });

    return res.revokeDocUserRoles;
  }

  async updateDocUserRole(
    workspaceId: string,
    externalDocId: string,
    userId: string,
    role: DocRole,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const res = await this.workspaceServerService.server.gql({
      query: updateDocUserRoleMutation,
      variables: {
        input: {
          workspaceId,
          externalDocId,
          userId,
          role,
        },
      },
    });

    return res.updateDocUserRole;
  }

  async updateDocDefaultRole(input: UpdateDocDefaultRoleInput) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const res = await this.workspaceServerService.server.gql({
      query: updateDocDefaultRoleMutation,
      variables: {
        input,
      },
    });

    return res.updateDocDefaultRole;
  }
}
