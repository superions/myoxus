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
  CLOSE_POPUP_REDIRECT_TARGET,
  requiresDocumentAuthRedirect,
  sanitizeAuthRedirectTarget,
  supportedClient,
} from "./common";
import { AuthStatusPage } from "./status";

interface OAuthCallbackLoaderData {
  state: string;
  code: string;
  provider: string;
}

export const loader: LoaderFunction = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  let rawState = url.searchParams.get("state") ?? "{}";

  if (!code || !rawState) {
    return redirect(
      buildSignInUrl({ error: "Invalid oauth callback parameters" }),
    );
  }

  try {
    const { state, client, provider } = JSON.parse(rawState);
    if (typeof state !== "string" || !state) {
      throw new Error("Invalid oauth callback parameters");
    }
    rawState = state;

    const payload: OAuthCallbackLoaderData = {
      state,
      code,
      provider: typeof provider === "string" ? provider : "",
    };

    if (!client || client === "web") {
      return payload;
    }

    const parsedClient = supportedClient.safeParse(client);
    if (!parsedClient.success) {
      return redirect(
        buildSignInUrl({ error: "Invalid oauth callback parameters" }),
      );
    }

    const deepLink = buildAuthenticationDeepLink({
      scheme: parsedClient.data,
      method: "oauth",
      payload,
      server: location.origin,
    });
    return redirect(buildOpenAppUrlRoute(deepLink));
  } catch {
    return {
      state: rawState,
      code,
      provider: "",
    } satisfies OAuthCallbackLoaderData;
  }
};

export function Component() {
  const auth = useService(AuthService);
  const data = useLoaderData() as OAuthCallbackLoaderData;
  const i18n = useI18n();
  const navigate = useNavigate();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    auth
      .signInOauth(data.code, data.state, data.provider)
      .then(({ redirectUri }) => {
        const target = sanitizeAuthRedirectTarget(redirectUri);
        if (window.opener && !window.opener.closed) {
          window.close();
          return;
        }
        if (target === CLOSE_POPUP_REDIRECT_TARGET) {
          window.close();
          return;
        }
        if (requiresDocumentAuthRedirect(target)) {
          window.location.replace(target ?? "/");
          return;
        }
        navigate(target ?? "/", { replace: true });
      })
      .catch((error: Error) => {
        navigate(buildSignInUrl({ error: error.message }));
      });
  }, [auth, data, navigate]);

  return (
    <AuthStatusPage
      title={i18n.t("admin.auth.oauth-callback-status-title")}
      description={i18n.t("admin.auth.callback-status-description")}
    />
  );
}
