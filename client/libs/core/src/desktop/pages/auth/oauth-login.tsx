// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { AuthService } from "@myoxus/core/modules/server";
import { signOutSharedAuthSession } from "@myoxus/core/modules/server/auth-http";
import { OAuthProviderType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { useEffect, useRef } from "react";
import {
  type LoaderFunction,
  redirect,
  useLoaderData,
  // oxlint-disable-next-line no-restricted-imports
  useNavigate,
} from "react-router";
import { z } from "zod";

import {
  type AuthContext,
  buildSignInUrl,
  parseAuthContext,
  sanitizeAuthRedirectTarget,
  supportedClient,
} from "./common";
import { AuthStatusPage } from "./status";

const oauthParametersSchema = z.object({
  provider: z.nativeEnum(OAuthProviderType),
  client: supportedClient,
  redirectUri: z.string().optional().nullable(),
});

interface OAuthLoginLoaderData {
  provider: OAuthProviderType;
  client: string;
  redirectUri?: string;
  authContext?: AuthContext;
}

export const loader: LoaderFunction = async ({ request }) => {
  const url = new URL(request.url);
  const params = url.searchParams;
  const provider = params.get("provider");
  const client = params.get("client") ?? "web";
  const rawRedirectUri = params.get("redirect_uri");
  const redirectUri = sanitizeAuthRedirectTarget(rawRedirectUri, url.origin);
  const authContext = parseAuthContext(params.get("auth_context"));

  if (rawRedirectUri && !redirectUri) {
    return redirect(
      buildSignInUrl({ error: "Invalid redirect target", authContext }),
    );
  }

  if (client === "web") {
    await signOutSharedAuthSession();
  }

  const parsed = oauthParametersSchema.safeParse({
    provider,
    client,
    redirectUri,
  });
  if (parsed.success) {
    return {
      provider: parsed.data.provider,
      client: parsed.data.client,
      redirectUri: parsed.data.redirectUri ?? undefined,
      authContext,
    } satisfies OAuthLoginLoaderData;
  }

  return redirect(
    buildSignInUrl({
      error: "Invalid oauth parameters",
      redirectUri,
      authContext,
    }),
  );
};

export function Component() {
  const auth = useService(AuthService);
  const data = useLoaderData() as OAuthLoginLoaderData;
  const i18n = useI18n();
  const navigate = useNavigate();
  const startedRef = useRef(false);

  useEffect(() => {
    // Guard against StrictMode replay so a second preflight does not overwrite
    // the nonce of the first authorization request.
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    auth
      .oauthPreflight(data.provider, data.client, data.redirectUri)
      .then(({ url }) => {
        location.href = url;
      })
      .catch((error: Error) => {
        navigate(
          buildSignInUrl({
            error: error.message,
            redirectUri: data.redirectUri,
            authContext: data.authContext,
          }),
        );
      });
  }, [auth, data, navigate]);

  return (
    <AuthStatusPage
      title={i18n.t("admin.auth.oauth-login-status-title")}
      description={i18n.t("admin.auth.callback-status-description")}
    />
  );
}
