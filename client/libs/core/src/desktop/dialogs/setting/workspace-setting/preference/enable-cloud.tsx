// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useEnableServer } from "@myoxus/core/components/hooks/myoxus/use-enable-server";
import {
  type Workspace,
  WorkspaceService,
} from "@myoxus/core/modules/workspace";
import { UNTITLED_WORKSPACE_NAME } from "@myoxus/env/constant";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback } from "react";

import { Button, SettingRow } from "../../primitives";

export interface PublishPanelProps {
  workspace: Workspace | null;
}

export const EnableCloudPanel = ({
  onCloseSetting,
}: {
  onCloseSetting?: () => void;
}) => {
  const t = useI18n();
  const migrateWorkspaceToServer = useEnableServer();
  const workspace = useService(WorkspaceService).workspace;
  const name = useLiveData(workspace.name$);

  const handleEnableCloud = useCallback(() => {
    if (!workspace) return;
    migrateWorkspaceToServer(workspace, {
      onSuccess: () => onCloseSetting?.(),
    });
  }, [migrateWorkspaceToServer, onCloseSetting, workspace]);

  if (workspace.flavour !== "local") return null;

  return (
    <SettingRow
      name={t["Workspace saved locally"]({
        name: name ?? UNTITLED_WORKSPACE_NAME,
      })}
      desc={t["Enable cloud hint"]()}
      spreadCol={false}
    >
      <Button
        data-testid="publish-enable-myoxus-cloud-button"
        variant="primary"
        onClick={handleEnableCloud}
      >
        {t["Enable Myoxus Cloud"]()}
      </Button>
    </SettingRow>
  );
};
