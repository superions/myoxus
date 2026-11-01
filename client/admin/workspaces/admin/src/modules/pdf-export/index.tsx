/**
 * PDF Export / Brand Assets / ICC — Admin page.
 *
 * Top-level page for the PDF-Export V2 admin surface. Hosts six tabs:
 *
 *  - **Templates** — list, upload, detail, archive of PDF templates
 *    (`pdf_templates` rows). Template content is operator-editable;
 *    workspace assignment lives in the next tab.
 *  - **Workspaces** — workspace ↔ template assignments and per-workspace
 *    default selection.
 *  - **Brand Assets** — per-workspace logo, colors, paper-size,
 *    locale, color profile, image quality, ligatures.
 *  - **ICC Profiles** — color profiles for L1 brand color management.
 *  - **Render Jobs** — admin view of PDF render jobs (queued / running /
 *    failed) for diagnostics.
 *  - **Settings** — global PDF export limits + doc-versioning auto-trigger
 *    rules.
 *
 * The page follows the same architecture as `modules/templates/index.tsx`
 * (Document-Templates) and consumes the shared Myoxus UI facade for visible
 * tabs and chrome so the visual language stays consistent across the admin app.
 *
 * Architecture refs:
 *  - `docs/dev/server/pdf-export-v2-architecture.md` §1 (L1 brand, L2
 *    template capabilities, L3 workspace assignment)
 *  - `docs/ops/data/pdf-export-templates.md` (operator runbook)
 */
import { useI18n } from "@myoxus/i18n";
import { Stack, Tabs, TabsContent } from "@myoxus/ui-facade";

import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { BrandAssetsTab } from "./components/brand-assets-tab";
import { IccProfilesTab } from "./components/icc-profiles-tab";
import { JobsTab } from "./components/jobs-tab";
import { SettingsTab } from "./components/settings-tab";
import { TemplatesTab } from "./components/templates-tab";
import { WorkspacesTab } from "./components/workspaces-tab";
import { PdfTabFrame } from "./pdf-role-primitives";

const TAB_IDS = [
  "templates",
  "workspaces",
  "brand",
  "icc",
  "jobs",
  "settings",
] as const;

const TAB_LABEL_KEYS: Record<(typeof TAB_IDS)[number], string> = {
  templates: "admin.pdf-export.tab.templates",
  workspaces: "admin.pdf-export.tab.workspaces",
  brand: "admin.pdf-export.tab.brand",
  icc: "admin.pdf-export.tab.icc",
  jobs: "admin.pdf-export.tab.jobs",
  settings: "admin.pdf-export.tab.settings",
};

/**
 * Top-level admin page for PDF Export V2 administration.
 *
 * Always renders all six PDF export tabs (the "disabled features stay visible"
 * rule from `feedback_disabled_features_always_visible.md` —
 * disabling PDF export at the workspace level must not hide the admin
 * surface, otherwise it cannot be re-enabled).
 */
export function PdfExportPage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(TAB_IDS, "templates");

  return (
    <AdminPageFrame
      title={i18n.t("admin.pdf-export.title")}
      routeAnchor="admin-route-pdf-export"
      testId="pdf-export-admin-module"
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
            testId: `pdf-export-tab-${value}`,
          }))}
        />
        <AdminPageScroll>
          <Stack>
            <TabsContent value="templates">
              <PdfTabFrame
                title={i18n.t("admin.pdf-export.tab.templates")}
                description={i18n.t(
                  "admin.pdf-export.tab.templates.description",
                )}
              >
                <TemplatesTab />
              </PdfTabFrame>
            </TabsContent>

            <TabsContent value="workspaces">
              <PdfTabFrame
                title={i18n.t("admin.pdf-export.tab.workspaces")}
                description={i18n.t(
                  "admin.pdf-export.tab.workspaces.description",
                )}
              >
                <WorkspacesTab />
              </PdfTabFrame>
            </TabsContent>

            <TabsContent value="brand">
              <PdfTabFrame
                title={i18n.t("admin.pdf-export.tab.brand")}
                description={i18n.t("admin.pdf-export.tab.brand.description")}
              >
                <BrandAssetsTab />
              </PdfTabFrame>
            </TabsContent>

            <TabsContent value="icc">
              <PdfTabFrame
                title={i18n.t("admin.pdf-export.tab.icc")}
                description={i18n.t("admin.pdf-export.tab.icc.description")}
              >
                <IccProfilesTab />
              </PdfTabFrame>
            </TabsContent>

            <TabsContent value="jobs">
              <PdfTabFrame
                title={i18n.t("admin.pdf-export.tab.jobs")}
                description={i18n.t("admin.pdf-export.tab.jobs.description")}
              >
                <JobsTab />
              </PdfTabFrame>
            </TabsContent>

            <TabsContent value="settings">
              <PdfTabFrame
                title={i18n.t("admin.pdf-export.tab.settings")}
                description={i18n.t(
                  "admin.pdf-export.tab.settings.description",
                )}
              >
                <SettingsTab />
              </PdfTabFrame>
            </TabsContent>
          </Stack>
        </AdminPageScroll>
      </Tabs>
    </AdminPageFrame>
  );
}

export { PdfExportPage as Component };
