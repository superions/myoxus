// SPDX-License-Identifier: AGPL-3.0-or-later

import { useWorkspaceInfo } from "@myoxus/core/components/hooks/use-workspace-info";
import { GraphQLService } from "@myoxus/core/modules/server";
import {
  inheritPersonalWorkspaceTheme,
  loadPersonalWorkspaceTheme,
  type PersonalWorkspaceThemeState,
  selectPersonalWorkspaceTheme,
} from "@myoxus/core/modules/theme";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { useEffect, useMemo, useState } from "react";

import { FormSelect, notify, SettingsField } from "../../primitives";

const INHERIT_GLOBAL_THEME = "__inherit_global_theme__";

export const PersonalWorkspaceThemeSettings = () => {
  const t = useI18n();
  const graphqlService = useService(GraphQLService);
  const workspace = useService(WorkspaceService).workspace;
  const workspaceProfile = useWorkspaceInfo(workspace.meta);
  const isPersonalWorkspace = workspaceProfile?.workspaceType === "Personal";
  const [themeState, setThemeState] =
    useState<PersonalWorkspaceThemeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    setThemeState(null);
    setLoadError(false);
    if (!isPersonalWorkspace) return;

    setLoading(true);
    void loadPersonalWorkspaceTheme(graphqlService, workspace.id)
      .then((state) => {
        if (active) setThemeState(state);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [graphqlService, isPersonalWorkspace, workspace.id]);

  const options = useMemo(
    () => [
      {
        value: INHERIT_GLOBAL_THEME,
        label:
          t["com.myoxus.appearanceSettings.personalWorkspaceTheme.inherit"](),
      },
      ...(themeState?.personalWorkspaceThemeCatalog.map((theme) => ({
        value: theme.slug,
        label: theme.name,
      })) ?? []),
    ],
    [t, themeState],
  );

  if (!isPersonalWorkspace) return null;

  const selection = themeState?.personalWorkspaceThemeSelection;
  const value = selection?.inheritsGlobal
    ? INHERIT_GLOBAL_THEME
    : selection?.themeSlug;

  const onChange = async (nextValue: string) => {
    setSaving(true);
    try {
      const nextSelection =
        nextValue === INHERIT_GLOBAL_THEME
          ? await inheritPersonalWorkspaceTheme(graphqlService, workspace.id)
          : await selectPersonalWorkspaceTheme(
              graphqlService,
              workspace.id,
              nextValue,
            );
      setThemeState((current) =>
        current
          ? {
              ...current,
              personalWorkspaceThemeSelection: nextSelection,
            }
          : current,
      );
    } catch {
      notify.error({
        title:
          t["com.myoxus.appearanceSettings.personalWorkspaceTheme.saveError"](),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsField
      inline
      label={t["com.myoxus.appearanceSettings.personalWorkspaceTheme.title"]()}
      description={t[
        "com.myoxus.appearanceSettings.personalWorkspaceTheme.description"
      ]()}
      data-testid="personal-workspace-theme-setting"
    >
      <FormSelect
        aria-label={t[
          "com.myoxus.appearanceSettings.personalWorkspaceTheme.title"
        ]()}
        data={options}
        data-testid="personal-workspace-theme-select"
        disabled={loading || saving || !selection}
        error={
          loadError
            ? t[
                "com.myoxus.appearanceSettings.personalWorkspaceTheme.loadError"
              ]()
            : undefined
        }
        loading={loading || saving}
        value={value}
        onChange={(nextValue) => void onChange(nextValue)}
      />
    </SettingsField>
  );
};
