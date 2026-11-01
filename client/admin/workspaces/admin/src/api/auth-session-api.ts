// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invalidateAdminSession } from "../admin-session";
import { adminFetch } from "../fetch-utils";

const ADMIN_SIGN_OUT_OPERATION = "adminSignOut";

/**
 * Signs out via the shared auth endpoint and immediately invalidates the local
 * Admin session snapshot. The redirect stays with the caller because it knows
 * the route that should be preserved as `redirect_uri`.
 */
export async function signOutAdminSession(source: string): Promise<Response> {
  const response = await adminFetch("/api/auth/sign-out", {
    method: "POST",
    admin: { channel: "auth", operationName: ADMIN_SIGN_OUT_OPERATION },
  });

  invalidateAdminSession({
    reason: "logout",
    channel: "auth",
    operationName: ADMIN_SIGN_OUT_OPERATION,
    source,
    status: response.status,
  });

  return response;
}
