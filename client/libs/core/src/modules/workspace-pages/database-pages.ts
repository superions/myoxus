// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect } from "react";

import type { DatabasePageLifecycle } from "./database-pages-service";
import { DatabasePagesService } from "./database-pages-service";

export * from "./database-page-loader";
export * from "./database-pages-service";

function useDatabasePagesByLifecycle(
  lifecycle: DatabasePageLifecycle,
  enabled: boolean,
) {
  const service = useService(DatabasePagesService);
  const state = useLiveData(service.state$(lifecycle));
  useEffect(() => {
    if (!enabled) return;
    return service.acquire(lifecycle);
  }, [enabled, lifecycle, service]);
  const reload = useCallback(
    () => service.reload(lifecycle),
    [lifecycle, service],
  );
  const retry = useCallback(
    () => service.retry(lifecycle),
    [lifecycle, service],
  );
  return { ...state, reload, retry };
}

export function useDatabasePages(workspaceId: string | null) {
  const state = useDatabasePagesByLifecycle("active", workspaceId !== null);
  return workspaceId
    ? state
    : { ...state, status: "ready" as const, records: [], failedOffset: null };
}

export function useTrashedDatabasePages(workspaceId: string | null) {
  const state = useDatabasePagesByLifecycle("trashed", workspaceId !== null);
  return workspaceId
    ? state
    : { ...state, status: "ready" as const, records: [], failedOffset: null };
}
