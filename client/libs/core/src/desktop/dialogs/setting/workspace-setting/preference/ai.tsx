import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspacePermissionService } from "@myoxus/core/modules/permissions";
import { ServerService } from "@myoxus/core/modules/server";
import { WorkspaceShareSettingService } from "@myoxus/core/modules/share-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";

import { SettingRow, SettingWrapper, Switch } from "../../primitives";

export const AiSetting = () => {
  const t = useI18n();
  const shareSetting = useService(WorkspaceShareSettingService).sharePreview;
  const serverService = useService(ServerService);
  const serverEnableAi = useLiveData(
    serverService.server.features$.map((f) => f?.copilot),
  );
  const workspaceEnableAi = useLiveData(shareSetting.enableAi$);
  const loading = useLiveData(shareSetting.isLoading$);
  const permissionService = useService(WorkspacePermissionService);
  const isOwner = useLiveData(permissionService.permission.isOwner$);

  const toggleAi = useAsyncCallback(
    async (checked: boolean) => {
      await shareSetting.setEnableAi(checked);
    },
    [shareSetting],
  );

  if (!isOwner || !serverEnableAi) {
    return null;
  }

  return (
    <SettingWrapper
      title={t["com.myoxus.settings.workspace.myoxus-ai.title"]()}
    >
      <SettingRow
        name={t["com.myoxus.settings.workspace.myoxus-ai.label"]()}
        desc={t["com.myoxus.settings.workspace.myoxus-ai.description"]()}
      >
        <Switch
          checked={!!workspaceEnableAi}
          onChange={toggleAi}
          disabled={loading}
        />
      </SettingRow>
    </SettingWrapper>
  );
};
