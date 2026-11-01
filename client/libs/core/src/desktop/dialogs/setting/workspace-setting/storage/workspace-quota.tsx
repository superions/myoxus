import { WorkspaceQuotaService } from "@myoxus/core/modules/quota";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

import {
  ErrorMessage,
  Progress,
  SettingsStatusText,
  SettingsToolbar,
  Skeleton,
  Stack,
} from "../../primitives";

export const WorkspaceQuotaPanel = () => {
  return <StorageProgress />;
};

export const StorageProgress = () => {
  const t = useI18n();

  const workspaceQuotaService = useService(WorkspaceQuotaService).quota;

  const isLoading = useLiveData(workspaceQuotaService.isRevalidating$);
  const usedFormatted = useLiveData(workspaceQuotaService.usedFormatted$);
  const maxFormatted = useLiveData(workspaceQuotaService.maxFormatted$);
  const percent = useLiveData(workspaceQuotaService.percent$);
  const color = useLiveData(workspaceQuotaService.color$);
  const usedLabel =
    usedFormatted ?? t["com.myoxus.sidebar.common.not-available"]();
  const maxLabel = maxFormatted ?? t["com.myoxus.storage.unlimited"]();

  useEffect(() => {
    // revalidate quota to get the latest status
    workspaceQuotaService.revalidate();
  }, [workspaceQuotaService]);

  const loadError = useLiveData(workspaceQuotaService.error$);

  if (isLoading) {
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
    <Stack data-myoxus-ui-role="workspace-storage-progress-meter">
      <SettingsToolbar
        layout="split"
        data-myoxus-ui-role="workspace-storage-progress-labels"
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
