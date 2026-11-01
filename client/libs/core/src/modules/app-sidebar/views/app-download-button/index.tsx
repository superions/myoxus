import { useDownloadUrl } from "@myoxus/core/modules/open-in-app/get-download-url";
import { useI18n } from "@myoxus/i18n";
import { DownloadIcon } from "@myoxus/icons/react";
import { track } from "@myoxus/track";
import { SidebarNavItem } from "@myoxus/ui-facade";
import { useCallback } from "react";

export function AppDownloadButton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const t = useI18n();
  const downloadUrl = useDownloadUrl();

  const handleClick = useCallback(() => {
    track.$.navigationPanel.bottomButtons.downloadApp();
    open(downloadUrl, "_blank");
  }, [downloadUrl]);

  return (
    <SidebarNavItem
      style={style}
      className={className}
      icon={<DownloadIcon />}
      onClick={handleClick}
    >
      {t["com.myoxus.other-page.nav.download-app"]()}
    </SidebarNavItem>
  );
}
