import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { MenuSeparator } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { WorkspaceMenuAction } from "../add-workspace";

export const AddServer = ({ onEventEnd }: { onEventEnd?: () => void }) => {
  const t = useI18n();
  const globalDialogService = useService(GlobalDialogService);

  const onAddServer = useCallback(() => {
    globalDialogService.open("sign-in", { step: "addStandalone" });
    onEventEnd?.();
  }, [globalDialogService, onEventEnd]);

  if (!BUILD_CONFIG.isNative) {
    return null;
  }

  return (
    <>
      <MenuSeparator />
      <WorkspaceMenuAction
        icon={<PlusIcon />}
        onClick={onAddServer}
        testId="new-server"
      >
        {t["com.myoxus.workspaceList.addServer"]()}
      </WorkspaceMenuAction>
    </>
  );
};
