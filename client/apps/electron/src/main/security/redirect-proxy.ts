import { resolveDesktopServerRequest } from "../server-routing";

export function extractRedirectTarget(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const redirectUri = parsed.searchParams.get("redirect_uri");
    if (redirectUri) {
      return redirectUri;
    }

    if (parsed.hash) {
      const hash = parsed.hash.startsWith("#")
        ? parsed.hash.slice(1)
        : parsed.hash;

      const queryIndex = hash.indexOf("?");
      if (queryIndex !== -1) {
        const hashParams = new URLSearchParams(hash.slice(queryIndex + 1));
        const hashRedirect = hashParams.get("redirect_uri");
        if (hashRedirect) {
          return hashRedirect;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export type RedirectProxyValidationResult =
  | {
      allow: true;
      redirectTarget: string;
    }
  | {
      allow: false;
      reason: "missing_redirect_target" | "untrusted_redirect_target";
      redirectTarget?: string;
    };

export function validateRedirectProxyUrl(
  rawUrl: string,
): RedirectProxyValidationResult {
  const redirectTarget = extractRedirectTarget(rawUrl);
  if (!redirectTarget) {
    return { allow: false, reason: "missing_redirect_target" };
  }

  let allowed = false;
  try {
    const { server } = resolveDesktopServerRequest(rawUrl);
    const target = new URL(redirectTarget);
    allowed =
      target.origin === server.baseUrl && !target.username && !target.password;
  } catch {
    // An unknown server or malformed target must never gain a channel fallback.
  }
  if (!allowed) {
    return {
      allow: false,
      reason: "untrusted_redirect_target",
      redirectTarget,
    };
  }

  return { allow: true, redirectTarget };
}
