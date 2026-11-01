import { UserCopilotQuotaService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

import {
  ErrorMessage,
  Progress,
  SettingRow,
  SettingsStatusText,
  SettingsToolbar,
  Skeleton,
  Stack,
} from "../primitives";
export const AIUsagePanel = () => {
  const t = useI18n();
  const copilotQuotaService = useService(UserCopilotQuotaService);
  useEffect(() => {
    copilotQuotaService.copilotQuota.revalidate();
  }, [copilotQuotaService]);
  const copilotActionLimit = useLiveData(
    copilotQuotaService.copilotQuota.copilotActionLimit$,
  );
  const copilotActionUsed = useLiveData(
    copilotQuotaService.copilotQuota.copilotActionUsed$,
  );
  const loading = copilotActionLimit === null || copilotActionUsed === null;
  const loadError = useLiveData(copilotQuotaService.copilotQuota.error$);

  if (loading) {
    if (loadError) {
      return (
        <SettingRow
          name={t["com.myoxus.ai.usage-title"]()}
          desc={""}
          spreadCol={false}
        >
          <ErrorMessage>
            {t["com.myoxus.settings.common.load-error"]()}
          </ErrorMessage>
        </SettingRow>
      );
    }
    return (
      <SettingRow
        name={t["com.myoxus.ai.usage-title"]()}
        desc={""}
        spreadCol={false}
      >
        <Skeleton variant="rectangular" />
      </SettingRow>
    );
  }

  if (copilotActionLimit === "unlimited") {
    return (
      <SettingRow
        spreadCol={false}
        desc={""}
        name={t["com.myoxus.ai.usage-title"]()}
      >
        <SettingsStatusText tone="active">
          {t["com.myoxus.user-info.usage.ai.unlimited"]()}
        </SettingsStatusText>
      </SettingRow>
    );
  }

  const percent = Math.min(
    100,
    Math.max(
      0.5,
      Number(((copilotActionUsed / copilotActionLimit) * 100).toFixed(4)),
    ),
  );

  return (
    <SettingRow
      spreadCol={false}
      desc={""}
      name={t["com.myoxus.ai.usage-title"]()}
    >
      <Stack data-myoxus-ui-role="account-ai-usage-progress-meter">
        <SettingsToolbar
          layout="split"
          justify="space-between"
          data-myoxus-ui-role="account-ai-usage-progress-labels"
        >
          <SettingsStatusText>
            {t["com.myoxus.ai.usage.used-caption"]()}
          </SettingsStatusText>
          <SettingsStatusText tone="active">
            {t["com.myoxus.ai.usage.used-detail"]({
              used: copilotActionUsed.toString(),
              limit: copilotActionLimit.toString(),
            })}
          </SettingsStatusText>
        </SettingsToolbar>
        <Progress
          showValueLabel={false}
          tone={percent > 80 ? "error" : "default"}
          value={percent}
          ariaLabel={t["com.myoxus.ai.usage.used-caption"]()}
        />
      </Stack>
    </SettingRow>
  );
};
