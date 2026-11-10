// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  savedAssistantSetupsQuery,
  saveAssistantSetupMutation,
  deleteAssistantSetupMutation,
  resolveSavedAssistantSetupQuery,
  type SaveAssistantSetupInput,
  type GetUserAssistanceQuery,
  getUserAssistanceQuery,
  type GetUserPreferencesQuery,
  getUserPreferencesQuery,
  type UpdateUserPreferencesInput,
  updateUserPreferencesMutation,
  type WorkbenchToolId as GraphQLWorkbenchToolId,
  type WorkbenchToolLayoutInput,
  type WorkbenchViewFamily as GraphQLWorkbenchViewFamily,
  type WorkspaceDashboardDashletId as GraphQLWorkspaceDashboardDashletId,
  type WorkspaceDashboardDashletSize as GraphQLWorkspaceDashboardDashletSize,
  type WorkspaceDashboardLayoutInput,
} from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import type { GlobalState } from "../../storage";
import type { GraphQLService } from "../services/graphql";

export type UserPreferences = NonNullable<
  NonNullable<GetUserPreferencesQuery["currentUser"]>["preferences"]
>;
export type ConfirmedAssistance = NonNullable<
  GetUserAssistanceQuery["currentUser"]
>["preferences"]["assistance"];
export type UserPreferenceValues = UserPreferences["values"];
export type EffectiveUserPreferenceValues = UserPreferences["effectiveValues"];
export type { UpdateUserPreferencesInput };

export type WorkbenchViewFamily =
  "document-page" | "document-edgeless" | "journal" | "database" | "graph";

export type WorkbenchToolId =
  | "outline"
  | "tags"
  | "frame"
  | "document-info"
  | "calendar"
  | "agenda"
  | "activity"
  | "comment"
  | "chat"
  | "export"
  | "analytics"
  | "database-settings"
  | "task-details"
  | "graph-details"
  | "presence";

export interface WorkbenchToolLayout {
  readonly workspaceId: string;
  readonly viewFamily: WorkbenchViewFamily;
  readonly orderedToolIds: readonly WorkbenchToolId[];
  readonly visibleToolIds: readonly WorkbenchToolId[];
  readonly collapsedToolIds: readonly WorkbenchToolId[];
}

export interface WorkbenchToolLayoutsProjection {
  /** Last aggregate acknowledged by the server; null means no override. */
  readonly confirmed: readonly WorkbenchToolLayout[] | null;
  /** Confirmed aggregate plus the current offline/pending patch. */
  readonly projected: readonly WorkbenchToolLayout[] | null;
  readonly syncStatus: "confirmed" | "pending";
}

export type WorkspaceDashboardDashletId =
  | "today"
  | "tasks"
  | "new-documents"
  | "reminders"
  | "recently-edited"
  | "activity";

export type WorkspaceDashboardDashletSize = "compact" | "standard" | "wide";

export interface WorkspaceDashboardLayout {
  readonly workspaceId: string;
  readonly orderedDashletIds: readonly WorkspaceDashboardDashletId[];
  readonly dashletSizes: Readonly<
    Partial<Record<WorkspaceDashboardDashletId, WorkspaceDashboardDashletSize>>
  >;
}

export interface WorkspaceDashboardLayoutsProjection {
  readonly confirmed: readonly WorkspaceDashboardLayout[] | null;
  readonly projected: readonly WorkspaceDashboardLayout[] | null;
  readonly syncStatus: "confirmed" | "pending";
}

const graphQLViewFamily = (value: `${GraphQLWorkbenchViewFamily}`) =>
  value as GraphQLWorkbenchViewFamily;
const graphQLToolId = (value: `${GraphQLWorkbenchToolId}`) =>
  value as GraphQLWorkbenchToolId;

const viewFamilyFromGraphQL: Record<
  GraphQLWorkbenchViewFamily,
  WorkbenchViewFamily
> = {
  DocumentPage: "document-page",
  DocumentEdgeless: "document-edgeless",
  Journal: "journal",
  Database: "database",
  Graph: "graph",
};

const viewFamilyToGraphQL: Record<
  WorkbenchViewFamily,
  GraphQLWorkbenchViewFamily
> = {
  "document-page": graphQLViewFamily("DocumentPage"),
  "document-edgeless": graphQLViewFamily("DocumentEdgeless"),
  journal: graphQLViewFamily("Journal"),
  database: graphQLViewFamily("Database"),
  graph: graphQLViewFamily("Graph"),
};

const toolIdFromGraphQL: Record<GraphQLWorkbenchToolId, WorkbenchToolId> = {
  Outline: "outline",
  Tags: "tags",
  Frame: "frame",
  DocumentInfo: "document-info",
  Calendar: "calendar",
  Agenda: "agenda",
  Activity: "activity",
  Comment: "comment",
  Chat: "chat",
  Export: "export",
  Analytics: "analytics",
  DatabaseSettings: "database-settings",
  TaskDetails: "task-details",
  GraphDetails: "graph-details",
  Presence: "presence",
};

const toolIdToGraphQL: Record<WorkbenchToolId, GraphQLWorkbenchToolId> = {
  outline: graphQLToolId("Outline"),
  tags: graphQLToolId("Tags"),
  frame: graphQLToolId("Frame"),
  "document-info": graphQLToolId("DocumentInfo"),
  calendar: graphQLToolId("Calendar"),
  agenda: graphQLToolId("Agenda"),
  activity: graphQLToolId("Activity"),
  comment: graphQLToolId("Comment"),
  chat: graphQLToolId("Chat"),
  export: graphQLToolId("Export"),
  analytics: graphQLToolId("Analytics"),
  "database-settings": graphQLToolId("DatabaseSettings"),
  "task-details": graphQLToolId("TaskDetails"),
  "graph-details": graphQLToolId("GraphDetails"),
  presence: graphQLToolId("Presence"),
};

type GraphQLWorkbenchToolLayout = NonNullable<
  UserPreferenceValues["workbenchToolLayouts"]
>[number];

export const fromGraphQLWorkbenchToolLayouts = (
  layouts: readonly GraphQLWorkbenchToolLayout[] | null,
): WorkbenchToolLayout[] | null =>
  layouts?.map((layout) => ({
    workspaceId: layout.workspaceId,
    viewFamily: viewFamilyFromGraphQL[layout.viewFamily],
    orderedToolIds: layout.orderedToolIds.map((id) => toolIdFromGraphQL[id]),
    visibleToolIds: layout.visibleToolIds.map((id) => toolIdFromGraphQL[id]),
    collapsedToolIds: layout.collapsedToolIds.map(
      (id) => toolIdFromGraphQL[id],
    ),
  })) ?? null;

export const toGraphQLWorkbenchToolLayouts = (
  layouts: readonly WorkbenchToolLayout[],
): WorkbenchToolLayoutInput[] =>
  layouts.map((layout) => ({
    workspaceId: layout.workspaceId,
    viewFamily: viewFamilyToGraphQL[layout.viewFamily],
    orderedToolIds: layout.orderedToolIds.map((id) => toolIdToGraphQL[id]),
    visibleToolIds: layout.visibleToolIds.map((id) => toolIdToGraphQL[id]),
    collapsedToolIds: layout.collapsedToolIds.map((id) => toolIdToGraphQL[id]),
  }));

const dashboardDashletIdFromGraphQL: Record<
  GraphQLWorkspaceDashboardDashletId,
  WorkspaceDashboardDashletId
> = {
  Today: "today",
  Tasks: "tasks",
  NewDocuments: "new-documents",
  Reminders: "reminders",
  RecentlyEdited: "recently-edited",
  Activity: "activity",
};

const dashboardDashletIdToGraphQL: Record<
  WorkspaceDashboardDashletId,
  GraphQLWorkspaceDashboardDashletId
> = {
  today: "Today" as GraphQLWorkspaceDashboardDashletId,
  tasks: "Tasks" as GraphQLWorkspaceDashboardDashletId,
  "new-documents": "NewDocuments" as GraphQLWorkspaceDashboardDashletId,
  reminders: "Reminders" as GraphQLWorkspaceDashboardDashletId,
  "recently-edited": "RecentlyEdited" as GraphQLWorkspaceDashboardDashletId,
  activity: "Activity" as GraphQLWorkspaceDashboardDashletId,
};

const dashboardSizeFromGraphQL: Record<
  GraphQLWorkspaceDashboardDashletSize,
  WorkspaceDashboardDashletSize
> = {
  Compact: "compact",
  Standard: "standard",
  Wide: "wide",
};

const dashboardSizeToGraphQL: Record<
  WorkspaceDashboardDashletSize,
  GraphQLWorkspaceDashboardDashletSize
> = {
  compact: "Compact" as GraphQLWorkspaceDashboardDashletSize,
  standard: "Standard" as GraphQLWorkspaceDashboardDashletSize,
  wide: "Wide" as GraphQLWorkspaceDashboardDashletSize,
};

type GraphQLWorkspaceDashboardLayout = NonNullable<
  UserPreferenceValues["workspaceDashboardLayouts"]
>[number];

export const fromGraphQLWorkspaceDashboardLayouts = (
  layouts: readonly GraphQLWorkspaceDashboardLayout[] | null,
): WorkspaceDashboardLayout[] | null =>
  layouts?.map((layout) => ({
    workspaceId: layout.workspaceId,
    orderedDashletIds: layout.orderedDashletIds.map(
      (id) => dashboardDashletIdFromGraphQL[id],
    ),
    dashletSizes: Object.fromEntries(
      layout.dashletSizes.map(({ dashletId, size }) => [
        dashboardDashletIdFromGraphQL[dashletId],
        dashboardSizeFromGraphQL[size],
      ]),
    ),
  })) ?? null;

export const toGraphQLWorkspaceDashboardLayouts = (
  layouts: readonly WorkspaceDashboardLayout[],
): WorkspaceDashboardLayoutInput[] =>
  layouts.map((layout) => {
    // Reject before optimistic persistence, matching the server's Task policy.
    if (layout.dashletSizes.tasks === "compact") {
      throw new Error("Tasks do not support Compact dashboard sizing");
    }
    return {
      workspaceId: layout.workspaceId,
      orderedDashletIds: layout.orderedDashletIds.map(
        (id) => dashboardDashletIdToGraphQL[id],
      ),
      dashletSizes: Object.entries(layout.dashletSizes).flatMap(
        ([dashletId, size]) =>
          size
            ? [
                {
                  dashletId:
                    dashboardDashletIdToGraphQL[
                      dashletId as WorkspaceDashboardDashletId
                    ],
                  size: dashboardSizeToGraphQL[size],
                },
              ]
            : [],
      ),
    };
  });

export interface CachedUserPreferences {
  confirmedValues: UserPreferenceValues;
  confirmedEffectiveValues: EffectiveUserPreferenceValues;
  confirmedUpdatedAt: string | null;
  pendingPatch: UpdateUserPreferencesInput;
}

const storageKey = (serverId: string, userId: string) =>
  `user-preferences:${serverId}:${userId}`;

export class UserPreferencesStore extends Store {
  constructor(
    private readonly gqlService: GraphQLService,
    private readonly globalState: GlobalState,
  ) {
    super();
  }

  getCached(serverId: string, userId: string) {
    return this.globalState.get<CachedUserPreferences>(
      storageKey(serverId, userId),
    );
  }

  watchCached(serverId: string, userId: string) {
    return this.globalState.watch<CachedUserPreferences>(
      storageKey(serverId, userId),
    );
  }

  setCached(
    serverId: string,
    userId: string,
    preferences: CachedUserPreferences | null,
  ) {
    this.globalState.set(storageKey(serverId, userId), preferences);
  }

  async getRemote(): Promise<UserPreferences | undefined> {
    const result = await this.gqlService.gql({
      query: getUserPreferencesQuery,
    });
    return result.currentUser?.preferences;
  }

  async getAssistance(
    workspaceId: string | undefined,
    projectId: string | undefined,
    expectedUserId: string,
  ) {
    const result = await this.gqlService.gql({
      query: getUserAssistanceQuery,
      variables: { workspaceId, projectId },
    });
    if (!result.currentUser) throw new Error("Assistance requires an account");
    if (result.currentUser.id !== expectedUserId)
      throw new Error("Assistance preference owner changed");
    return result.currentUser.preferences.assistance;
  }

  async getSavedSetups(expectedUserId: string) {
    const result = await this.gqlService.gql({
      query: savedAssistantSetupsQuery,
    });
    if (result.currentUser?.id !== expectedUserId)
      throw new Error("Saved setup owner changed");
    return result.currentUser.preferences.values.savedSetups;
  }

  async saveSetup(input: SaveAssistantSetupInput, expectedUserId: string) {
    const result = await this.gqlService.gql({
      query: saveAssistantSetupMutation,
      variables: { input, expectedUserId },
    });
    return result.saveAssistantSetup.values.savedSetups;
  }

  async deleteSetup(id: string, expectedUserId: string) {
    const result = await this.gqlService.gql({
      query: deleteAssistantSetupMutation,
      variables: { id, expectedUserId },
    });
    return result.deleteAssistantSetup.values.savedSetups;
  }

  async resolveSetup(id: string, expectedUserId: string) {
    const result = await this.gqlService.gql({
      query: resolveSavedAssistantSetupQuery,
      variables: { id },
    });
    if (result.currentUser?.id !== expectedUserId)
      throw new Error("Saved setup owner changed");
    return result.currentUser.resolveSavedAssistantSetup;
  }

  async patchRemote(patch: UpdateUserPreferencesInput) {
    const result = await this.gqlService.gql({
      query: updateUserPreferencesMutation,
      variables: { input: patch },
    });
    return result.updatePreferences;
  }
}
