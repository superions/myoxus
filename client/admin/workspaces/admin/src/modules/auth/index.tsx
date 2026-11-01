/**
 * Admin auth compatibility route.
 *
 * `/adminfrontend/auth` intentionally no longer renders a separate login form.
 * It redirects to the shared web sign-in page with an admin UI context and a
 * local admin redirect target.
 */
import { ROUTES } from "@myoxus/routes";
import { Navigate } from "react-router";

import { useAdminSessionSnapshot } from "../../admin-session";
import { isAdmin, useCurrentUser } from "../common";
import { NoAdminAccess } from "./no-admin-access";
import { buildAdminSignInUrl } from "./redirect";
import { SharedSignInRedirect } from "./shared-sign-in-redirect";

export function Auth() {
  const currentUser = useCurrentUser();
  const session = useAdminSessionSnapshot();

  if (session.invalidated)
    return <SharedSignInRedirect to={buildAdminSignInUrl()} />;

  if (currentUser === undefined) {
    return null;
  }

  if (currentUser && isAdmin(currentUser)) {
    return <Navigate to={ROUTES.admin.index} replace />;
  }

  if (currentUser) {
    return <NoAdminAccess />;
  }

  return <SharedSignInRedirect to={buildAdminSignInUrl()} />;
}

export { Auth as Component };
