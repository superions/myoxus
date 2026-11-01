/**
 * Admin Documents module.
 *
 * This page owns global document metadata field policy, status schemas, value lists,
 * document types, versioning policy, and related audit visibility. Workspace
 * selection remains in workspace settings; PDF export remains a separate admin
 * module and consumes this canonical document configuration.
 */
import { useI18n } from "@myoxus/i18n";
import {
  SettingsEmptyState,
  Stack,
  Tabs,
  TabsContent,
} from "@myoxus/ui-facade";
import { Suspense } from "react";

import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { AuditTab } from "./components/audit-tab";
import { DocumentTypesTab } from "./components/document-types-tab";
import { MetadataFieldsTab } from "./components/metadata-fields-tab";
import { OverviewTab } from "./components/overview-tab";
import { StatusSchemasTab } from "./components/status-schemas-tab";
import { ValueListsTab } from "./components/value-lists-tab";
import { VersioningTab } from "./components/versioning-tab";

function TabLoading() {
  const i18n = useI18n();
  return <SettingsEmptyState title={i18n.t("admin.documents.loading")} />;
}

const TAB_IDS = [
  "overview",
  "metadata",
  "status",
  "types",
  "values",
  "versioning",
  "audit",
] as const;

const TAB_LABEL_KEYS: Record<(typeof TAB_IDS)[number], string> = {
  overview: "admin.documents.tab.overview",
  metadata: "admin.documents.tab.metadata",
  status: "admin.documents.tab.status",
  types: "admin.documents.tab.types",
  values: "admin.documents.tab.value-lists",
  versioning: "admin.documents.tab.versioning",
  audit: "admin.documents.tab.audit",
};

export function DocumentsPage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(TAB_IDS, "overview");

  return (
    <AdminPageFrame
      title={i18n.t("admin.documents.title")}
      routeAnchor="admin-route-documents"
      testId="documents-admin-module"
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
            testId: `documents-tab-${value}`,
          }))}
        />
        <AdminPageScroll>
          <Stack>
            <Suspense fallback={<TabLoading />}>
              <TabsContent value="overview">
                <OverviewTab />
              </TabsContent>
              <TabsContent value="metadata">
                <MetadataFieldsTab />
              </TabsContent>
              <TabsContent value="status">
                <StatusSchemasTab />
              </TabsContent>
              <TabsContent value="types">
                <DocumentTypesTab />
              </TabsContent>
              <TabsContent value="values">
                <ValueListsTab />
              </TabsContent>
              <TabsContent value="versioning">
                <VersioningTab />
              </TabsContent>
              <TabsContent value="audit">
                <AuditTab />
              </TabsContent>
            </Suspense>
          </Stack>
        </AdminPageScroll>
      </Tabs>
    </AdminPageFrame>
  );
}

export { DocumentsPage as Component };
