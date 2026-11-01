import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { useEffect, useRef } from "react";

import { WorkspaceService } from "../../workspace";
import { WorkspaceQuotaService } from "../services/quota";

/**
 * Side-effect component that watches the blob sync state for quota-triggered
 * upload rejections. When the remote storage transitions into an over-capacity
 * state, shows a localized toast and forces the quota snapshot to revalidate
 * so the UI reflects the current usage.
 *
 * Invariants (P112-QUOTA-VERIFY-B):
 *   - INV-QUOTA-UPLOAD-TOAST: overCapacity false→true triggers notify.error
 *   - INV-QUOTA-UPLOAD-REVALIDATE: revalidation fires alongside the toast
 */
export const QuotaUploadWatcher = () => {
  const workspaceService = useService(WorkspaceService);
  const workspaceQuota = useService(WorkspaceQuotaService).quota;
  const t = useI18n();
  const wasOverCapacity = useRef(false);

  useEffect(() => {
    const engine = workspaceService.workspace.engine;
    if (!engine.started) {
      return;
    }
    const subscription = engine.blob.state$.subscribe((state) => {
      if (state.overCapacity && !wasOverCapacity.current) {
        wasOverCapacity.current = true;
        notify.error({
          title:
            t["com.myoxus.quota.storage-limit"]?.() ?? "Storage quota exceeded",
          message:
            t["error.BLOB_QUOTA_EXCEEDED"]?.() ??
            "You have exceeded your blob size quota.",
        });
        workspaceQuota?.revalidate();
      } else if (!state.overCapacity && wasOverCapacity.current) {
        wasOverCapacity.current = false;
      }
    });
    return () => subscription.unsubscribe();
  }, [t, workspaceQuota, workspaceService.workspace.engine]);

  return null;
};
