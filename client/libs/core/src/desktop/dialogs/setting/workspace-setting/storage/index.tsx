import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";

import { SettingsPage, SettingsSection } from "../../primitives";
import { EnableCloudPanel } from "../preference/enable-cloud";
import { BlobManagementPanel } from "./blob-management";
import { DesktopExportPanel } from "./export";
import { WorkspaceQuotaPanel } from "./workspace-quota";

export const WorkspaceSettingStorage = ({
  onCloseSetting,
}: {
  onCloseSetting: () => void;
}) => {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  return (
    <SettingsPage
      title={t["Storage"]()}
      subtitle={t["com.myoxus.settings.workspace.storage.subtitle"]()}
    >
      {workspace.flavour === "local" ? (
        <>
          {canUseLocalWorkspaces() ? (
            <EnableCloudPanel onCloseSetting={onCloseSetting} />
          ) : null}
          {BUILD_CONFIG.isElectron && (
            <SettingsSection>
              <DesktopExportPanel workspace={workspace} />
            </SettingsSection>
          )}
        </>
      ) : (
        <>
          <SettingsSection title={t["com.myoxus.workspace.storage"]()}>
            <WorkspaceQuotaPanel />
          </SettingsSection>

          <SettingsSection>
            <DesktopExportPanel workspace={workspace} />
          </SettingsSection>

          <SettingsSection
            title={t["com.myoxus.settings.workspace.storage.unused-blobs"]()}
          >
            <BlobManagementPanel />
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
};
