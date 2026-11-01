import { useGuard } from "@myoxus/core/components/guard";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspaceShareSettingService } from "@myoxus/core/modules/share-setting";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";

import {
  SettingRow,
  SettingWrapper,
  Switch,
  notify,
  useConfirmModal,
} from "../../primitives";

export const SharingPanel = () => {
  const workspace = useService(WorkspaceService).workspace;
  if (workspace.flavour === "local") {
    return null;
  }
  return <Sharing />;
};

export const Sharing = () => {
  const t = useI18n();
  const shareSetting = useService(WorkspaceShareSettingService).sharePreview;
  const enableSharing = useLiveData(shareSetting.enableSharing$);
  const publicAccess = useLiveData(shareSetting.public$);
  const publicDeliveryEnabled = useLiveData(
    shareSetting.publicDeliveryEnabled$,
  );
  const publicDocumentSelectionCount = useLiveData(
    shareSetting.publicDocumentSelectionCount$,
  );
  const enableUrlPreview = useLiveData(shareSetting.enableUrlPreview$);
  const loading = useLiveData(shareSetting.isLoading$);
  const error = useLiveData(shareSetting.error$);
  const canUpdateWorkspaceSettings = useGuard("Workspace_Settings_Update");
  const { openConfirmModal } = useConfirmModal();

  const handleToggleSharing = useAsyncCallback(
    async (checked: boolean) => {
      await shareSetting.setEnableSharing(checked);
    },
    [shareSetting],
  );

  const handleTogglePublic = useAsyncCallback(
    async (checked: boolean) => {
      openConfirmModal({
        title: checked
          ? t[
              "com.myoxus.settings.workspace.sharing.workspace-public.activate.title"
            ]()
          : t[
              "com.myoxus.settings.workspace.sharing.workspace-public.deactivate.title"
            ](),
        description: checked
          ? t[
              "com.myoxus.settings.workspace.sharing.workspace-public.activate.description"
            ]({ count: String(publicDocumentSelectionCount ?? 0) })
          : t[
              "com.myoxus.settings.workspace.sharing.workspace-public.deactivate.description"
            ](),
        cancelText: t["com.myoxus.confirmModal.button.cancel"](),
        confirmText: checked
          ? t[
              "com.myoxus.settings.workspace.sharing.workspace-public.activate.confirm"
            ]()
          : t[
              "com.myoxus.settings.workspace.sharing.workspace-public.deactivate.confirm"
            ](),
        confirmButtonOptions: checked ? undefined : { variant: "error" },
        onConfirm: async () => {
          try {
            await shareSetting.setPublic(checked);
          } catch (error) {
            const friendly = UserFriendlyError.fromAny(error);
            notify.error({ title: friendly.name, message: friendly.message });
            throw error;
          }
        },
      });
    },
    [openConfirmModal, publicDocumentSelectionCount, shareSetting, t],
  );

  const handleCheck = useAsyncCallback(
    async (checked: boolean) => {
      await shareSetting.setEnableUrlPreview(checked);
    },
    [shareSetting],
  );

  if (!canUpdateWorkspaceSettings) {
    return null;
  }

  return (
    <SettingWrapper title={t["com.myoxus.settings.workspace.sharing.title"]()}>
      <SettingRow
        name={t[
          "com.myoxus.settings.workspace.sharing.workspace-public.title"
        ]()}
        desc={
          publicDeliveryEnabled === false
            ? t[
                "com.myoxus.settings.workspace.sharing.workspace-public.server-disabled"
              ]()
            : t[
                "com.myoxus.settings.workspace.sharing.workspace-public.description"
              ]()
        }
      >
        <Switch
          checked={publicAccess ?? false}
          onChange={handleTogglePublic}
          disabled={
            loading ||
            error !== null ||
            (publicAccess !== true &&
              (publicDeliveryEnabled !== true || enableSharing !== true))
          }
        />
      </SettingRow>
      <SettingRow
        name={t["com.myoxus.settings.workspace.sharing.url-preview.title"]()}
        desc={t[
          "com.myoxus.settings.workspace.sharing.url-preview.description"
        ]()}
      >
        <Switch
          checked={enableUrlPreview || false}
          onChange={handleCheck}
          disabled={loading}
        />
      </SettingRow>
      <SettingRow
        name={t[
          "com.myoxus.settings.workspace.sharing.workspace-sharing.title"
        ]()}
        desc={t[
          "com.myoxus.settings.workspace.sharing.workspace-sharing.description"
        ]()}
      >
        <Switch
          checked={enableSharing ?? true}
          onChange={handleToggleSharing}
          disabled={loading}
        />
      </SettingRow>
    </SettingWrapper>
  );
};
