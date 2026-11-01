import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

import { UserQuotaService } from "../../../../modules/server";
import {
  ErrorMessage,
  Progress,
  SettingsStatusText,
  SettingsToolbar,
  Skeleton,
  Stack,
} from "../primitives";

export const StorageProgress = () => {
  const t = useI18n();
  const quota = useService(UserQuotaService).quota;

  useEffect(() => {
    // revalidate quota to get the latest status
    quota.revalidate();
  }, [quota]);
  const color = useLiveData(quota.color$);
  const usedFormatted = useLiveData(quota.usedFormatted$);
  const maxFormatted = useLiveData(quota.maxFormatted$);
  const percent = useLiveData(quota.percent$);
  const usedLabel =
    usedFormatted ?? t["com.myoxus.sidebar.common.not-available"]();
  const maxLabel = maxFormatted ?? t["com.myoxus.storage.unlimited"]();
  const loading =
    percent === null && usedFormatted === null && maxFormatted === null;
  const loadError = useLiveData(quota.error$);

  if (loading) {
    if (loadError) {
      return (
        <ErrorMessage>
          {t["com.myoxus.settings.common.load-error"]()}
        </ErrorMessage>
      );
    }
    return <Skeleton variant="rectangular" />;
  }

  return (
    <Stack data-myoxus-ui-role="account-storage-progress-meter">
      <SettingsToolbar
        layout="split"
        justify="space-between"
        data-myoxus-ui-role="account-storage-progress-labels"
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
