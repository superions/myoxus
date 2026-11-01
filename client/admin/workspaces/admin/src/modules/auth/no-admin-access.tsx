// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { LogOutIcon, UserRoundCheckIcon } from "@myoxus/icons/react";
import {
  AuthActionStack,
  AuthBackgroundArt,
  AuthContainer,
  AuthContent,
  AuthHeader,
  AuthStatusText,
  Button,
  MyoxusOtherPageLayout,
  notify,
  SignInPageContainer,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useId, useState } from "react";
import { useLocation } from "react-router";

import { useAdminSessionSnapshot } from "../../admin-session";
import { signOutAdminSession } from "../../api/auth-session-api";
import { useCurrentUser } from "../common";
import { buildAdminSignInUrl } from "./redirect";
import { SharedSignInRedirect } from "./shared-sign-in-redirect";

export function NoAdminAccess() {
  const i18n = useI18n();
  const currentUser = useCurrentUser();
  const session = useAdminSessionSnapshot();
  const titleId = useId();
  const location = useLocation();
  const returnPath = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    // Route admission changed the page without moving browser focus. Announce
    // the denial once and leave subsequent user navigation untouched.
    document.getElementById(titleId)?.focus();
  }, [titleId]);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const signOut = useCallback(() => {
    setIsSigningOut(true);
    signOutAdminSession("no-admin-access").catch((err) => {
      setIsSigningOut(false);
      notify.error({
        title: i18n.t("admin.auth.failed-to-logout", {
          message: err.message,
        }),
      });
    });
  }, [i18n]);

  // Admission and this standalone compatibility state share one navigation
  // owner. A second location.replace in the promise races that handoff.
  if (session.invalidated) {
    return <SharedSignInRedirect to={buildAdminSignInUrl(returnPath)} />;
  }

  return (
    <MyoxusOtherPageLayout showDownloadAction={false}>
      <AuthBackgroundArt />
      <SignInPageContainer>
        <AuthContainer>
          <AuthHeader
            title={i18n.t("admin.auth.no-admin-title")}
            titleProps={{ id: titleId, order: 1, tabIndex: -1 }}
          />
          <AuthContent>
            <AuthStatusText>
              {i18n.t("admin.auth.no-admin-description", {
                email: currentUser?.email ?? "",
              })}
            </AuthStatusText>
            <AuthActionStack>
              <Button
                type="button"
                variant="primary"
                block
                prefix={
                  <UserRoundCheckIcon
                    size="var(--mantine-spacing-lg)"
                    aria-hidden="true"
                  />
                }
                onClick={() => {
                  window.location.assign("/");
                }}
              >
                {i18n.t("admin.auth.no-admin-open-myoxus")}
              </Button>
              <Button
                type="button"
                variant="outline"
                block
                onClick={signOut}
                loading={isSigningOut}
                disabled={isSigningOut}
                prefix={
                  <LogOutIcon
                    size="var(--mantine-spacing-lg)"
                    aria-hidden="true"
                  />
                }
              >
                {i18n.t("admin.auth.no-admin-sign-out")}
              </Button>
            </AuthActionStack>
          </AuthContent>
        </AuthContainer>
      </SignInPageContainer>
    </MyoxusOtherPageLayout>
  );
}
