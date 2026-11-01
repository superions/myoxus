import { UrlService } from "@myoxus/core/modules/url";
import { Unreachable } from "@myoxus/env/constant";
import { useI18n } from "@myoxus/i18n";
import {
  CloseIcon,
  DownloadIcon,
  NewIcon,
  ResetIcon,
} from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  IconButton,
  SidebarNavItem,
  SidebarPromoAction,
  type SidebarPromoActionProps,
  Tooltip,
} from "@myoxus/ui-facade";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useMemo } from "react";

export interface AddPageButtonProps {
  onQuitAndInstall: () => void;
  onDownloadUpdate: () => void;
  onDismissChangelog: () => void;
  onOpenChangelog: () => void;
  changelogUnread: boolean;
  updateReady: boolean;
  updateAvailable: {
    version: string;
    allowAutoUpdate: boolean;
  } | null;
  downloadProgress: number | null;
  appQuitting: boolean;
  className?: string;
  style?: CSSProperties;
}

interface ButtonContentProps {
  updateReady: boolean;
  updateAvailable: {
    version: string;
    allowAutoUpdate: boolean;
  } | null;
  downloadProgress: number | null;
  appQuitting: boolean;
  changelogUnread: boolean;
  onDismissChangelog: () => void;
}

type PromoActionView = {
  closeAction?: SidebarPromoActionProps["closeAction"];
  detail?: ReactNode;
  hoverLabel?: ReactNode;
  icon?: ReactNode;
  label: ReactNode;
  progressValue?: number | null;
};

function getPromoActionView(
  props: ButtonContentProps,
  t: ReturnType<typeof useI18n>,
): PromoActionView | null {
  if (props.updateReady) {
    return {
      detail: props.updateAvailable?.version,
      hoverLabel:
        t[
          props.appQuitting ? "Loading" : "com.myoxus.appUpdater.installUpdate"
        ](),
      icon: <ResetIcon aria-hidden />,
      label: t["com.myoxus.appUpdater.updateAvailable"](),
    };
  }

  if (props.updateAvailable?.allowAutoUpdate) {
    if (props.downloadProgress !== null) {
      return {
        detail: props.updateAvailable.version,
        label: t["com.myoxus.appUpdater.downloading"](),
        progressValue: props.downloadProgress ?? 0,
      };
    }

    return {
      detail: props.updateAvailable.version,
      hoverLabel: t["com.myoxus.appUpdater.downloadUpdate"](),
      icon: <DownloadIcon aria-hidden />,
      label: t["com.myoxus.appUpdater.downloadUpdate"](),
    };
  }

  if (props.updateAvailable && !props.updateAvailable.allowAutoUpdate) {
    return {
      detail: props.updateAvailable.version,
      hoverLabel: t["com.myoxus.appUpdater.openDownloadPage"](),
      icon: <DownloadIcon aria-hidden />,
      label: t["com.myoxus.appUpdater.updateAvailable"](),
    };
  }

  if (props.changelogUnread) {
    return {
      closeAction: {
        "aria-label": t["common.hide"](),
        icon: <CloseIcon aria-hidden />,
        onClick: props.onDismissChangelog,
      },
      icon: <NewIcon aria-hidden />,
      label: t["com.myoxus.appUpdater.whatsNew"](),
    };
  }

  return null;
}

export function AppUpdaterButton({
  updateReady,
  changelogUnread,
  onDismissChangelog,
  onDownloadUpdate,
  onQuitAndInstall,
  onOpenChangelog,
  updateAvailable,
  downloadProgress,
  appQuitting,
  className,
  style,
}: AddPageButtonProps) {
  const t = useI18n();
  const urlService = useService(UrlService);
  const handleClick = useCallback(() => {
    if (updateReady) {
      onQuitAndInstall();
    } else if (updateAvailable) {
      if (updateAvailable.allowAutoUpdate) {
        if (downloadProgress !== null) {
          // wait for download to finish
        } else {
          onDownloadUpdate();
        }
      } else {
        urlService.openPopupWindow(BUILD_CONFIG.changelogUrl);
      }
    } else if (changelogUnread) {
      onOpenChangelog();
    } else {
      throw new Unreachable();
    }
  }, [
    updateReady,
    updateAvailable,
    changelogUnread,
    onQuitAndInstall,
    downloadProgress,
    onDownloadUpdate,
    urlService,
    onOpenChangelog,
  ]);

  const contentProps = useMemo(
    () => ({
      updateReady,
      updateAvailable,
      changelogUnread,
      downloadProgress,
      appQuitting,
      onDismissChangelog,
    }),
    [
      updateReady,
      updateAvailable,
      changelogUnread,
      downloadProgress,
      appQuitting,
      onDismissChangelog,
    ],
  );

  const actionView = getPromoActionView(contentProps, t);

  const wrapWithTooltip = (
    node: React.ReactElement,
    tooltip?: React.ReactElement | string,
  ) => {
    if (!tooltip) {
      return node;
    }

    return (
      <Tooltip content={tooltip} side="top">
        {node}
      </Tooltip>
    );
  };

  const disabled = useMemo(() => {
    if (appQuitting) {
      return true;
    }

    if (updateAvailable?.allowAutoUpdate) {
      return !updateReady && downloadProgress !== null;
    }

    return false;
  }, [
    appQuitting,
    downloadProgress,
    updateAvailable?.allowAutoUpdate,
    updateReady,
  ]);

  if (!updateAvailable && !changelogUnread) {
    return null;
  }

  if (!actionView) {
    return null;
  }

  if (!updateAvailable && changelogUnread) {
    return (
      <SidebarNavItem
        className={className}
        style={style}
        icon={actionView.icon}
        label={actionView.label}
        onClick={handleClick}
        actionsInteractive
        actions={
          <IconButton
            aria-label={t["common.hide"]()}
            icon={<CloseIcon aria-hidden />}
            onClick={onDismissChangelog}
            variant="plain"
            size="xs"
          />
        }
      />
    );
  }

  return wrapWithTooltip(
    <SidebarPromoAction
      style={style}
      className={className}
      data-myoxus-ui-role="sidebar-promo-action"
      data-has-update={!!updateAvailable}
      updating={appQuitting}
      disabled={disabled}
      onClick={handleClick}
      {...actionView}
    />,
    updateAvailable?.version,
  );
}
