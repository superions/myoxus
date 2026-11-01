/**
 * Template Registry administration page.
 *
 * Provides a dedicated top-level admin page for managing the central template
 * catalog, importing template bundles, managing versions/revisions, viewing
 * workspace template assignments, and configuring registry settings.
 *
 * Registry tabs consume live server capabilities through the shared GraphQL API.
 * Settings tab uses the same useAppConfig + config form field pattern as Git Sync.
 */
import { useI18n } from "@myoxus/i18n";
import { Stack, Tabs, TabsContent } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { useRevalidateServerConfig } from "../common";
import { type AppConfig } from "../settings/config";
import type { AdminConfigSchemaSnapshot } from "../settings/use-admin-config-contract";
import { useAppConfig } from "../settings/use-app-config";
import { ArchiveTab } from "./archive-tab";
import { AssignmentsTab } from "./assignments-tab";
import { CatalogTab } from "./catalog-tab";
import { DefaultPoliciesTab } from "./default-policies-tab";
import { ImportTab } from "./import-tab";
import { JobsTab } from "./jobs-tab";
import { SettingsTab } from "./settings-tab";
import { VersionsTab } from "./versions-tab";

// ---------------------------------------------------------------------------
// Shared Props Interface
// ---------------------------------------------------------------------------

/**
 * Props shared by config-based tab components (Settings).
 */
export interface TemplateSettingsTabProps {
  schema?: AdminConfigSchemaSnapshot | null;
  appConfig: AppConfig;
  patchedAppConfig: AppConfig;
  onUpdate: (path: string, value: any) => void;
  onSaveGroup: (module: string) => Promise<void>;
  onResetGroup: (module: string) => void;
  isGroupDirty: (module: string) => boolean;
  isGroupSaving: (module: string) => boolean;
  getGroupVersion: (module: string) => number;
  fieldErrorsByPath: Record<string, { message: string }>;
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

const TAB_IDS = [
  "catalog",
  "default-policies",
  "import",
  "versions",
  "assignments",
  "jobs",
  "archive",
  "settings",
] as const;

const TAB_LABEL_KEYS: Record<(typeof TAB_IDS)[number], string> = {
  catalog: "admin.templates.tab.catalog",
  "default-policies": "admin.templates.tab.default-policies",
  import: "admin.templates.tab.import",
  versions: "admin.templates.tab.versions",
  assignments: "admin.templates.tab.assignments",
  jobs: "admin.templates.tab.jobs",
  archive: "admin.templates.tab.archive",
  settings: "admin.templates.tab.settings",
};

export function TemplatesPage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(TAB_IDS, "catalog");
  const {
    schema,
    appConfig,
    update,
    saveGroup,
    resetGroup,
    patchedAppConfig,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath = {},
  } = useAppConfig();
  const revalidateServerConfig = useRevalidateServerConfig();

  const handleSaveGroup = useCallback(
    async (module: string) => {
      await saveGroup(module);
      await revalidateServerConfig();
    },
    [saveGroup, revalidateServerConfig],
  );

  const configProps: TemplateSettingsTabProps = {
    schema,
    appConfig,
    patchedAppConfig,
    onUpdate: update,
    onSaveGroup: handleSaveGroup,
    onResetGroup: resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath,
  };

  return (
    <AdminPageFrame
      title={i18n.t("admin.templates.title")}
      routeAnchor="admin-route-templates"
    >
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        layout="page"
        variant="default"
      >
        <AdminSubnav
          items={TAB_IDS.map((value) => ({
            value,
            label: i18n.t(TAB_LABEL_KEYS[value] as never),
            testId: `templates-tab-${value}`,
          }))}
        />
        <AdminPageScroll>
          <Stack>
            <TabsContent value="catalog" layout="stack">
              <CatalogTab />
            </TabsContent>

            <TabsContent value="default-policies" layout="stack">
              <DefaultPoliciesTab />
            </TabsContent>

            <TabsContent value="import" layout="stack">
              <ImportTab />
            </TabsContent>

            <TabsContent value="versions" layout="stack">
              <VersionsTab />
            </TabsContent>

            <TabsContent value="assignments" layout="stack">
              <AssignmentsTab />
            </TabsContent>

            <TabsContent value="jobs" layout="stack">
              <JobsTab />
            </TabsContent>

            <TabsContent value="archive" layout="stack">
              <ArchiveTab />
            </TabsContent>

            <TabsContent value="settings" layout="stack">
              <SettingsTab {...configProps} />
            </TabsContent>
          </Stack>
        </AdminPageScroll>
      </Tabs>
    </AdminPageFrame>
  );
}

export { TemplatesPage as Component };
