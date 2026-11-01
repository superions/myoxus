// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type {
  UserSettingTab,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs/constant";
import { AuthService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";

import { AccountSetting } from "./account-setting";
import {
  SettingsDialogFrame,
  type SettingsDialogRenderProps,
} from "./dialog-frame";
import { GeneralSetting } from "./general-setting";
import { UserSettingsSidebar } from "./setting-sidebar";

const UserSettingsContent = ({
  activeTab,
}: SettingsDialogRenderProps<UserSettingTab>) => {
  const loginStatus = useLiveData(useService(AuthService).session.status$);

  if (activeTab === "account") {
    return loginStatus === "authenticated" ? <AccountSetting /> : null;
  }
  return <GeneralSetting activeTab={activeTab} />;
};

export const UserSettingDialog = ({
  close,
  activeTab = "appearance",
  scrollAnchor,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["user-settings"]>) => {
  const t = useI18n();
  const ariaLabel = t["com.myoxus.settingSidebar.title"]();

  return (
    <SettingsDialogFrame
      ariaLabel={ariaLabel}
      close={close}
      initialActiveTab={activeTab}
      renderContent={(props) => <UserSettingsContent {...props} />}
      renderSidebar={({ activeTab, onTabChange }) => (
        <UserSettingsSidebar activeTab={activeTab} onTabChange={onTabChange} />
      )}
      scrollAnchor={scrollAnchor}
    />
  );
};
