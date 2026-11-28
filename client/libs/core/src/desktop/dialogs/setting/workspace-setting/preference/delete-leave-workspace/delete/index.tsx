// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

interface WorkspaceDeleteModalProps extends ConfirmModalProps {
  workspaceMetadata: WorkspaceMetadata;
  onConfirm?: () => void;
}

export const WorkspaceDeleteModal = ({
  workspaceMetadata,
  ...props
}: WorkspaceDeleteModalProps) => {
  const { onConfirm } = props;
  const t = useI18n();
  const [confirmationInput, setConfirmationInput] = useState("");
  const info = useWorkspaceInfo(workspaceMetadata);
  const workspaceName = info?.name ?? UNTITLED_WORKSPACE_NAME;
  const canDelete = confirmationInput === workspaceName;

  const handleEnter = useCallback(() => {
    if (canDelete) onConfirm?.();
  }, [canDelete, onConfirm]);

  const nameHighlight = (
    <MyoxusText
      component="strong"
      tone="primary"
      typographySlot="body-small"
      data-myoxus-ui-role="workspace-delete-modal-workspace-name"
    >
      {{ workspace: workspaceName } as unknown as string}
    </MyoxusText>
  );

  return (
    <ConfirmModal
      title={`${t["com.myoxus.workspaceDelete.title"]()}?`}
      cancelText={t["com.myoxus.workspaceDelete.button.cancel"]()}
      confirmText={t["com.myoxus.workspaceDelete.button.delete"]()}
      confirmButtonOptions={{
        variant: "error",
        disabled: !canDelete,
        "data-testid": "delete-workspace-confirm-button",
      }}
      {...props}
    >
      {workspaceMetadata.flavour === "local" ? (
        <Trans i18nKey="com.myoxus.workspaceDelete.description">
          Deleting ({nameHighlight}) cannot be undone, please proceed with
          caution. All contents will be lost.
        </Trans>
      ) : (
        <Trans i18nKey="com.myoxus.workspaceDelete.description2">
          Deleting ({nameHighlight}) will delete both local and cloud data, this
          operation cannot be undone, please proceed with caution.
        </Trans>
      )}
      <SettingsInlineControl data-myoxus-ui-role="workspace-delete-modal-input-control">
        <Input
          autoFocus
          onChange={setConfirmationInput}
          data-testid="delete-workspace-input"
          onEnter={handleEnter}
          placeholder={t["com.myoxus.workspaceDelete.placeholder"]()}
          size="large"
        />
      </SettingsInlineControl>
    </ConfirmModal>
  );
};
