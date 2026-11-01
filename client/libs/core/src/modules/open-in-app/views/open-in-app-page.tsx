import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { appNames } from "@myoxus/core/utils/channel";
import { Trans, useI18n } from "@myoxus/i18n";
import { LocalWorkspaceIcon } from "@myoxus/icons/react";
import { useServiceOptional } from "@myoxus/infra";
import {
  Group,
  InlineActionButton,
  InlineLink,
  MyoxusOtherPageLayout,
  MyoxusText,
  OtherPageHeroProductMark,
  PageContentRail,
  Stack,
} from "@myoxus/ui-facade";
import { type MouseEvent, useCallback, useLayoutEffect } from "react";

import { useDownloadUrl } from "../get-download-url";
import { getOpenUrlInDesktopAppLink } from "../utils";

let lastOpened = "";

interface OpenAppProps {
  urlToOpen?: string | null;
  openHereClicked?: (e: MouseEvent) => void;
  mode?: "auth" | "open-doc"; // default to 'auth'
}

export const OpenInAppPage = ({
  urlToOpen,
  openHereClicked,
  mode = "auth",
}: OpenAppProps) => {
  // default to open the current page in desktop app
  urlToOpen ??= getOpenUrlInDesktopAppLink(window.location.href, true);
  const workspaceDialogService = useServiceOptional(WorkspaceDialogService);
  const downloadUrl = useDownloadUrl();
  const t = useI18n();
  const channel = BUILD_CONFIG.appBuildType;
  const appName = appNames[channel];

  const goToAppearanceSetting = useCallback(
    (e: MouseEvent) => {
      openHereClicked?.(e);
      workspaceDialogService?.open("user-settings", {
        activeTab: "appearance",
      });
    },
    [workspaceDialogService, openHereClicked],
  );

  useLayoutEffect(() => {
    if (
      !urlToOpen ||
      lastOpened === urlToOpen ||
      !navigator.userActivation?.isActive
    ) {
      return;
    }

    // Custom protocols may only be launched while the browser still retains
    // the user activation that opened this route. Direct/deferred deep links
    // keep the explicit retry action instead of producing a console error.
    lastOpened = urlToOpen;
    location.href = urlToOpen;
  }, [urlToOpen]);

  if (!urlToOpen) {
    return null;
  }

  return (
    <MyoxusOtherPageLayout downloadUrl={downloadUrl}>
      <PageContentRail
        centerContent
        fill
        width="content"
        data-myoxus-ui-role="open-in-app-page"
      >
        <Stack align="center" gap="xl" data-myoxus-ui-role="open-in-app-shell">
          <Stack align="center" data-myoxus-ui-role="open-in-app-content">
            <OtherPageHeroProductMark
              alt={`${appName} App Icon`}
              data-myoxus-ui-role="open-in-app-app-mark"
            />

            <MyoxusText
              component="p"
              typographySlot="section-title"
              fallbackSlot="body"
              textAlign="center"
              data-myoxus-ui-role="open-in-app-prompt"
            >
              {mode === "open-doc" ? (
                <Trans i18nKey="com.myoxus.auth.open.myoxus.open-doc-prompt">
                  This doc is now opened in {appName}
                </Trans>
              ) : (
                <Trans i18nKey="com.myoxus.auth.open.myoxus.prompt">
                  Open {appName} app now
                </Trans>
              )}
            </MyoxusText>

            <Group
              justify="center"
              wrap="wrap"
              data-myoxus-ui-role="open-in-app-actions"
            >
              {openHereClicked ? (
                <InlineActionButton onClick={openHereClicked}>
                  {t["com.myoxus.auth.open.myoxus.doc.open-here"]()}
                </InlineActionButton>
              ) : null}
              <InlineLink href={urlToOpen} target="_blank" rel="noreferrer">
                {t["com.myoxus.auth.open.myoxus.try-again"]()}
              </InlineLink>
            </Group>
          </Stack>

          {mode === "open-doc" ? (
            <Stack
              align="center"
              gap="sm"
              data-myoxus-ui-role="open-in-app-footer"
            >
              <InlineActionButton onClick={goToAppearanceSetting}>
                {t["com.myoxus.auth.open.myoxus.doc.edit-settings"]()}
              </InlineActionButton>

              <Group
                justify="center"
                wrap="wrap"
                gap="xs"
                data-myoxus-ui-role="open-in-app-footer-text"
              >
                <LocalWorkspaceIcon size="1em" aria-hidden="true" />
                <MyoxusText
                  component="span"
                  typographySlot="caption"
                  tone="secondary"
                >
                  {t["com.myoxus.auth.open.myoxus.doc.footer-text"]()}
                </MyoxusText>
              </Group>
            </Stack>
          ) : null}
        </Stack>
      </PageContentRail>
    </MyoxusOtherPageLayout>
  );
};
