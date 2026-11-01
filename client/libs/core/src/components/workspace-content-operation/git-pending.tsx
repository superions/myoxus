// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  WorkspaceContentGitSyncChoiceType,
  type WorkspaceContentOperationProjectionFragment,
} from "@myoxus/graphql";
import { useI18n, workspaceContentFailureKey } from "@myoxus/i18n";
import { MyoxusText, SettingsNotice } from "@myoxus/ui-facade";

/** Content has already succeeded: a Git cause is never a failed extraction. */
export function GitContentPendingNotice({
  operation,
}: {
  operation: WorkspaceContentOperationProjectionFragment;
}) {
  const t = useI18n();
  const key = workspaceContentFailureKey(null, operation.gitSyncErrorCode);
  return (
    <SettingsNotice
      tone="warning"
      role="status"
      data-testid="workspace-content-git-pending"
      title={
        operation.gitSync?.isUndo
          ? t["com.myoxus.workspace-content-operation.git.pending-undo"]()
          : operation.gitSync?.choice ===
              WorkspaceContentGitSyncChoiceType.Disconnect
            ? t[
                "com.myoxus.workspace-content-operation.git.pending-disconnect"
              ]()
            : t["com.myoxus.workspace-content-operation.git.pending-move"]()
      }
    >
      <MyoxusText>
        {key
          ? t[key]()
          : t["com.myoxus.workspace-content-operation.git.pending-detail"]()}
      </MyoxusText>
      <MyoxusText>
        {t["com.myoxus.workspace-content-operation.error.operation-id"]({
          id: operation.id,
        })}
      </MyoxusText>
    </SettingsNotice>
  );
}
