// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { useI18n } from "@myoxus/i18n";

import { SettingsDialogFrame } from "./dialog-frame";
import { WorkspaceSettingsSidebar } from "./setting-sidebar";
import { WorkspaceSetting } from "./workspace-setting";

export const WorkspaceSettingDialog = ({
  close,
  activeTab = "workspace:preference",
  scrollAnchor,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["workspace-settings"]>) => {
  const t = useI18n();
  const ariaLabel = t["com.myoxus.settingSidebar.settings.workspace"]();

  return (
    <SettingsDialogFrame
      ariaLabel={ariaLabel}
      close={close}
      initialActiveTab={activeTab}
      renderContent={({ activeTab }) => (
        <WorkspaceSetting activeTab={activeTab} onCloseSetting={close} />
      )}
      renderSidebar={({ activeTab, onTabChange }) => (
        <WorkspaceSettingsSidebar
          activeTab={activeTab}
          onTabChange={onTabChange}
        />
      )}
      scrollAnchor={scrollAnchor}
    />
  );
};
