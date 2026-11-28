// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useWorkspaceInfo } from "@myoxus/core/components/hooks/use-workspace-info";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { UserPreferencesService } from "@myoxus/core/modules/server/services/user-preferences";
import {
  AssistancePreference,
  LocalAssistancePreference,
} from "@myoxus/core/modules/server/views/assistance-preference";
import { GlobalState } from "@myoxus/core/modules/storage";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { UNTITLED_WORKSPACE_NAME } from "@myoxus/env/constant";
import { useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { FrameworkScope, useService } from "@myoxus/infra";
import { useCallback } from "react";

import {
  MyoxusText,
  SettingHeader,
  SettingRow,
  SettingWrapper,
} from "../../primitives";
import { DeleteLeaveWorkspace } from "./delete-leave-workspace";
import { EnableCloudPanel } from "./enable-cloud";
import { LabelsPanel } from "./labels";
import { ProfilePanel } from "./profile";
import { SharingPanel } from "./sharing";
import { TemplateDocSetting } from "./template";
import type { WorkspaceSettingDetailProps } from "./types";

export const WorkspaceSettingDetail = ({
  onCloseSetting,
}: WorkspaceSettingDetailProps) => {
  const t = useI18n();
  const globalState = useService(GlobalState);
  const workspace = useService(WorkspaceService).workspace;
  const server = workspace?.scope.get(WorkspaceServerService).server;
  const workspaceInfo = useWorkspaceInfo(workspace);

  const handleResetSync = useCallback(() => {
    workspace?.engine.doc
      .resetSync()
      .then(() => onCloseSetting())
      .catch((error) => {
        console.error(error);
      });
  }, [onCloseSetting, workspace]);

  return (
    <FrameworkScope scope={server?.scope}>
      <SettingHeader
        title={t["Workspace Settings with name"]({
          name: workspaceInfo?.name ?? UNTITLED_WORKSPACE_NAME,
        })}
        subtitle={t["com.myoxus.settings.workspace.description"]()}
      />
      <SettingWrapper title={t["Info"]()}>
        <SettingRow name={t["Workspace Profile"]()} spreadCol={false}>
          <ProfilePanel />
          <LabelsPanel />
          {workspace.flavour === "local" && canUseLocalWorkspaces() ? (
            <EnableCloudPanel onCloseSetting={onCloseSetting} />
          ) : null}
        </SettingRow>
      </SettingWrapper>
      {server && workspace.flavour !== "local" ? (
        <SettingWrapper>
          <AssistancePreference
            service={server.scope.get(UserPreferencesService)}
            workspaceId={workspace.id}
          />
        </SettingWrapper>
      ) : null}
      {workspace.flavour === "local" && canUseLocalWorkspaces() ? (
        <SettingWrapper>
          <LocalAssistancePreference
            state={globalState}
            workspaceId={workspace.id}
          />
        </SettingWrapper>
      ) : null}
      <TemplateDocSetting />
      <SharingPanel />
      <SettingWrapper>
        <DeleteLeaveWorkspace onCloseSetting={onCloseSetting} />
        {canUseLocalWorkspaces() && (
          <SettingRow
            name={
              <MyoxusText
                component="span"
                tone="secondary"
                typographySlot="body-small"
                data-myoxus-ui-role="workspace-preference-reset-sync-label"
              >
                {t["com.myoxus.resetSyncStatus.button"]()}
              </MyoxusText>
            }
            desc={t["com.myoxus.resetSyncStatus.description"]()}
            onClick={handleResetSync}
            data-testid="reset-sync-status"
          >
            <ArrowRightSmallIcon />
          </SettingRow>
        )}
      </SettingWrapper>
    </FrameworkScope>
  );
};
