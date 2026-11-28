// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

type NotificationPreferenceKey = keyof Pick<
  EffectiveUserPreferenceValues,
  | "receiveMentionEmail"
  | "receiveInvitationEmail"
  | "receiveCommentEmail"
  | "notifyCreatedDocuments"
>;

export const NotificationSettings = () => {
  const t = useI18n();
  const userPreferencesService = useService(UserPreferencesService);
  const preferences = useLiveData(userPreferencesService.userPreferences$);
  const loadError = useLiveData(userPreferencesService.error$);
  const [saving, setSaving] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void userPreferencesService.revalidate();
  }, [userPreferencesService]);

  useEffect(() => {
    if (!saving && restoreFocusRef.current) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target.isConnected) {
        target.focus();
      }
    }
  }, [saving]);

  const errorMessage = useMemo(() => {
    if (!loadError) return null;
    const friendly = UserFriendlyError.fromAny(loadError);
    return t[`error.${friendly.name}`](friendly.data);
  }, [loadError, t]);

  const values = preferences?.effectiveValues;
  const controlsDisabled = !values || saving;

  const updateToggle = useCallback(
    (key: NotificationPreferenceKey, checked: boolean) => {
      const activeControl =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setSaving(true);
      userPreferencesService
        .update(
          { [key]: checked },
          { rollbackOnError: key === "notifyCreatedDocuments" },
        )
        .catch((error) => {
          restoreFocusRef.current = activeControl;
          const friendly = UserFriendlyError.fromAny(error);
          notify.error({
            title: t[`error.${friendly.name}`](friendly.data),
          });
        })
        .finally(() => {
          setSaving(false);
        });
    },
    [t, userPreferencesService],
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
              controlsDisabled ||
              typeof values?.notifyCreatedDocuments !== "boolean"
            }
            onChange={(checked) =>
              updateToggle("notifyCreatedDocuments", checked)
            }
          />
        </SettingRow>
      </SettingWrapper>

      <SettingWrapper
        title={t["com.myoxus.setting.notifications.email.title"]()}
      >
        {!values && errorMessage ? (
          <SettingsStatusText tone="error">{errorMessage}</SettingsStatusText>
        ) : null}

        <SettingRow
          name={t["com.myoxus.setting.notifications.email.mention.title"]()}
          desc={t["com.myoxus.setting.notifications.email.mention.subtitle"]()}
        >
          <Switch
            data-testid="notification-email-mention-trigger"
            checked={values?.receiveMentionEmail ?? false}
            disabled={controlsDisabled}
            onChange={(checked) => updateToggle("receiveMentionEmail", checked)}
          />
        </SettingRow>

        <SettingRow
          name={t["com.myoxus.setting.notifications.email.invites.title"]()}
          desc={t["com.myoxus.setting.notifications.email.invites.subtitle"]()}
        >
          <Switch
            data-testid="notification-email-invites-trigger"
            checked={values?.receiveInvitationEmail ?? false}
            disabled={controlsDisabled}
            onChange={(checked) =>
              updateToggle("receiveInvitationEmail", checked)
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
            disabled={controlsDisabled}
            onChange={(checked) => updateToggle("receiveCommentEmail", checked)}
          />
        </SettingRow>
      </SettingWrapper>
    </>
  );
};
