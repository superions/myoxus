// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

import { UserQuotaService } from "../../../../modules/server";
import { StorageUsageMeter } from "../storage-usage-meter";

export const StorageProgress = () => {
  const quota = useService(UserQuotaService).quota;

  useEffect(() => {
    quota.revalidate();
  }, [quota]);

  const color = useLiveData(quota.color$);
  const usedFormatted = useLiveData(quota.usedFormatted$);
  const maxFormatted = useLiveData(quota.maxFormatted$);
  const percent = useLiveData(quota.percent$);
  const loadError = useLiveData(quota.error$);
  const loading =
    percent === null && usedFormatted === null && maxFormatted === null;

  return (
    <StorageUsageMeter
      usedFormatted={usedFormatted}
      maxFormatted={maxFormatted}
      percent={percent}
      color={color}
      loading={loading}
      error={loadError}
      uiRolePrefix="account"
    />
  );
};
