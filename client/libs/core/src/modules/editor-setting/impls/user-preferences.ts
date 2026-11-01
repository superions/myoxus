// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Service } from "@myoxus/infra";
import { combineLatest, map, type Observable, of, switchMap } from "rxjs";

import type { GlobalContextService } from "../../global-context";
import {
  type EffectiveUserPreferenceValues,
  type UpdateUserPreferencesInput,
} from "../../server/stores/user-preferences";
import { UserPreferencesService } from "../../server/services/user-preferences";
import type { DefaultServerService } from "../../server/services/default-server";
import type { ServersService } from "../../server/services/servers";
import type { GlobalState } from "../../storage";
import type { EditorSettingProvider } from "../provider/editor-setting-provider";

const deviceStorageKey = "device-editor-preferences";
const documentMetadataVisibilityKey = "documentMetadataHeaderVisibility";

const syncedKeys = {
  fontSize: "editorFontSize",
  newDocDefaultMode: "newDocumentMode",
  fullWidthLayout: "fullWidthLayout",
  openDocMode: "openDocumentMode",
  edgelessDefaultTheme: "edgelessDefaultTheme",
} as const satisfies Record<string, keyof EffectiveUserPreferenceValues>;

type SyncedEditorKey = keyof typeof syncedKeys;

const isSyncedEditorKey = (key: string): key is SyncedEditorKey =>
  key in syncedKeys;

/**
 * Projects typed SQL-backed account preferences into the existing editor
 * setting contract. Large tool-palette state and OS-only options remain in a
 * single device store; they are never written to the account aggregate.
 */
export class UserPreferencesEditorSettingProvider
  extends Service
  implements EditorSettingProvider
{
  constructor(
    private readonly serversService: ServersService,
    private readonly defaultServerService: DefaultServerService,
    private readonly globalContextService: GlobalContextService,
    private readonly globalState: GlobalState,
  ) {
    super();
  }

  private resolvePreferences(
    serverId = this.globalContextService.globalContext.serverId.get(),
    servers = this.serversService.servers$.value,
  ) {
    const server = servers.find((candidate) => candidate.id === serverId);
    return (server ?? this.defaultServerService.server$.value)?.scope.get(
      UserPreferencesService,
    );
  }

  set(key: string, value: string): void {
    const preferences = this.resolvePreferences();
    if (preferences && key === documentMetadataVisibilityKey) {
      const visibility = JSON.parse(value) as Record<
        string,
        Record<string, boolean>
      >;
      void preferences.update({
        documentMetadataHeaderVisibility: Object.entries(visibility).map(
          ([workspaceId, fields]) => ({
            workspaceId,
            fields: Object.entries(fields).map(([field, visible]) => ({
              field,
              visible,
            })),
          }),
        ),
      });
      return;
    }
    if (preferences && isSyncedEditorKey(key)) {
      const preferenceKey = syncedKeys[key];
      void preferences.update({
        [preferenceKey]: JSON.parse(value) as unknown,
      } as UpdateUserPreferencesInput);
      return;
    }
    const all =
      this.globalState.get<Record<string, string>>(deviceStorageKey) ?? {};
    this.globalState.set(deviceStorageKey, { ...all, [key]: value });
  }

  watchAll(): Observable<Record<string, string>> {
    const preferences$ = combineLatest([
      this.globalContextService.globalContext.serverId.$,
      this.serversService.servers$,
    ]).pipe(
      switchMap(
        ([serverId, servers]) =>
          this.resolvePreferences(serverId, servers)?.userPreferences$ ??
          of(undefined),
      ),
    );
    return combineLatest([
      preferences$,
      this.globalState.watch<Record<string, string>>(deviceStorageKey),
    ]).pipe(
      map(([preferences, deviceValues]) => {
        const values = { ...deviceValues };
        const effective = preferences?.effectiveValues;
        if (!effective) return values;
        for (const [editorKey, preferenceKey] of Object.entries(syncedKeys)) {
          values[editorKey] = JSON.stringify(
            // Effective values contain the server fallback (16px), not user intent.
            // Retain explicit legacy sizes; null follows the current theme.
            preferenceKey === "editorFontSize"
              ? preferences.values.editorFontSize
              : effective[preferenceKey as keyof EffectiveUserPreferenceValues],
          );
        }
        values[documentMetadataVisibilityKey] = JSON.stringify(
          Object.fromEntries(
            effective.documentMetadataHeaderVisibility.map((workspace) => [
              workspace.workspaceId,
              Object.fromEntries(
                workspace.fields.map(({ field, visible }) => [field, visible]),
              ),
            ]),
          ),
        );
        return values;
      }),
    );
  }
}
