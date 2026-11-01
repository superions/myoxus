// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Workspace-scoped Theme DB editor.
 *
 * The panel deliberately reuses the same AdminRoot theme mutations as the
 * global Design page. It does not persist local presets or AppConfig
 * values; choosing a preset creates a server-side workspace profile, and reset
 * removes that profile so the workspace inherits the global profile again.
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  Button,
  FormFieldset,
  Group,
  SettingsListItemTitle,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsDefinitionList,
  SettingsDefinitionItem,
  SettingsStatusText,
  SettingsNotice,
  SettingsSkeleton,
  SettingsToolbar,
  SimpleGrid,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useRef, useState } from "react";

import { ColorsTab } from "../../design/tabs/colors-tab";
import { ThemeGallery } from "../../design/theme-gallery";
import {
  useEffectiveThemeProfileQuery,
  useResetWorkspaceThemeProfileMutation,
  useSetThemeProfileMutation,
  useThemeCatalogQuery,
} from "../../theme/theme-api";
import { isThemeMode, type ThemeMode } from "../../theme/theme-contract";
import { ScopedTypographyEditor } from "../../typography/scoped-typography-editor";

export function WorkspaceBrandingTab({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string | null | undefined;
}) {
  const i18n = useI18n();
  const catalogQuery = useThemeCatalogQuery();
  const profileQuery = useEffectiveThemeProfileQuery(workspaceId);
  const globalQuery = useEffectiveThemeProfileQuery(null);
  const { themes } = catalogQuery;
  const { profile } = profileQuery;
  const { profile: globalProfile } = globalQuery;
  const { setThemeProfile, isMutating: isSavingTheme } =
    useSetThemeProfileMutation();
  const { resetWorkspaceThemeProfile, isMutating: isResetting } =
    useResetWorkspaceThemeProfileMutation();
  const [pending, setPending] = useState(false);
  const operationLock = useRef(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const loading =
    catalogQuery.isLoading || profileQuery.isLoading || globalQuery.isLoading;
  const hasData = Boolean(catalogQuery.catalog && profile && globalProfile);
  const error =
    catalogQuery.error?.message ??
    profileQuery.error?.message ??
    globalQuery.error?.message ??
    retryError ??
    (!loading && !hasData
      ? i18n.t("com.myoxus.settings.common.load-error")
      : null);
  const busy = pending || isSavingTheme || isResetting;
  const ready = hasData && !loading && !error && !busy;

  // All editors mutate one server profile; retain the lock through readback.
  const beginSave = () => {
    if (!ready || operationLock.current) return false;
    operationLock.current = true;
    setPending(true);
    return true;
  };
  const endSave = () => {
    operationLock.current = false;
    setPending(false);
  };

  async function retry() {
    if (operationLock.current) return;
    operationLock.current = true;
    setPending(true);
    setRetryError(null);
    try {
      const results = await Promise.allSettled([
        catalogQuery.mutate(),
        profileQuery.mutate(),
        globalQuery.mutate(),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      operationLock.current = false;
      setPending(false);
    }
  }

  const activeTheme = profile?.theme ?? null;
  const activeMode = isThemeMode(profile?.themeMode)
    ? profile.themeMode
    : "system";
  const inheritsGlobal = profile?.scope !== "workspace";

  const persistTheme = useCallback(
    async (themeSlug: string, themeMode: ThemeMode) => {
      if (!themeSlug || !ready || operationLock.current) return;
      operationLock.current = true;
      setPending(true);
      try {
        await setThemeProfile({ workspaceId, themeSlug, themeMode });
        toast.success(i18n.t("admin.state.saved"));
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : i18n.t("admin.workspaces.branding.save-failed"),
        );
      } finally {
        operationLock.current = false;
        setPending(false);
      }
    },
    [i18n, ready, setThemeProfile, workspaceId],
  );

  const handleReset = useCallback(async () => {
    if (!ready || inheritsGlobal || operationLock.current) return;
    operationLock.current = true;
    setPending(true);
    try {
      await resetWorkspaceThemeProfile({ workspaceId });
      toast.success(i18n.t("admin.workspaces.branding.reset-success"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : i18n.t("admin.workspaces.branding.reset-failed"),
      );
    } finally {
      operationLock.current = false;
      setPending(false);
    }
  }, [i18n, ready, inheritsGlobal, resetWorkspaceThemeProfile, workspaceId]);

  return (
    <>
      <Stack component="section" data-testid="workspace-branding-tab">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.workspaces.branding.title")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.workspaces.branding.description", {
              name: workspaceName || workspaceId,
            })}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        {error ? (
          <SettingsNotice
            tone="error"
            title={i18n.t("com.myoxus.settings.common.load-error")}
          >
            {error}
            <Group>
              <Button disabled={busy} onClick={() => void retry()}>
                {i18n.t("admin.error.retry")}
              </Button>
            </Group>
          </SettingsNotice>
        ) : !hasData ? (
          <SettingsSkeleton />
        ) : null}
        {hasData && !error ? (
          <>
            <SettingsToolbar justify="space-between">
              <SettingsStatusText tone={inheritsGlobal ? "active" : "muted"}>
                {i18n.t(
                  inheritsGlobal
                    ? "admin.workspaces.branding.inherited"
                    : "admin.workspaces.branding.overridden",
                )}
              </SettingsStatusText>
              <Button
                type="button"
                variant="secondary"
                disabled={inheritsGlobal || !ready}
                onClick={handleReset}
                data-testid="workspace-branding-reset"
              >
                {i18n.t("admin.workspaces.branding.inherit-global-profile")}
              </Button>
            </SettingsToolbar>
            <SimpleGrid cols={2}>
              <SettingsDefinitionList>
                <SettingsDefinitionItem
                  label={i18n.t("admin.workspaces.branding.current-theme")}
                >
                  <SettingsListItemTitle truncate>
                    {activeTheme?.name ?? "-"}
                  </SettingsListItemTitle>
                  {activeTheme?.slug ? <Badge>{activeTheme.slug}</Badge> : null}
                </SettingsDefinitionItem>
              </SettingsDefinitionList>
              <SettingsDefinitionList>
                <SettingsDefinitionItem
                  label={i18n.t("admin.workspaces.branding.global-theme")}
                >
                  <SettingsListItemTitle truncate>
                    {globalProfile?.theme?.name ?? "-"}
                  </SettingsListItemTitle>
                  {globalProfile?.theme?.slug ? (
                    <Badge tone="neutral">{globalProfile.theme.slug}</Badge>
                  ) : null}
                </SettingsDefinitionItem>
              </SettingsDefinitionList>
            </SimpleGrid>
          </>
        ) : null}
      </Stack>

      {hasData ? (
        // Keep mounted color/typography drafts; native fieldset blocks stale writes.
        <FormFieldset variant="unstyled" disabled={!ready}>
          <ThemeGallery
            themes={themes}
            activePreset={activeTheme?.slug ?? null}
            activeMode={activeMode}
            onSelectPreset={(slug) => {
              if (slug === activeTheme?.slug) return;
              void persistTheme(slug, activeMode);
            }}
            onSelectMode={(mode) => {
              if (mode === activeMode || !activeTheme?.slug) return;
              void persistTheme(activeTheme.slug, mode);
            }}
            isSaving={!ready}
          />

          <ColorsTab
            theme={activeTheme}
            workspaceId={workspaceId}
            onSaveStart={beginSave}
            onSaveEnd={endSave}
          />

          <ScopedTypographyEditor
            workspaceId={workspaceId}
            layout="embedded"
            onSaveStart={beginSave}
            onSaveEnd={endSave}
            title={i18n.t("admin.workspaces.branding.typography.title")}
            description={i18n.t(
              "admin.workspaces.branding.typography.description",
            )}
            notice={i18n.t("admin.workspaces.branding.typography.notice")}
            testId="workspace-typography-editor"
          />
        </FormFieldset>
      ) : null}
    </>
  );
}
