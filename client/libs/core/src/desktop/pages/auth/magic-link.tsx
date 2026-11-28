// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

interface MagicLinkLoaderData {
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

  const payload: MagicLinkLoaderData = {
    email,
    token,
    redirectUri: redirectUri ?? null,
  };

  if (!client || client === "web") {
    return payload;
  }

  const parsedClient = supportedClient.safeParse(client);
  if (!parsedClient.success) {
    return redirect(buildSignInUrl({ error: "Invalid callback parameters" }));
  }

  const deepLink = buildAuthenticationDeepLink({
    scheme: parsedClient.data,
    method: "magic-link",
    payload,
    server: location.origin,
  });
  return redirect(buildOpenAppUrlRoute(deepLink));
};

export function Component() {
  const auth = useService(AuthService);
  const data = useLoaderData() as MagicLinkLoaderData;
  const i18n = useI18n();
  const navigate = useNavigate();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    auth
      .signInMagicLink(data.email, data.token)
      .then(() => {
        const subscription = auth.session.status$.subscribe((status) => {
          if (status === "authenticated") {
            const target = data.redirectUri ?? "/";
            if (requiresDocumentAuthRedirect(data.redirectUri)) {
              window.location.replace(target);
            } else {
              navigate(target);
            }
            subscription?.unsubscribe();
          }
        });
      })
      .catch((error: Error) => {
        navigate(buildSignInUrl({ error: error.message }));
      });
  }, [auth, data, navigate]);

  return (
    <AuthStatusPage
      title={i18n.t("admin.auth.magic-link-status-title")}
      description={i18n.t("admin.auth.callback-status-description")}
    />
  );
}
