import {
  type DocPermissionActions,
  GuardService,
  type WorkspacePermissionActions,
} from "@myoxus/core/modules/permissions";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect, useMemo } from "react";

export function useGuard(action: WorkspacePermissionActions): boolean;
export function useGuard(
  action: DocPermissionActions,
  docId: string,
  options?: { revalidate: "always" | "if-missing" },
): boolean;
export function useGuard(
  action: WorkspacePermissionActions | DocPermissionActions,
  docId?: string,
): boolean;
export function useGuard(
  action: WorkspacePermissionActions | DocPermissionActions,
  docId?: string,
  options?: { revalidate: "always" | "if-missing" },
) {
  const guardService = useService(GuardService);
  useEffect(() => {
    if (docId) {
      if (options?.revalidate === "if-missing") {
        guardService.revalidateDocPermissionIfMissing(
          action as DocPermissionActions,
          docId,
        );
      } else {
        guardService.revalidateCan(action as DocPermissionActions, docId);
      }
    } else {
      guardService.revalidateCan(action as WorkspacePermissionActions);
    }
  }, [action, docId, guardService, options?.revalidate]);

  const livedata$ = useMemo(() => {
    return docId
      ? guardService.can$(action as DocPermissionActions, docId)
      : guardService.can$(action as WorkspacePermissionActions);
  }, [action, docId, guardService]);

  const can = useLiveData(livedata$);
  return can;
}
