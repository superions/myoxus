import { ShareInfoService } from "@myoxus/core/modules/share-doc";
import { WorkspaceShareSettingService } from "@myoxus/core/modules/share-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  Menu,
  MenuDetailRow,
  MenuInlineText,
  MenuTrigger,
} from "@myoxus/ui-facade";
import { useEffect } from "react";

import { PublicControlMenuItems } from "./public-control-menu-items";

export const PublicDoc = ({ disabled }: { disabled?: boolean }) => {
  const t = useI18n();
  const shareInfoService = useService(ShareInfoService);
  const isSharedPage = useLiveData(shareInfoService.shareInfo.isShared$);
  const workspacePublication = useService(
    WorkspaceShareSettingService,
  ).sharePreview;
  const publiclyAccessible = useLiveData(
    workspacePublication.publiclyAccessible$,
  );
  const isRevalidating = useLiveData(
    shareInfoService.shareInfo.isRevalidating$,
  );

  useEffect(() => {
    shareInfoService.shareInfo.revalidate();
  }, [shareInfoService]);

  return (
    <MenuDetailRow
      right={
        disabled ? (
          <MenuInlineText tone="disabled" truncate={false}>
            {isSharedPage && publiclyAccessible
              ? t["com.myoxus.public-sharing.status.public"]()
              : isSharedPage
                ? t["com.myoxus.public-sharing.status.suspended"]()
                : t["com.myoxus.share-menu.option.link.no-access"]()}
          </MenuInlineText>
        ) : (
          <Menu
            contentOptions={{
              align: "end",
              panelWidth: "comfortable",
            }}
            items={
              <PublicControlMenuItems disabled={disabled} source="share-menu" />
            }
            rootOptions={{
              onOpen: () =>
                track.$.sharePanel.$.openPublicShareControl({
                  control: "share-menu",
                }),
            }}
          >
            <MenuTrigger
              data-testid="share-link-menu-trigger"
              disabled={isRevalidating}
              loading={isRevalidating}
              variant="plain"
            >
              {isSharedPage && publiclyAccessible
                ? t["com.myoxus.public-sharing.status.public"]()
                : isSharedPage
                  ? t["com.myoxus.public-sharing.status.suspended"]()
                  : t["com.myoxus.share-menu.option.link.no-access"]()}
            </MenuTrigger>
          </Menu>
        )
      }
    >
      <MenuInlineText tone="primary" truncate={false}>
        {t["com.myoxus.share-menu.option.link.label"]()}
      </MenuInlineText>
    </MenuDetailRow>
  );
};
