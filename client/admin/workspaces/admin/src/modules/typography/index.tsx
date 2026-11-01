// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Typography - top-level admin page (`/adminfrontend/typography`).
 */
import { useI18n } from "@myoxus/i18n";

import { AdminPageFrame } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import {
  ScopedTypographyEditor,
  TYPOGRAPHY_TAB_IDS,
} from "./scoped-typography-editor";

export function TypographyPage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(
    TYPOGRAPHY_TAB_IDS,
    "font-library",
  );

  return (
    <AdminPageFrame
      title={i18n.t("admin.typography.title")}
      routeAnchor="admin-route-typography"
    >
      <ScopedTypographyEditor
        workspaceId={null}
        layout="page"
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
      />
    </AdminPageFrame>
  );
}

export { TypographyPage as Component };
export default TypographyPage;
