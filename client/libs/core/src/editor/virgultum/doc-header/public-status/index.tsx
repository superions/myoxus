import { useGuard } from "@myoxus/core/components/guard";
import { PublicStatusTag } from "@myoxus/core/components/page-list";
import { ShareInfoService } from "@myoxus/core/modules/share-doc";
import { PublicControlMenuItems } from "@myoxus/core/modules/share-menu/view/share-menu/general-access";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { Menu } from "@myoxus/ui-facade";
import { useEffect } from "react";

import { getDocumentHeaderActionVariant } from "../action-variant";

export interface PublicStatusButtonProps {
  pageId: string;
}

export const PublicStatusButton = ({ pageId }: PublicStatusButtonProps) => {
  const t = useI18n();
  const canPublish = useGuard("Doc_Publish", pageId);
  const shareInfoService = useService(ShareInfoService);
  const isShared = useLiveData(shareInfoService.shareInfo.isShared$);
  const sharedMode = useLiveData(shareInfoService.shareInfo.sharedMode$);
  const isRevalidating = useLiveData(
    shareInfoService.shareInfo.isRevalidating$,
  );
  const mode = isShared ? sharedMode : null;
  const publicActive = mode !== null && mode !== undefined;

  useEffect(() => {
    shareInfoService.shareInfo.revalidate();
  }, [shareInfoService]);

  return (
    <Menu
      contentOptions={{
        align: "end",
        panelWidth: "comfortable",
        side: "bottom",
      }}
      items={
        <PublicControlMenuItems
          disabled={!canPublish || isRevalidating}
          source="header-globe"
        />
      }
      rootOptions={{
        onOpen: () =>
          track.$.sharePanel.$.openPublicShareControl({
            control: "header-globe",
          }),
      }}
    >
      <PublicStatusTag
        data-testid="public-status-button"
        disabled={!canPublish || isRevalidating}
        mode={mode}
        tooltip={
          canPublish
            ? undefined
            : t["com.myoxus.public-sharing.permission-disabled"]()
        }
        variant={getDocumentHeaderActionVariant(publicActive)}
      />
    </Menu>
  );
};
