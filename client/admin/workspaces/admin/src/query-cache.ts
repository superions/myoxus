// SPDX-License-Identifier: AGPL-3.0-or-later
import { adminServerConfigQuery } from "@myoxus/graphql";

export const ADMIN_GRAPHQL_CACHE_NAMESPACE = "admin-graphql";

/** Keep public bootstrap admission mounted when private session data is cleared. */
export function isProtectedAdminQueryKey(key: unknown) {
  return (
    Array.isArray(key) &&
    key[0] === ADMIN_GRAPHQL_CACHE_NAMESPACE &&
    key[1] !== adminServerConfigQuery.id
  );
}
