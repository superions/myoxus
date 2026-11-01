/**
 * Organization admin page.
 *
 * The page owns tab orchestration and cross-tab focus only. Shared page chrome,
 * header typography, tab navigation and scroll rails are provided by the Admin
 * shell / Facade so organization routes do not maintain a parallel UI system.
 */
import { useI18n } from "@myoxus/i18n";
import { Stack, Tabs, TabsContent } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { ImportExportTab } from "./import-export-tab";
import { MembersTab } from "./members-tab";
import { OrganigramTab } from "./organigram-tab";
import { OverviewTab } from "./overview-tab";
import { PolicyTab } from "./policy-tab";
import { ProjectRequestsTab } from "./project-requests-tab";
import { UnitTypesTab } from "./unit-types-tab";
import { UnitsTab } from "./units-tab";

const TABS = [
  {
    value: "overview",
    labelKey: "admin.organization.tab.overview",
  },
  { value: "units", labelKey: "admin.organization.tab.units" },
  {
    value: "unit-types",
    labelKey: "admin.organization.tab.unit-types",
  },
  {
    value: "organigram",
    labelKey: "admin.organization.tab.organigram",
  },
  { value: "members", labelKey: "admin.organization.tab.members" },
  { value: "policy", labelKey: "admin.organization.tab.policy" },
  { value: "requests", labelKey: "admin.organization.tab.requests" },
  {
    value: "import-export",
    labelKey: "admin.organization.tab.import-export",
  },
] as const;
const TAB_IDS = TABS.map((tab) => tab.value);

export function OrganizationPage({
  defaultTab = "overview",
  focusUnitId = null,
}: {
  defaultTab?: (typeof TAB_IDS)[number];
  focusUnitId?: string | null;
}) {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(TAB_IDS, defaultTab);
  const [focusedUnitId, setFocusedUnitId] = useState<string | null>(
    focusUnitId,
  );
  const openUnitFromMember = useCallback(
    (unitId: string) => {
      setFocusedUnitId(unitId);
      setActiveTab("units");
    },
    [setActiveTab],
  );

  return (
    <AdminPageFrame
      title={i18n.t("admin.organization.title")}
      routeAnchor="admin-route-organization"
    >
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        layout="page"
        variant="default"
      >
        <AdminSubnav
          items={TABS.map(({ value, labelKey }) => ({
            value,
            label: i18n.t(labelKey),
            testId: `organization-tab-${value}`,
          }))}
        />

        <AdminPageScroll>
          <Stack>
            <TabsContent value="overview">
              <OverviewTab />
            </TabsContent>
            <TabsContent value="units">
              <UnitsTab focusUnitId={focusUnitId ?? focusedUnitId} />
            </TabsContent>
            <TabsContent value="unit-types">
              <UnitTypesTab />
            </TabsContent>
            <TabsContent value="organigram">
              <OrganigramTab />
            </TabsContent>
            <TabsContent value="members">
              <MembersTab onOpenUnit={openUnitFromMember} />
            </TabsContent>
            <TabsContent value="policy">
              <PolicyTab />
            </TabsContent>
            <TabsContent value="requests">
              <ProjectRequestsTab />
            </TabsContent>
            <TabsContent value="import-export">
              <ImportExportTab />
            </TabsContent>
          </Stack>
        </AdminPageScroll>
      </Tabs>
    </AdminPageFrame>
  );
}

export default OrganizationPage;
