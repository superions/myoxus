import { useGuard } from "@myoxus/core/components/guard";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { ServerService } from "@myoxus/core/modules/server";
import { WorkspaceShareSettingService } from "@myoxus/core/modules/share-setting";
import { useLiveData, useService } from "@myoxus/infra";

type WorkspaceAIEnableState = {
  clientFeature: boolean | null | undefined;
  serverCopilot: boolean | null | undefined;
  workspaceEnabled: boolean | null | undefined;
  workspaceCopilotPermission: boolean | null | undefined;
};

export const isAIEnabledForWorkspace = ({
  clientFeature,
  serverCopilot,
  workspaceEnabled,
  workspaceCopilotPermission,
}: WorkspaceAIEnableState) => {
  // All four signals are existing product gates: the local feature flag, the
  // server-wide Copilot capability, the workspace AI switch, and the user's
  // workspace-level Copilot permission. Loading/unknown states stay disabled to
  // avoid briefly exposing AI entry points in workspaces where AI is off.
  return (
    clientFeature === true &&
    serverCopilot === true &&
    workspaceEnabled === true &&
    workspaceCopilotPermission === true
  );
};

export const useEnableAI = () => {
  const featureFlagService = useService(FeatureFlagService);
  const aiFeature = useLiveData(featureFlagService.flags.enable_ai.$);

  const serverService = useService(ServerService);
  const serverFeatures = useLiveData(serverService.server.features$);
  const workspaceShareSettingService = useService(WorkspaceShareSettingService);
  const workspaceEnableAI = useLiveData(
    workspaceShareSettingService.sharePreview.enableAi$,
  );
  const canUseWorkspaceAI = useGuard("Workspace_Copilot");

  return isAIEnabledForWorkspace({
    clientFeature: aiFeature,
    serverCopilot: serverFeatures?.copilot,
    workspaceEnabled: workspaceEnableAI,
    workspaceCopilotPermission: canUseWorkspaceAI,
  });
};
