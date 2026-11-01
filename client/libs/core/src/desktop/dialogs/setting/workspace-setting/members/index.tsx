import { MyoxusErrorBoundary } from "@myoxus/core/components/myoxus/myoxus-error-boundary";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import type { ReactElement } from "react";

import {
  Button,
  SettingRow,
  SettingsSection,
  Stack,
  Tooltip,
} from "../../primitives";
import { EnableCloudPanel } from "../preference/enable-cloud";
import { CloudWorkspaceMembersPanel } from "./cloud-members-panel";

export const MembersPanel = ({
  onCloseSetting,
}: {
  onCloseSetting: () => void;
}): ReactElement | null => {
  const workspace = useService(WorkspaceService).workspace;
  if (workspace.flavour === "local") {
    return (
      <MembersPanelLocal
        onCloseSetting={onCloseSetting}
        showEnableCloud={canUseLocalWorkspaces()}
      />
    );
  }
  return (
    <MyoxusErrorBoundary>
      <CloudWorkspaceMembersPanel />
    </MyoxusErrorBoundary>
  );
};

const MembersPanelLocal = ({
  onCloseSetting,
  showEnableCloud,
}: {
  onCloseSetting: () => void;
  showEnableCloud: boolean;
}) => {
  const t = useI18n();
  return (
    <Stack>
      <Tooltip content={t["Enable cloud hint"]()}>
        <SettingsSection disabled>
          <SettingRow name={`${t["Members"]()} (0)`} desc={t["Members hint"]()}>
            <Button disabled>{t["Invite Members"]()}</Button>
          </SettingRow>
        </SettingsSection>
      </Tooltip>
      {showEnableCloud ? (
        <EnableCloudPanel onCloseSetting={onCloseSetting} />
      ) : null}
    </Stack>
  );
};
