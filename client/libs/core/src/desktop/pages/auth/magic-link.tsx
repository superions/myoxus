/**
 * Magic-link authentication page (`/magic-link`).
 *
 * Handles passwordless sign-in via a one-time token emailed to the user.
 * The flow mirrors the OAuth callback pattern:
 *
 * 1. The **loader** validates `email` and `token` search params.
 *    - Missing params: redirects to `/sign-in` with an error message.
 *    - `client=web` / absent: returns the params as `LoaderData`.
 *    - Native clients (electron, iOS, etc.): builds a deep-link and redirects
 *      to `/open-app/...` to hand off to the native app.
 *
 * 2. The **component** calls `AuthService.signInMagicLink` once (guarded by
 *    `triggeredRef` to prevent React StrictMode double-invocation), then
 *    navigates to `redirect_uri` or `/` on success, or back to `/sign-in`
 *    with the error message on failure.
 *
 * The component renders a themed status shell while the side effect runs.
 */
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { useEffect, useRef } from "react";
import {
  type LoaderFunction,
  redirect,
  useLoaderData,
  useNavigate,
} from "react-router";

import {
  buildAuthenticationDeepLink,
  buildOpenAppUrlRoute,
} from "../../../modules/open-in-app";
import { AuthService } from "../../../modules/server";
import {
  buildSignInUrl,
  requiresDocumentAuthRedirect,
  sanitizeAuthRedirectTarget,
  supportedClient,
} from "./common";
import { AuthStatusPage } from "./status";

interface LoaderData {
  token: string;
  email: string;
  redirectUri: string | null;
}

export const loader: LoaderFunction = ({ request }) => {
  const url = new URL(request.url);
  const params = url.searchParams;
  const client = params.get("client");
  const email = params.get("email");
  const token = params.get("token");
  const rawRedirectUri = params.get("redirect_uri");
  const redirectUri = sanitizeAuthRedirectTarget(rawRedirectUri, url.origin);

  if (!email || !token) {
    return redirect(buildSignInUrl({ error: "Invalid magic link" }));
  }

  if (rawRedirectUri && !redirectUri) {
    return redirect(buildSignInUrl({ error: "Invalid redirect target" }));
  }

  const payload: LoaderData = {
    email,
    token,
    redirectUri: redirectUri ?? null,
  };

  if (!client || client === "web") {
    return payload;
  }

  const clientCheckResult = supportedClient.safeParse(client);
  if (!clientCheckResult.success) {
    return redirect(buildSignInUrl({ error: "Invalid callback parameters" }));
  }

  const urlToOpen = buildAuthenticationDeepLink({
    scheme: clientCheckResult.data,
    method: "magic-link",
    payload,
    server: location.origin,
  });

  return redirect(buildOpenAppUrlRoute(urlToOpen));
};

export const Component = () => {
  const auth = useService(AuthService);
  const data = useLoaderData() as LoaderData;
  const i18n = useI18n();

  const nav = useNavigate();
  // loader data from useLoaderData is not reactive, so that we can safely
  // assume the effect below is only triggered once
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (triggeredRef.current) {
      return;
    }
    triggeredRef.current = true;
    auth
      .signInMagicLink(data.email, data.token)
      .then(() => {
        const subscription = auth.session.status$.subscribe((status) => {
          if (status === "authenticated") {
            if (requiresDocumentAuthRedirect(data.redirectUri)) {
              window.location.replace(data.redirectUri ?? "/");
            } else {
              nav(data.redirectUri ?? "/");
            }
            subscription?.unsubscribe();
          }
        });
      })
      .catch((e) => {
        nav(buildSignInUrl({ error: e.message }));
      });
  }, [auth, data, data.email, data.redirectUri, data.token, nav]);

  return (
    <AuthStatusPage
      title={i18n.t("admin.auth.magic-link-status-title")}
      description={i18n.t("admin.auth.callback-status-description")}
    />
  );
};
