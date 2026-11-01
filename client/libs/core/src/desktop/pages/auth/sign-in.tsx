/**
 * Sign-in page (`/sign-In`).
 *
 * Renders the full-page sign-in UI with a decorative background. After a
 * successful authentication the user is redirected to the URL specified by the
 * `redirect_uri` search parameter, or back to the workspace index if none is
 * provided. The special value `CLOSE_POPUP` closes the popup window instead
 * of navigating (used by the desktop OAuth flow).
 *
 * An optional `server` search parameter pre-selects the "add selfhosted server"
 * step in the `<SignInPanel>`, which is used when arriving via an Electron
 * deep-link for a non-default server.
 *
 * Error messages from failed server-side redirects can be forwarded via the
 * `error` search parameter and are surfaced as toast notifications on mount.
 */

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

/**
 * Reusable sign-in panel component.
 *
 * Can be embedded directly (passing `redirectUrl` as a prop) or used as the
 * page-level component where `redirect_uri` is read from the URL search params.
 *
 * @param redirectUrl - Optional override for the post-authentication redirect
 *   target. When omitted the value is read from the `redirect_uri` search
 *   parameter. The special string `'CLOSE_POPUP'` closes the window instead.
 */
export const SignIn = ({
  redirectUrl: redirectUrlFromProps,
}: {
  redirectUrl?: string;
}) => {
  const t = useI18n();
  const navigate = useNavigate();
  const { jumpToIndex } = useNavigateHelper();
  const [searchParams] = useSearchParams();
  const redirectUrl = sanitizeAuthRedirectTarget(
    redirectUrlFromProps ?? searchParams.get("redirect_uri"),
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
    jumpToIndex(RouteLogic.REPLACE, {
      search: searchParams.toString(),
    });
  }, [jumpToIndex, searchParams]);

  const handleAuthenticated = useCallback(
    (status: AuthSessionStatus) => {
      if (status === "authenticated") {
        if (redirectUrl) {
          if (redirectUrl === CLOSE_POPUP_REDIRECT_TARGET) {
            window.close();
            return;
          }
          if (requiresDocumentAuthRedirect(redirectUrl)) {
            window.location.replace(redirectUrl);
            return;
          }
          navigate(redirectUrl, {
            replace: true,
          });
        } else {
          handleClose();
        }
      }
    },
    [handleClose, navigate, redirectUrl],
  );

  const initStep = server ? "addStandalone" : "signIn";

  return (
    <SignInPageContainer>
      <AuthPanelFrame>
        <SignInPanel
          onSkip={handleClose}
          onAuthenticated={handleAuthenticated}
          initStep={initStep}
          server={server}
          redirectUrl={redirectUrl}
          authContext={authContext}
        />
      </AuthPanelFrame>
    </SignInPageContainer>
  );
};

/**
 * Lazy route entry point for `/sign-In`.
 *
 * Composes the full-page layout with decorative background art and the
 * `<SignIn>` panel. Props are derived from URL search params inside `<SignIn>`.
 */
export const Component = () => {
  return (
    <MyoxusOtherPageLayout>
      <SignInBackgroundArts />
      <SignIn />
    </MyoxusOtherPageLayout>
  );
};
