// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspaceQuotaService } from "@myoxus/core/modules/quota";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

import { StorageUsageMeter } from "../../storage-usage-meter";

export const StorageProgress = () => {
  const quota = useService(WorkspaceQuotaService).quota;

  useEffect(() => {
    quota.revalidate();
  }, [quota]);

  const isLoading = useLiveData(quota.isRevalidating$);
  const usedFormatted = useLiveData(quota.usedFormatted$);
  const maxFormatted = useLiveData(quota.maxFormatted$);
  const percent = useLiveData(quota.percent$);
  const color = useLiveData(quota.color$);
  const loadError = useLiveData(quota.error$);

  return (
    <StorageUsageMeter
      usedFormatted={usedFormatted}
      maxFormatted={maxFormatted}
      percent={percent}
      color={color}
      loading={Boolean(isLoading)}
      error={loadError}
      uiRolePrefix="workspace"
    />
  );
};

export const WorkspaceQuotaPanel = () => <StorageProgress />;
