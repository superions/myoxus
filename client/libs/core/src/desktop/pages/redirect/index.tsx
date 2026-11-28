// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DebugLogger } from "@myoxus/debug";
import { isAllowedRedirectTarget } from "@myoxus/infra";
import { type LoaderFunction, Navigate, useLoaderData } from "react-router";

const logger = new DebugLogger("redirect_proxy");

export const loader: LoaderFunction = async ({ request }) => {
  const redirectUri = new URL(request.url).searchParams.get("redirect_uri");
  if (!redirectUri) {
    return { allow: false };
  }
  if (
    isAllowedRedirectTarget(redirectUri, {
      currentHostname: window.location.hostname,
    })
  ) {
    location.href = redirectUri;
    return { allow: true };
  }
  logger.warn("Blocked redirect to untrusted domain", redirectUri);
  return { allow: false };
};

export function Component() {
  const { allow } = useLoaderData() as { allow: boolean };
  return allow ? null : <Navigate to="/404" />;
}
