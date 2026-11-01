import { ConfigModal } from "@myoxus/core/components/mobile";
import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { AuthService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { useEffect } from "react";

import { WorkspaceSetting } from "../../../desktop/dialogs/setting/workspace-setting";
import { AboutGroup } from "./about";
import { AppearanceGroup } from "./appearance";
import { ExperimentalFeatureSetting } from "./experimental";
import { OthersGroup } from "./others";
import { UserProfile } from "./user-profile";
import { UserUsage } from "./user-usage";

const MobileSetting = () => {
  const session = useService(AuthService).session;
  useEffect(() => session.revalidate(), [session]);

  return (
    <>
      <UserProfile />
      <UserUsage />
      <AppearanceGroup />
      <AboutGroup />
      <ExperimentalFeatureSetting />
      <OthersGroup />
    </>
  );
};

export const UserSettingDialog = ({
  close,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["user-settings"]>) => {
  const t = useI18n();

  return (
    <ConfigModal
      title={t["com.myoxus.mobile.setting.header-title"]()}
      open
      onOpenChange={() => close()}
      onBack={close}
    >
      <MobileSetting />
    </ConfigModal>
  );
};

export const WorkspaceSettingDialog = ({
  close,
  activeTab = "workspace:preference",
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["workspace-settings"]>) => {
  const t = useI18n();

  return (
    <ConfigModal
      title={t["com.myoxus.settingSidebar.settings.workspace"]()}
      open
      onOpenChange={() => close()}
      onBack={close}
    >
      <WorkspaceSetting activeTab={activeTab} onCloseSetting={close} />
    </ConfigModal>
  );
};
