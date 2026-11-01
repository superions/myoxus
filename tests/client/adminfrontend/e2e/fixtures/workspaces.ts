// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Workspace lifecycle helpers for adminfrontend E2E tests.
 *
 * The admin UI currently edits and links existing workspaces, but does not
 * expose a dedicated "create workspace" control. Scenarios that must exercise
 * workspace administration therefore create a real temporary workspace through
 * GraphQL, rename it through the admin contract, then verify/administer it in
 * the browser and delete it again in cleanup.
 */

import type { APIRequestContext } from "@playwright/test";

import { gqlRequest } from "./auth";

export async function createTemporaryWorkspace(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const created = await gqlRequest<{ createWorkspace: { id: string } }>(
    request,
    `mutation CreateTemporaryWorkspace {
      createWorkspace {
        id
      }
    }`,
  );
  const workspaceId = created.createWorkspace.id;
  await gqlRequest(
    request,
    `mutation RenameTemporaryWorkspace($input: AdminUpdateWorkspaceInput!) {
      admin {
        adminUpdateWorkspace(input: $input) {
          id
          name
        }
      }
    }`,
    { input: { id: workspaceId, name } },
  );
  return workspaceId;
}

export async function deleteWorkspace(
  request: APIRequestContext,
  workspaceId: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation DeleteTemporaryWorkspace($id: ID!) {
      admin {
        deleteWorkspace(id: $id)
      }
    }`,
    { id: workspaceId },
  ).catch(() => undefined);
}
