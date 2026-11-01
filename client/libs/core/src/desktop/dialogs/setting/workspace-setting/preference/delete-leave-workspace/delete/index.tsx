import { useWorkspaceInfo } from "@myoxus/core/components/hooks/use-workspace-info";
import type { WorkspaceMetadata } from "@myoxus/core/modules/workspace";
import { UNTITLED_WORKSPACE_NAME } from "@myoxus/env/constant";
import { Trans, useI18n } from "@myoxus/i18n";
import { useCallback, useState } from "react";

import {
  ConfirmModal,
  type ConfirmModalProps,
  Input,
  MyoxusText,
  SettingsInlineControl,
} from "../../../../primitives";

interface WorkspaceDeleteProps extends ConfirmModalProps {
  workspaceMetadata: WorkspaceMetadata;
  onConfirm?: () => void;
}

export const WorkspaceDeleteModal = ({
  workspaceMetadata,
  ...props
}: WorkspaceDeleteProps) => {
  const { onConfirm } = props;
  const [deleteStr, setDeleteStr] = useState<string>("");
  const info = useWorkspaceInfo(workspaceMetadata);
  const workspaceName = info?.name ?? UNTITLED_WORKSPACE_NAME;
  const allowDelete = deleteStr === workspaceName;
  const t = useI18n();

  const handleOnEnter = useCallback(() => {
    if (allowDelete) {
      return onConfirm?.();
    }
  }, [allowDelete, onConfirm]);

  return (
    <ConfirmModal
      title={`${t["com.myoxus.workspaceDelete.title"]()}?`}
      cancelText={t["com.myoxus.workspaceDelete.button.cancel"]()}
      confirmText={t["com.myoxus.workspaceDelete.button.delete"]()}
      confirmButtonOptions={{
        variant: "error",
        disabled: !allowDelete,
        "data-testid": "delete-workspace-confirm-button",
      }}
      {...props}
    >
      {workspaceMetadata.flavour === "local" ? (
        <Trans i18nKey="com.myoxus.workspaceDelete.description">
          Deleting (
          <MyoxusText
            component="strong"
            tone="primary"
            typographySlot="body-small"
            data-myoxus-ui-role="workspace-delete-modal-workspace-name"
          >
            {{ workspace: workspaceName } as any}
          </MyoxusText>
          ) cannot be undone, please proceed with caution. All contents will be
          lost.
        </Trans>
      ) : (
        <Trans i18nKey="com.myoxus.workspaceDelete.description2">
          Deleting (
          <MyoxusText
            component="strong"
            tone="primary"
            typographySlot="body-small"
            data-myoxus-ui-role="workspace-delete-modal-workspace-name"
          >
            {{ workspace: workspaceName } as any}
          </MyoxusText>
          ) will delete both local and cloud data, this operation cannot be
          undone, please proceed with caution.
        </Trans>
      )}
      <SettingsInlineControl data-myoxus-ui-role="workspace-delete-modal-input-control">
        <Input
          autoFocus
          onChange={setDeleteStr}
          data-testid="delete-workspace-input"
          onEnter={handleOnEnter}
          placeholder={t["com.myoxus.workspaceDelete.placeholder"]()}
          size="large"
        />
      </SettingsInlineControl>
    </ConfirmModal>
  );
};
