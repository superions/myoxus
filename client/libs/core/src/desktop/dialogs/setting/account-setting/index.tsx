// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useSignOut } from "@myoxus/core/components/hooks/myoxus/use-sign-out";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useCatchEventCallback } from "@myoxus/core/components/hooks/use-catch-event-hook";
import { Upload } from "@myoxus/core/components/pure/file-upload";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon, CameraIcon } from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { useCallback, useEffect, useState } from "react";

import { AuthService, ServerService } from "../../../../modules/server";
import { UserPreferencesService } from "../../../../modules/server/services/user-preferences";
import { AssistancePreference } from "../../../../modules/server/views/assistance-preference";
import {
  Avatar,
  Button,
  Input,
  notify,
  SettingHeader,
  SettingRow,
  SettingsInlineControl,
  SettingWrapper,
} from "../primitives";
import { DeleteAccount } from "./delete-account";
import { StorageProgress } from "./storage-progress";

export const UserAvatar = () => {
  const t = useI18n();
  const session = useService(AuthService).session;
  const account = useLiveData(session.account$);

  const handleUploadAvatar = useAsyncCallback(
    async (file: File) => {
      try {
        track.$.settingsPanel.accountSettings.uploadAvatar();
        await session.uploadAvatar(file);
        notify.success({
          title: t["com.myoxus.settings.account.avatar.upload-success"](),
        });
      } catch (error) {
        notify.error({
          title: t["com.myoxus.settings.account.avatar.upload-failed"](),
          message: String(error),
        });
      }
    },
    [session, t],
  );

  const handleRemoveAvatar = useCatchEventCallback(async () => {
    track.$.settingsPanel.accountSettings.removeAvatar();
    await session.removeAvatar();
  }, [session]);

  return (
    <Upload
      accept="image/gif,image/jpeg,image/jpg,image/png,image/svg"
      fileChange={handleUploadAvatar}
      data-testid="upload-user-avatar"
    >
      <Avatar
        size="xl"
        name={account?.label}
        url={account?.avatar}
        colorfulFallback
        hoverIcon={<CameraIcon />}
        onRemove={account?.avatar ? handleRemoveAvatar : undefined}
        avatarTooltipOptions={{ content: t["Click to replace photo"]() }}
        removeTooltipOptions={{ content: t["Remove photo"]() }}
        data-testid="user-setting-avatar"
        removeButtonProps={{
          ["data-testid" as string]: "user-setting-remove-avatar-button",
        }}
      />
    </Upload>
  );
};

export const AvatarAndName = () => {
  const t = useI18n();
  const session = useService(AuthService).session;
  const account = useLiveData(session.account$);
  const [input, setInput] = useState(account?.label ?? "");

  const canSave = Boolean(input) && input !== account?.label;

  const handleSaveName = useAsyncCallback(async () => {
    if (!account || !canSave) return;
    try {
      track.$.settingsPanel.accountSettings.updateUserName();
      await session.updateLabel(input);
    } catch (error) {
      notify.error({
        title: t["com.myoxus.settings.account.name.update-failed"](),
        message: String(error),
      });
    }
  }, [account, canSave, input, session, t]);

  return (
    <SettingRow
      name={t["com.myoxus.settings.profile.name"]()}
      desc={t["com.myoxus.settings.profile.message"]()}
      spreadCol={false}
    >
      <SettingsInlineControl
        wrap
        aria-label={t["com.myoxus.settings.profile.name"]()}
        data-myoxus-ui-role="account-profile-inline-control"
      >
        <UserAvatar />
        <Input
          defaultValue={input}
          data-testid="user-name-input"
          placeholder={t["com.myoxus.settings.profile.placeholder"]()}
          maxLength={64}
          minLength={0}
          onChange={setInput}
          onEnter={handleSaveName}
        />
        {canSave ? (
          <Button data-testid="save-user-name" onClick={handleSaveName}>
            {t["com.myoxus.editCollection.save"]()}
          </Button>
        ) : null}
      </SettingsInlineControl>
    </SettingRow>
  );
};

export const AccountSetting = () => {
  const { authService, serverService, globalDialogService } = useServices({
    AuthService,
    ServerService,
    GlobalDialogService,
  });
  const preferences = useService(UserPreferencesService);
  const t = useI18n();
  const session = authService.session;
  const account = useLiveData(session.account$);
  const openSignOutModal = useSignOut();

  useEffect(() => {
    session.revalidate();
  }, [session]);

  const handleOpenEmailDialog = useCallback(() => {
    if (!account) return;
    globalDialogService.open("verify-email", {
      server: serverService.server.baseUrl,
      changeEmail: Boolean(account.info?.emailVerified),
    });
  }, [account, globalDialogService, serverService.server.baseUrl]);

  const handleOpenPasswordDialog = useCallback(() => {
    globalDialogService.open("change-password", {
      server: serverService.server.baseUrl,
    });
  }, [globalDialogService, serverService.server.baseUrl]);

  if (!account) return null;

  return (
    <>
      <SettingHeader
        title={t["com.myoxus.setting.account"]()}
        subtitle={t["com.myoxus.setting.account.message"]()}
        data-testid="account-title"
      />
      <SettingWrapper>
        <AvatarAndName />
      </SettingWrapper>
      <SettingWrapper>
        <AssistancePreference service={preferences} />
      </SettingWrapper>
      <SettingWrapper>
        <SettingRow
          name={t["com.myoxus.settings.email"]()}
          desc={account.email}
        >
          <Button onClick={handleOpenEmailDialog}>
            {account.info?.emailVerified
              ? t["com.myoxus.settings.email.action.change"]()
              : t["com.myoxus.settings.email.action.verify"]()}
          </Button>
        </SettingRow>
        <SettingRow
          name={t["com.myoxus.settings.password"]()}
          desc={t["com.myoxus.settings.password.message"]()}
        >
          <Button onClick={handleOpenPasswordDialog}>
            {account.info?.hasPassword
              ? t["com.myoxus.settings.password.action.change"]()
              : t["com.myoxus.settings.password.action.set"]()}
          </Button>
        </SettingRow>
        <SettingRow name={t["Storage"]()} desc="" spreadCol={false}>
          <StorageProgress />
        </SettingRow>
        <SettingRow
          name={t["Sign out"]()}
          desc={t["com.myoxus.setting.sign.out.message"]()}
          data-testid="sign-out-button"
          onClick={openSignOutModal}
        >
          <ArrowRightSmallIcon />
        </SettingRow>
      </SettingWrapper>
      <DeleteAccount />
    </>
  );
};
