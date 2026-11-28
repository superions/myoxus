// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";

import {
  ErrorMessage,
  Progress,
  SettingsStatusText,
  SettingsToolbar,
  Skeleton,
  Stack,
} from "./primitives";

export interface StorageUsageMeterProps {
  usedFormatted: string | null;
  maxFormatted: string | null;
  percent: number | null;
  color?: string | null;
  loading: boolean;
  error: unknown;
  uiRolePrefix: "account" | "workspace";
}

/**
 * Technical storage usage indicator shared between account and workspace
 * settings. Displays server-reported used/limit figures without any plan or
 * monetization controls.
 */
export const StorageUsageMeter = ({
  usedFormatted,
  maxFormatted,
  percent,
  color,
  loading,
  error,
  uiRolePrefix,
}: StorageUsageMeterProps) => {
  const t = useI18n();

  if (loading) {
    if (error) {
      return (
        <ErrorMessage>
          {t["com.myoxus.settings.common.load-error"]()}
        </ErrorMessage>
      );
    }
    return <Skeleton variant="rectangular" />;
  }

  const usedLabel =
    usedFormatted ?? t["com.myoxus.sidebar.common.not-available"]();
  const maxLabel = maxFormatted ?? t["com.myoxus.storage.unlimited"]();

  return (
    <Stack data-myoxus-ui-role={`${uiRolePrefix}-storage-progress-meter`}>
      <SettingsToolbar
        layout="split"
        justify="space-between"
        data-myoxus-ui-role={`${uiRolePrefix}-storage-progress-labels`}
      >
        <SettingsStatusText>
          {t["com.myoxus.storage.used.hint"]()}
        </SettingsStatusText>
        <SettingsStatusText tone="active">
          {usedLabel} / {maxLabel}
        </SettingsStatusText>
      </SettingsToolbar>
      <Progress
        showValueLabel={false}
        color={color ?? undefined}
        value={percent ?? 0}
        ariaLabel={t["com.myoxus.storage.used.hint"]()}
      />
    </Stack>
  );
};
