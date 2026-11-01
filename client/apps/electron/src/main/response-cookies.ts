// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CookiesSetDetails } from "electron";
import { parse as parseSetCookie } from "set-cookie-parser";

export type ResponseCookieMutation =
  | { type: "remove"; name: string; url: string }
  | { type: "set"; details: CookiesSetDetails };

export function responseCookieMutations(
  header: string,
  url: string,
  nowMs: number = Date.now(),
): ResponseCookieMutation[] {
  return parseSetCookie(header).map((cookie) => {
    const maxAge =
      cookie.maxAge === undefined ? undefined : Number(cookie.maxAge);
    if (!cookie.value || (maxAge !== undefined && maxAge <= 0)) {
      return { type: "remove", name: cookie.name, url };
    }

    return {
      type: "set",
      details: {
        url,
        domain: cookie.domain,
        // Electron persists a cookie only when expirationDate is present.
        // Myoxus sessions use Max-Age, which takes precedence over Expires.
        expirationDate:
          maxAge !== undefined && Number.isFinite(maxAge)
            ? nowMs / 1_000 + maxAge
            : cookie.expires
              ? cookie.expires.getTime() / 1_000
              : undefined,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        value: cookie.value,
        name: cookie.name,
        path: cookie.path,
        sameSite: cookie.sameSite?.toLowerCase() as
          "unspecified" | "no_restriction" | "lax" | "strict" | undefined,
      },
    };
  });
}
