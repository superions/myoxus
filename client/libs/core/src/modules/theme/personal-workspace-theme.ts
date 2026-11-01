// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  personalWorkspaceThemeQuery,
  resetPersonalWorkspaceThemeMutation,
  setPersonalWorkspaceThemeMutation,
} from "@myoxus/graphql";

import type { GraphQLService } from "../server";

export type PersonalWorkspaceThemeState = Awaited<
  ReturnType<typeof loadPersonalWorkspaceTheme>
>;

/**
 * Thin transport adapter for selecting an existing catalog theme on the
 * canonical personal workspace.
 *
 * The server owns persistence and authorization. This adapter deliberately
 * keeps no cache so it cannot become a second source of truth beside
 * `theme_profiles` and the runtime theme CSS endpoint. It does not model an
 * account theme preference or user-authored theme.
 */
export async function loadPersonalWorkspaceTheme(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
) {
  return graphqlService.gql({
    query: personalWorkspaceThemeQuery,
    variables: { workspaceId },
  });
}

export async function selectPersonalWorkspaceTheme(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
  themeSlug: string,
) {
  const response = await graphqlService.gql({
    query: setPersonalWorkspaceThemeMutation,
    variables: { input: { workspaceId, themeSlug } },
  });
  notifyRuntimeThemeUpdated();
  return response.setPersonalWorkspaceTheme;
}

export async function inheritPersonalWorkspaceTheme(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
) {
  const response = await graphqlService.gql({
    query: resetPersonalWorkspaceThemeMutation,
    variables: { workspaceId },
  });
  notifyRuntimeThemeUpdated();
  return response.resetPersonalWorkspaceTheme;
}

function notifyRuntimeThemeUpdated() {
  try {
    const channel = new BroadcastChannel("myoxus-branding");
    channel.postMessage("branding-updated");
    channel.close();
  } catch {
    // BroadcastChannel is unavailable in some test and embedded runtimes.
    // The persisted server profile remains authoritative and is loaded on the
    // next route/theme refresh.
  }
}
