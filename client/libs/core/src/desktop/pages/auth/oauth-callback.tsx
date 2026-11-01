/**
 * OAuth callback page (`/oauth/callback`).
 *
 * Handles the server-side OAuth redirect after the user authorises the
 * application with a third-party provider (e.g. Google, GitHub).
 *
 * Flow:
 * 1. The **loader** runs before the component mounts. It reads `code` and
 *    `state` from the URL search params. Current Myoxus servers provide an
 *    opaque state token; older clients may still send a JSON wrapper that also
 *    names the target client.
 * 2. The **component** receives the loader data and calls
 *    `AuthService.signInOauth` once (guarded by `triggeredRef` to prevent
 *    StrictMode double-invocation). On success the popup window is closed;
 *    on failure the user is redirected to `/sign-in` with the error.
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
  CLOSE_POPUP_REDIRECT_TARGET,
  requiresDocumentAuthRedirect,
  sanitizeAuthRedirectTarget,
  supportedClient,
} from "./common";
import { AuthStatusPage } from "./status";

/** Shape of the data returned by the route loader to the component. */
interface LoaderData {
  state: string;
  code: string;
  provider: string;
}

/**
 * React Router loader for `/oauth/callback`.
 *
 * Runs on the server/SSR side (or synchronously before render in the browser).
 * Validates and routes the OAuth response parameters, returning a `LoaderData`
 * object for the web flow or preserving the older JSON-wrapped native handoff.
 */
export const loader: LoaderFunction = async ({ request }) => {
  const url = new URL(request.url);
  const queries = url.searchParams;
  const code = queries.get("code");
  let stateStr = queries.get("state") ?? "{}";

  if (!code || !stateStr) {
    return redirect(
      buildSignInUrl({ error: "Invalid oauth callback parameters" }),
    );
  }

  try {
    const { state, client, provider } = JSON.parse(stateStr);
    if (typeof state !== "string" || !state) {
      throw new Error("Invalid oauth callback parameters");
    }
    stateStr = state;

    const payload: LoaderData = {
      state,
      code,
      provider: typeof provider === "string" ? provider : "",
    };

    if (!client || client === "web") {
      return payload;
    }

    const clientCheckResult = supportedClient.safeParse(client);
    if (!clientCheckResult.success) {
      return redirect(
        buildSignInUrl({ error: "Invalid oauth callback parameters" }),
      );
    }

    const urlToOpen = buildAuthenticationDeepLink({
      scheme: clientCheckResult.data,
      method: "oauth",
      payload,
      server: location.origin,
    });

    return redirect(buildOpenAppUrlRoute(urlToOpen));
  } catch {
    return {
      state: stateStr,
      code,
      provider: "",
    } satisfies LoaderData;
  }
};

export const Component = () => {
  const auth = useService(AuthService);
  const data = useLoaderData() as LoaderData;
  const i18n = useI18n();

  // loader data from useLoaderData is not reactive, so that we can safely
  // assume the effect below is only triggered once
  const triggeredRef = useRef(false);

  const nav = useNavigate();

  useEffect(() => {
    if (triggeredRef.current) {
      return;
    }
    triggeredRef.current = true;
    auth
      .signInOauth(data.code, data.state, data.provider)
      .then(({ redirectUri }) => {
        const redirectTarget = sanitizeAuthRedirectTarget(redirectUri);
        if (window.opener && !window.opener.closed) {
          window.close();
          return;
        }
        if (redirectTarget === CLOSE_POPUP_REDIRECT_TARGET) {
          window.close();
          return;
        }
        if (requiresDocumentAuthRedirect(redirectTarget)) {
          window.location.replace(redirectTarget ?? "/");
          return;
        }
        nav(redirectTarget ?? "/", { replace: true });
      })
      .catch((e) => {
        nav(buildSignInUrl({ error: e.message }));
      });
  }, [data, auth, nav]);

  return (
    <AuthStatusPage
      title={i18n.t("admin.auth.oauth-callback-status-title")}
      description={i18n.t("admin.auth.callback-status-description")}
    />
  );
};
