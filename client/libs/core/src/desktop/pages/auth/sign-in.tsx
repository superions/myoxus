// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { SignInPanel } from "@myoxus/core/components/sign-in";
import { SignInBackgroundArts } from "@myoxus/core/components/sign-in/background-arts";
import type { AuthSessionStatus } from "@myoxus/core/modules/server/entities/session";
import { useI18n } from "@myoxus/i18n";
import {
  AuthPanelFrame,
  MyoxusOtherPageLayout,
  notify,
  SignInPageContainer,
} from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  RouteLogic,
  useNavigateHelper,
} from "../../../components/hooks/use-navigate-helper";
import {
  CLOSE_POPUP_REDIRECT_TARGET,
  parseAuthContext,
  requiresDocumentAuthRedirect,
  sanitizeAuthRedirectTarget,
} from "./common";

export function SignIn({
  redirectUrl: redirectUrlProp,
}: {
  redirectUrl?: string;
}) {
  const t = useI18n();
  const navigate = useNavigate();
  const { jumpToIndex } = useNavigateHelper();
  const [searchParams] = useSearchParams();

  const redirectUrl = sanitizeAuthRedirectTarget(
    redirectUrlProp ?? searchParams.get("redirect_uri"),
  );
  const authContext = parseAuthContext(searchParams.get("auth_context"));
  const server = searchParams.get("server") ?? undefined;
  const error = searchParams.get("error");

  useEffect(() => {
    if (error) {
      notify.error({
        title: t["com.myoxus.auth.toast.title.failed"](),
        message: error,
      });
    }
  }, [error, t]);

  const handleClose = useCallback(() => {
    jumpToIndex(RouteLogic.REPLACE, { search: searchParams.toString() });
  }, [jumpToIndex, searchParams]);

  const handleAuthenticated = useCallback(
    (status: AuthSessionStatus) => {
      if (status !== "authenticated") {
        return;
      }
      if (!redirectUrl) {
        handleClose();
        return;
      }
      if (redirectUrl === CLOSE_POPUP_REDIRECT_TARGET) {
        window.close();
        return;
      }
      if (requiresDocumentAuthRedirect(redirectUrl)) {
        window.location.replace(redirectUrl);
        return;
      }
      navigate(redirectUrl, { replace: true });
    },
    [handleClose, navigate, redirectUrl],
  );

  return (
    <SignInPageContainer>
      <AuthPanelFrame>
        <SignInPanel
          onSkip={handleClose}
          onAuthenticated={handleAuthenticated}
          initStep={server ? "addStandalone" : "signIn"}
          server={server}
          redirectUrl={redirectUrl}
          authContext={authContext}
        />
      </AuthPanelFrame>
    </SignInPageContainer>
  );
}

export function Component() {
  return (
    <MyoxusOtherPageLayout>
      <SignInBackgroundArts />
      <SignIn />
    </MyoxusOtherPageLayout>
  );
}
