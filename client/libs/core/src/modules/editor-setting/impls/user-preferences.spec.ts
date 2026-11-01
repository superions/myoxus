// SPDX-License-Identifier: AGPL-3.0-or-later
import { Framework } from "@myoxus/infra";
import { BehaviorSubject } from "rxjs";
import { expect, test, vi } from "vitest";

import { GlobalContextService } from "../../global-context/services/global-context";
import { DefaultServerService } from "../../server/services/default-server";
import { UserPreferencesService } from "../../server/services/user-preferences";
import { ServersService } from "../../server/services/servers";
import { GlobalState } from "../../storage/providers/global";
import { EditorSetting } from "../entities/editor-setting";
import { EditorSettingProvider } from "../provider/editor-setting-provider";
import { UserPreferencesEditorSettingProvider } from "./user-preferences";

// The account API keeps both raw intent and an effective legacy 16px default.
const preferenceSnapshot = (size: number | null) => ({
  values: {
    editorFontSize: size,
    editorFontFamily: "Custom",
    editorCustomFontFamily: "Old personal font",
  },
  effectiveValues: {
    editorFontSize: size ?? 16,
    documentMetadataHeaderVisibility: [],
  },
});

test("reading size preserves explicit account values and resets to theme without using the effective fallback", () => {
  const snapshots = new BehaviorSubject(preferenceSnapshot(null));
  const update = vi.fn((patch: { editorFontSize: number | null }) => {
    snapshots.next(preferenceSnapshot(patch.editorFontSize));
  });
  const preferences = { userPreferences$: snapshots, update };
  const server = {
    id: "server",
    scope: {
      get: (token: unknown) => {
        expect(token).toBe(UserPreferencesService);
        return preferences;
      },
    },
  };
  const framework = new Framework();
  framework
    .service(ServersService, {
      servers$: new BehaviorSubject([server]),
    } as unknown as ServersService)
    .service(DefaultServerService, {
      server$: { value: server },
    } as unknown as DefaultServerService)
    .service(GlobalContextService, {
      globalContext: {
        serverId: { $: new BehaviorSubject("server"), get: () => "server" },
      },
    } as unknown as GlobalContextService)
    .impl(GlobalState, {
      watch: () => new BehaviorSubject({}),
      get: () => ({}),
      set: vi.fn(),
    } as unknown as GlobalState)
    .impl(EditorSettingProvider, UserPreferencesEditorSettingProvider, [
      ServersService,
      DefaultServerService,
      GlobalContextService,
      GlobalState,
    ])
    .entity(EditorSetting, [EditorSettingProvider]);
  const provider = framework.provider();
  const setting = provider.createEntity(EditorSetting);
  const subscription = setting.settings$.subscribe(() => {});
  try {
    expect(setting.get("fontSize")).toBeNull();
    expect(setting.settings$.value).not.toHaveProperty("fontFamily");
    expect(setting.settings$.value).not.toHaveProperty("customFontFamily");
    // An explicit old 16px choice must not be mistaken for the effective default.
    snapshots.next(preferenceSnapshot(16));
    expect(setting.get("fontSize")).toBe(16);
    setting.set("fontSize", 20);
    expect(update).toHaveBeenLastCalledWith({ editorFontSize: 20 });
    expect(setting.get("fontSize")).toBe(20);
    setting.set("fontSize", null);
    expect(update).toHaveBeenLastCalledWith({ editorFontSize: null });
    expect(setting.get("fontSize")).toBeNull();
    const reopened = provider.createEntity(EditorSetting);
    const reopenedSubscription = reopened.settings$.subscribe(() => {});
    expect(reopened.get("fontSize")).toBeNull();
    reopenedSubscription.unsubscribe();
    reopened.dispose();
    expect(update).toHaveBeenCalledTimes(2);
  } finally {
    subscription.unsubscribe();
    setting.dispose();
    snapshots.complete();
  }
});
