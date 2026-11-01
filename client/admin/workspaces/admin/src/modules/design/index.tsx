// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Design page for the server-owned global theme model.
 *
 * Theme selection and color previews are read from AdminRoot's typed
 * Theme/Profile API. App/server brand assets are read through the separate
 * Brand Identity projection so theme selection never carries logos or PDF
 * defaults.
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import { useI18n } from "@myoxus/i18n";
import { MetricStack, Tabs, TabsContent } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import {
  useAppServerBrandingQuery,
  useOrganizationIdentityQuery,
} from "../branding/brand-identity-api";
import {
  useEffectiveThemeProfileQuery,
  useSetThemeProfileMutation,
  useThemeCatalogQuery,
} from "../theme/theme-api";
import { isThemeMode, type ThemeMode } from "../theme/theme-contract";
import { BrandingTab } from "./tabs/branding-tab";
import { ColorsTab } from "./tabs/colors-tab";
import { ThemeGallery } from "./theme-gallery";

const TABS = [
  { value: "overview", key: "overview" },
  { value: "colors", key: "colors" },
  { value: "branding", key: "branding" },
] as const;
const TAB_IDS = TABS.map((tab) => tab.value);

export function DesignPage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(TAB_IDS, "overview");
  const { themes, catalog } = useThemeCatalogQuery();
  const { profile } = useEffectiveThemeProfileQuery(null);
  const { branding } = useAppServerBrandingQuery();
  const { identity } = useOrganizationIdentityQuery();
  const { setThemeProfile, isMutating } = useSetThemeProfileMutation();

  const activeTheme =
    profile?.theme ??
    themes.find((theme) => theme.isDefault) ??
    themes[0] ??
    null;
  const activeMode = isThemeMode(profile?.themeMode)
    ? profile?.themeMode
    : "system";

  const persistTheme = useCallback(
    async (themeSlug: string, themeMode: ThemeMode) => {
      if (!themeSlug) return;
      try {
        await setThemeProfile({ themeSlug, themeMode });
        toast.success(i18n.t("admin.state.saved"));
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined;
        toast.error(message ?? i18n.t("admin.design.failed-save"));
      }
    },
    [i18n, setThemeProfile],
  );

  const handleSelectPreset = useCallback(
    (slug: string) => {
      if (slug === activeTheme?.slug) return;
      void persistTheme(slug, activeMode);
    },
    [activeMode, activeTheme?.slug, persistTheme],
  );

  const handleSelectMode = useCallback(
    (mode: ThemeMode) => {
      if (mode === activeMode || !activeTheme?.slug) return;
      void persistTheme(activeTheme.slug, mode);
    },
    [activeMode, activeTheme?.slug, persistTheme],
  );

  return (
    <AdminPageFrame
      title={i18n.t("admin.design.title")}
      routeAnchor="admin-route-design"
      actions={
        <MetricStack
          data-myoxus-ui-role="design-hero-metrics"
          rows={[
            {
              label: i18n.t("admin.design.hero.themes"),
              value: String(themes.length),
            },
            {
              label: i18n.t("admin.design.hero.active-theme"),
              value: activeTheme?.name ?? "-",
            },
            {
              label: i18n.t("admin.design.hero.catalog"),
              value: catalog?.catalogHash?.slice(0, 8) ?? "-",
            },
          ]}
        />
      }
    >
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        layout="page"
        variant="default"
      >
        <AdminSubnav
          items={TABS.map(({ value, key }) => ({
            value,
            label: i18n.t(`admin.design.tab.${key}` as never),
            testId: `design-tab-${key}`,
          }))}
        />

        <AdminPageScroll gap="spacious">
          <TabsContent value="overview" forceMount>
            <ThemeGallery
              themes={themes}
              activePreset={activeTheme?.slug ?? null}
              activeMode={activeMode}
              onSelectPreset={handleSelectPreset}
              onSelectMode={handleSelectMode}
              isSaving={isMutating}
            />
          </TabsContent>

          <TabsContent value="colors" forceMount>
            <ColorsTab theme={activeTheme} />
          </TabsContent>

          <TabsContent value="branding" forceMount>
            <BrandingTab
              branding={branding ?? null}
              organizationIdentity={identity ?? null}
            />
          </TabsContent>
        </AdminPageScroll>
      </Tabs>
    </AdminPageFrame>
  );
}

export { DesignPage as Component };
