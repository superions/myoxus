import {
  type EffectiveUserPreferenceValues,
  UserPreferencesService,
} from "@myoxus/core/modules/server";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  notify,
  SettingHeader,
  SettingRow,
  SettingsStatusText,
  SettingWrapper,
  Switch,
} from "../../primitives";

export const NotificationSettings = () => {
  const t = useI18n();
  const userPreferencesService = useService(UserPreferencesService);

  useEffect(() => {
    void userPreferencesService.revalidate();
  }, [userPreferencesService]);

  const userPreferences = useLiveData(userPreferencesService.userPreferences$);
  const [isMutating, setIsMutating] = useState(false);
  const failedSaveFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isMutating && failedSaveFocus.current) {
      const control = failedSaveFocus.current;
      failedSaveFocus.current = null;
      if (control.isConnected) control.focus();
    }
  }, [isMutating]);
  const error = useLiveData(userPreferencesService.error$);
  const errorMessage = useMemo(() => {
    if (error) {
      const userFriendlyError = UserFriendlyError.fromAny(error);
      return t[`error.${userFriendlyError.name}`](userFriendlyError.data);
    }
    return null;
  }, [error, t]);

  const values = userPreferences?.effectiveValues;
  const disable = !values || isMutating;

  const handleUpdate = useCallback(
    (
      key: keyof Pick<
        EffectiveUserPreferenceValues,
        | "receiveMentionEmail"
        | "receiveInvitationEmail"
        | "receiveCommentEmail"
        | "notifyCreatedDocuments"
      >,
      value: boolean,
    ) => {
      const control =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setIsMutating(true);
      userPreferencesService
        .update(
          { [key]: value },
          { rollbackOnError: key === "notifyCreatedDocuments" },
        )
        .catch((err) => {
          failedSaveFocus.current = control;
          const userFriendlyError = UserFriendlyError.fromAny(err);
          notify.error({
            title: t[`error.${userFriendlyError.name}`](userFriendlyError.data),
          });
        })
        .finally(() => {
          setIsMutating(false);
        });
    },
    [userPreferencesService, t],
  );

  return (
    <>
      <SettingHeader
        title={t["com.myoxus.setting.notifications.header.title"]()}
        subtitle={t["com.myoxus.setting.notifications.header.description"]()}
      />
      <SettingWrapper
        title={t["com.myoxus.setting.notifications.in-app.title"]()}
      >
        <SettingRow
          name={t["com.myoxus.setting.notifications.created-documents.title"]()}
          desc={t[
            "com.myoxus.setting.notifications.created-documents.subtitle"
          ]()}
        >
          <Switch
            data-testid="notification-created-documents-trigger"
            aria-label={t[
              "com.myoxus.setting.notifications.created-documents.title"
            ]()}
            checked={values?.notifyCreatedDocuments ?? false}
            disabled={
              disable || typeof values?.notifyCreatedDocuments !== "boolean"
            }
            onChange={(checked) =>
              handleUpdate("notifyCreatedDocuments", checked)
            }
          />
        </SettingRow>
      </SettingWrapper>
      <SettingWrapper
        title={t["com.myoxus.setting.notifications.email.title"]()}
      >
        {!values && errorMessage && (
          <SettingsStatusText tone="error">{errorMessage}</SettingsStatusText>
        )}
        <SettingRow
          name={t["com.myoxus.setting.notifications.email.mention.title"]()}
          desc={t["com.myoxus.setting.notifications.email.mention.subtitle"]()}
        >
          <Switch
            data-testid="notification-email-mention-trigger"
            checked={values?.receiveMentionEmail ?? false}
            disabled={disable}
            onChange={(checked) => handleUpdate("receiveMentionEmail", checked)}
          />
        </SettingRow>
        <SettingRow
          name={t["com.myoxus.setting.notifications.email.invites.title"]()}
          desc={t["com.myoxus.setting.notifications.email.invites.subtitle"]()}
        >
          <Switch
            data-testid="notification-email-invites-trigger"
            checked={values?.receiveInvitationEmail ?? false}
            disabled={disable}
            onChange={(checked) =>
              handleUpdate("receiveInvitationEmail", checked)
            }
          />
        </SettingRow>
        <SettingRow
          name={t["com.myoxus.setting.notifications.email.comments.title"]()}
          desc={t["com.myoxus.setting.notifications.email.comments.subtitle"]()}
        >
          <Switch
            data-testid="notification-email-comments-trigger"
            checked={values?.receiveCommentEmail ?? false}
            disabled={disable}
            onChange={(checked) => handleUpdate("receiveCommentEmail", checked)}
          />
        </SettingRow>
      </SettingWrapper>
    </>
  );
};
