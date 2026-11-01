import { useGuard } from "@myoxus/core/components/guard/use-guard";
import { useCatchEventCallback } from "@myoxus/core/components/hooks/use-catch-event-hook";
import { Upload } from "@myoxus/core/components/pure/file-upload";
import { WorkspaceAvatar } from "@myoxus/core/components/workspace-avatar";
import { WorkspacePermissionService } from "@myoxus/core/modules/permissions";
import {
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { validateAndReduceImage } from "@myoxus/core/utils/reduce-image";
import { UNTITLED_WORKSPACE_NAME } from "@myoxus/env/constant";
import { useI18n } from "@myoxus/i18n";
import { CameraIcon } from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { map } from "rxjs";

import {
  Button,
  Input,
  MyoxusText,
  notify,
  SettingsInlineControl,
} from "../../primitives";

export const ProfilePanel = () => {
  const t = useI18n();

  const workspace = useService(WorkspaceService).workspace;
  const workspacesService = useService(WorkspacesService);
  const permissionService = useService(WorkspacePermissionService);
  const isOwner = useLiveData(permissionService.permission.isOwner$);
  const canUpdateWorkspaceSettings = useGuard("Workspace_Settings_Update");
  useEffect(() => {
    permissionService.permission.revalidate();
  }, [permissionService]);
  const workspaceIsReady = useLiveData(
    useMemo(() => {
      return workspace
        ? LiveData.from(
            workspace.engine.doc
              .docState$(workspace.id)
              .pipe(map((v) => v.ready)),
            false,
          )
        : null;
    }, [workspace]),
  );
  const [name, setName] = useState("");
  const currentName = useLiveData(workspace.name$);

  useEffect(() => {
    setName(currentName ?? UNTITLED_WORKSPACE_NAME);
  }, [currentName]);

  const setWorkspaceAvatar = useCallback(
    async (file: File | null) => {
      if (!workspace) {
        return;
      }
      if (!file) {
        workspace.setAvatar("");
        return;
      }
      try {
        const reducedFile = await validateAndReduceImage(file);
        const blobs = workspace.docCollection.blobSync;
        const blobId = await blobs.set(reducedFile);
        workspace.setAvatar(blobId);
      } catch (error) {
        console.error(error);
        throw error;
      }
    },
    [workspace],
  );

  const [input, setInput] = useState<string>("");
  useEffect(() => {
    setInput(name);
  }, [name]);

  const handleUpdateWorkspaceName = useCallback(
    async (name: string) => {
      try {
        await workspacesService.updateWorkspaceName(workspace, name);
        notify.success({ title: t["Update workspace name success"]() });
      } catch (error) {
        notify.error({
          title: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [workspace, workspacesService, t],
  );

  const handleSetInput = useCallback((value: string) => {
    setInput(value);
  }, []);

  const handleKeyUp = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.code === "Enter" && name !== input) {
        void handleUpdateWorkspaceName(input);
      }
    },
    [handleUpdateWorkspaceName, input, name],
  );

  const handleClick = useCallback(() => {
    void handleUpdateWorkspaceName(input);
  }, [handleUpdateWorkspaceName, input]);

  const handleRemoveUserAvatar = useCatchEventCallback(async () => {
    await setWorkspaceAvatar(null);
  }, [setWorkspaceAvatar]);

  const handleUploadAvatar = useCallback(
    (file: File) => {
      setWorkspaceAvatar(file)
        .then(() => {
          notify.success({
            title:
              t[
                "com.myoxus.settings.workspace.profile.avatar.upload-success"
              ](),
          });
        })
        .catch((error) => {
          notify.error({
            title:
              t["com.myoxus.settings.workspace.profile.avatar.upload-failed"](),
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [setWorkspaceAvatar, t],
  );

  const canAdjustAvatar = workspaceIsReady && isOwner;

  return (
    <SettingsInlineControl
      wrap
      data-myoxus-ui-role="workspace-preference-profile"
    >
      <Upload
        accept="image/gif,image/jpeg,image/jpg,image/png,image/svg"
        fileChange={handleUploadAvatar}
        data-testid="upload-avatar"
        disabled={!isOwner}
      >
        <WorkspaceAvatar
          meta={workspace.meta}
          size="lg"
          name={name}
          colorfulFallback
          hoverIcon={isOwner ? <CameraIcon /> : undefined}
          onRemove={canAdjustAvatar ? handleRemoveUserAvatar : undefined}
          avatarTooltipOptions={
            canAdjustAvatar
              ? { content: t["Click to replace photo"]() }
              : undefined
          }
          removeTooltipOptions={
            canAdjustAvatar ? { content: t["Remove photo"]() } : undefined
          }
          data-testid="workspace-setting-avatar"
          removeButtonProps={{
            ["data-testid" as string]: "workspace-setting-remove-avatar-button",
          }}
        />
      </Upload>

      <SettingsInlineControl
        wrap
        aria-label={t["Workspace Name"]()}
        data-myoxus-ui-role="workspace-preference-name-control"
      >
        <MyoxusText
          component="span"
          tone="secondary"
          typographySlot="body-small"
          data-myoxus-ui-role="workspace-preference-name-label"
        >
          {t["Workspace Name"]()}
        </MyoxusText>
        <Input
          disabled={!canUpdateWorkspaceSettings}
          value={input}
          block
          data-testid="workspace-name-input"
          placeholder={t["Workspace Name"]()}
          maxLength={64}
          minLength={0}
          onChange={handleSetInput}
          onKeyUp={handleKeyUp}
        />
        {input === name && workspace.meta.name === name ? null : (
          <Button data-testid="save-workspace-name" onClick={handleClick}>
            {t["com.myoxus.editCollection.save"]()}
          </Button>
        )}
      </SettingsInlineControl>
    </SettingsInlineControl>
  );
};
