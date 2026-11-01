import {
  OpenInAppService,
  OpenLinkMode,
} from "@myoxus/core/modules/open-in-app";
import { useDownloadUrl } from "@myoxus/core/modules/open-in-app/get-download-url";
import { Trans, useI18n } from "@myoxus/i18n";
import { CloseIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Checkbox,
  IconButton,
  InlineLink,
  SidebarPromoCard,
  SidebarPromoProductMark,
} from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

export const OpenInAppCard = () => {
  const openInAppService = useService(OpenInAppService);
  const show = useLiveData(openInAppService.showOpenInAppBanner$);
  const downloadUrl = useDownloadUrl();
  const t = useI18n();

  const [remember, setRemember] = useState(false);

  const onOpen = useCallback(() => {
    openInAppService.showOpenInAppPage();
    if (remember) {
      openInAppService.dismissBanner(OpenLinkMode.OPEN_IN_DESKTOP_APP);
    }
  }, [openInAppService, remember]);

  const onDismiss = useCallback(() => {
    openInAppService.dismissBanner(
      remember ? OpenLinkMode.OPEN_IN_WEB : undefined,
    );
  }, [openInAppService, remember]);

  const onToggleRemember = useCallback(() => {
    setRemember((v) => !v);
  }, []);

  return (
    <SidebarPromoCard
      data-testid="open-in-app-card"
      data-myoxus-ui-role="sidebar-promo-card"
      hidden={!show}
      hideOnErrorStatus
      icon={<SidebarPromoProductMark />}
      title={t.t("com.myoxus.open-in-app.card.title")}
      closeAction={
        <IconButton
          aria-label={t.t("com.myoxus.open-in-app.card.button.dismiss")}
          data-myoxus-ui-role="button:icon-only:promo-dismiss"
          icon={<CloseIcon aria-hidden />}
          onClick={onDismiss}
          size="xs"
          variant="plain"
        />
      }
      controls={
        <Checkbox
          checked={remember}
          label={t.t("com.myoxus.open-in-app.card.remember")}
          onChange={onToggleRemember}
        />
      }
      actions={
        <>
          <Button
            variant="secondary"
            data-myoxus-ui-role="button:compact"
            onClick={onDismiss}
          >
            {t.t("com.myoxus.open-in-app.card.button.dismiss")}
          </Button>
          <Button
            variant="primary"
            data-myoxus-ui-role="button:compact"
            onClick={onOpen}
          >
            {t.t("com.myoxus.open-in-app.card.button.open")}
          </Button>
        </>
      }
    >
      <Trans i18nKey="com.myoxus.open-in-app.card.subtitle">
        Don&apos;t have the app?
        <InlineLink href={downloadUrl} target="_blank" rel="noreferrer">
          Click to download
        </InlineLink>
        .
      </Trans>
    </SidebarPromoCard>
  );
};
