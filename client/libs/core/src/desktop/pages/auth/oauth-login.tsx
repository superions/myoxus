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

const supportedProvider = z.nativeEnum(OAuthProviderType);

const oauthParameters = z.object({
  provider: supportedProvider,
  client: supportedClient,
  redirectUri: z.string().optional().nullable(),
});

interface LoaderData {
  provider: OAuthProviderType;
  client: string;
  redirectUri?: string;
  authContext?: AuthContext;
}

export const loader: LoaderFunction = async ({ request }) => {
  const url = new URL(request.url);
  const searchParams = url.searchParams;
  const provider = searchParams.get("provider");
  const client = searchParams.get("client") ?? "web";
  const rawRedirectUri = searchParams.get("redirect_uri");
  const redirectUri = sanitizeAuthRedirectTarget(rawRedirectUri, url.origin);
  const authContext = parseAuthContext(searchParams.get("auth_context"));

  if (rawRedirectUri && !redirectUri) {
    return redirect(
      buildSignInUrl({
        error: "Invalid redirect target",
        authContext,
      }),
    );
  }

  // sign out first, web only
  if (client === "web") {
    await signOutSharedAuthSession();
  }

  const paramsParseResult = oauthParameters.safeParse({
    provider,
    client,
    redirectUri,
  });

  if (paramsParseResult.success) {
    const params = paramsParseResult.data;
    return {
      provider: params.provider,
      client: params.client,
      redirectUri: params.redirectUri ?? undefined,
      authContext,
    };
  }

  return redirect(
    buildSignInUrl({
      error: "Invalid oauth parameters",
      redirectUri,
      authContext,
    }),
  );
};

export const Component = () => {
  const auth = useService(AuthService);
  const data = useLoaderData() as LoaderData;
  const i18n = useI18n();

  const nav = useNavigate();
  const triggeredRef = useRef(false);

  useEffect(() => {
    // One mounted login owns one nonce. StrictMode effect replay must not start
    // a second preflight that overwrites the first authorization's client nonce.
    if (triggeredRef.current) return;
    triggeredRef.current = true;
    auth
      .oauthPreflight(data.provider, data.client, data.redirectUri)
      .then(({ url }) => {
        // this is the url of oauth provider auth page, can't navigate with react-router
        location.href = url;
      })
      .catch((e) => {
        nav(
          buildSignInUrl({
            error: e.message,
            redirectUri: data.redirectUri,
            authContext: data.authContext,
          }),
        );
      });
  }, [data, auth, nav]);

  return (
    <AuthStatusPage
      title={i18n.t("admin.auth.oauth-login-status-title")}
      description={i18n.t("admin.auth.callback-status-description")}
    />
  );
};
