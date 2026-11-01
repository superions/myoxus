import { useI18n } from "@myoxus/i18n";
import { InformationFillDuotoneIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { SettingsStatusText, useConfirmModal } from "@myoxus/ui-facade";
import { useEffect } from "react";

import type { WorkspaceMetadata } from "../../workspace";
import { WorkspaceQuotaService } from "../services/quota";

/**
 *
 * Notification that the cloud workspace quota has exceeded the limit.
 * No billing/upgrade — just an informational warning.
 *
 */
export const QuotaCheck = ({
  workspaceMeta,
}: {
  workspaceMeta: WorkspaceMetadata;
}) => {
  const { openConfirmModal } = useConfirmModal();
  const workspaceQuota = useService(WorkspaceQuotaService).quota;
  const quota = useLiveData(workspaceQuota.quota$);
  const usedPercent = useLiveData(workspaceQuota.percent$);
  const t = useI18n();

  useEffect(() => {
    workspaceQuota?.revalidate();
  }, [workspaceQuota]);

  useEffect(() => {
    if (workspaceMeta.flavour === "local" || !quota) {
      return;
    }
    const memberOverflow = quota.overcapacityMemberCount > 0;
    const storageOverflow = usedPercent && usedPercent >= 100;

    if (memberOverflow || storageOverflow) {
      const description = storageOverflow
        ? (t["com.myoxus.quota.storage-limit"]?.() ??
          "Storage quota exceeded. Please free up space to resume syncing.")
        : (t["com.myoxus.quota.member-limit"]?.() ??
          "Member limit exceeded. Please contact your workspace owner.");

      openConfirmModal({
        title: (
          <SettingsStatusText
            tone="error"
            data-myoxus-ui-role="quota-sync-paused-title"
          >
            <InformationFillDuotoneIcon />
            {t["com.myoxus.quota.sync-paused"]?.() ?? "Sync Paused"}
          </SettingsStatusText>
        ),
        description,
        confirmText: t["OK"]?.() ?? "OK",
        confirmButtonOptions: {
          variant: "primary",
        },
      });
    }
  }, [openConfirmModal, quota, t, usedPercent, workspaceMeta.flavour]);

  return null;
};
