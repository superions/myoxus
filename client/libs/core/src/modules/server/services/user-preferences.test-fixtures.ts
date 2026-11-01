// SPDX-License-Identifier: AGPL-3.0-or-later
import { AssistanceMode, AssistanceSource } from "@myoxus/graphql";
import { filter, Subject } from "rxjs";
import type {
  CachedUserPreferences,
  ConfirmedAssistance,
  UpdateUserPreferencesInput,
  UserPreferences,
} from "../stores/user-preferences";

export const serverPreferences = (): UserPreferences => ({
  updatedAt: "2026-07-13T10:00:00Z",
  values: {
    assistanceMode: null,
    workspaceAssistanceOverrides: [],
    projectAssistanceOverrides: [],
    locale: null,
    defaultDocumentLanguage: null,
    timezone: null,
    dateFormat: null,
    timeFormat: null,
    receiveInvitationEmail: null,
    receiveMentionEmail: null,
    receiveCommentEmail: null,
    notifyCreatedDocuments: null,
    journalFirstDayOfWeek: null,
    journalShowCalendarWeeks: null,
    colorMode: null,
    showLinkedDocuments: null,
    imageAntialiasing: null,
    noisyBackground: null,
    editorFontFamily: null,
    editorCustomFontFamily: null,
    editorFontSize: null,
    newDocumentMode: null,
    fullWidthLayout: null,
    openDocumentMode: null,
    edgelessDefaultTheme: null,
    telemetryEnabled: null,
    aiModelId: null,
    aiReasoningEnabled: null,
    documentMetadataHeaderVisibility: null,
    workbenchToolLayouts: null,
    workspaceDashboardLayouts: null,
    templateCatalogViews: null,
  },
  effectiveValues: {
    assistanceMode: AssistanceMode.Manual,
    locale: "en",
    defaultDocumentLanguage: "en",
    timezone: "UTC",
    dateFormat: "locale",
    timeFormat: "locale",
    receiveInvitationEmail: true,
    receiveMentionEmail: true,
    receiveCommentEmail: true,
    notifyCreatedDocuments: true,
    journalFirstDayOfWeek: "monday",
    journalShowCalendarWeeks: true,
    colorMode: "system",
    showLinkedDocuments: true,
    imageAntialiasing: true,
    noisyBackground: true,
    editorFontFamily: "Sans",
    editorCustomFontFamily: "",
    editorFontSize: 16,
    newDocumentMode: "page",
    fullWidthLayout: false,
    openDocumentMode: "open-in-active-view",
    edgelessDefaultTheme: "specified",
    telemetryEnabled: true,
    aiModelId: null,
    aiReasoningEnabled: false,
    documentMetadataHeaderVisibility: [],
    workbenchToolLayouts: null,
    workspaceDashboardLayouts: null,
    templateCatalogViews: null,
  },
});

export class PreferenceStoreStub {
  cache = new Map<string, CachedUserPreferences>();
  changes = new Subject<string>();
  remote = serverPreferences();
  failPatches = false;
  patchCalls: UpdateUserPreferencesInput[] = [];
  assistance: ConfirmedAssistance = {
    mode: AssistanceMode.Manual,
    source: AssistanceSource.UserDefault,
    userDefaultExplicit: false,
    interactiveMode: AssistanceMode.Guided,
  };
  async getAssistance(
    _workspaceId: string | undefined,
    _projectId: string | undefined,
    _expectedUserId: string,
  ) {
    return this.assistance;
  }

  getCached(serverId: string, userId: string) {
    return this.cache.get(`${serverId}:${userId}`);
  }

  watchCached(serverId: string, userId: string) {
    return this.changes.pipe(filter((key) => key === `${serverId}:${userId}`));
  }

  setCached(
    serverId: string,
    userId: string,
    preferences: CachedUserPreferences | null,
  ) {
    const key = `${serverId}:${userId}`;
    if (preferences) this.cache.set(key, preferences);
    else this.cache.delete(key);
    this.changes.next(key);
  }

  async getRemote() {
    return this.remote;
  }

  async patchRemote(patch: UpdateUserPreferencesInput) {
    this.patchCalls.push(patch);
    if (this.failPatches) throw new Error("offline");
    this.remote = {
      ...this.remote,
      updatedAt: "2026-07-13T10:01:00Z",
      values: { ...this.remote.values, ...patch },
      effectiveValues: {
        ...this.remote.effectiveValues,
        ...Object.fromEntries(
          Object.entries(patch).filter(
            ([key, value]) =>
              value !== null ||
              key === "workbenchToolLayouts" ||
              key === "workspaceDashboardLayouts",
          ),
        ),
      },
    } as UserPreferences;
    return this.remote;
  }
}
