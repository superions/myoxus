/**
 * First-run setup page — shown when `config.initialized` is `false`.
 *
 * Guards against re-entry: if the server has already been initialised (an
 * admin account exists), this page immediately redirects to the protected configuration wizard.
 * Otherwise it renders the onboarding `Form` in the shared Auth/Onboarding
 * shell with the same decorative background used by sign-in.
 */
import { ROUTES } from "@myoxus/routes";
import {
  AuthBackgroundArt,
  MyoxusOtherPageLayout,
  SignInPageContainer,
} from "@myoxus/ui-facade";
import { Navigate } from "react-router";

import { useServerConfig } from "../common";
import { Form } from "./form";

/**
 * Root component for the initial server setup flow.
 *
 * Resumes protected configuration if the server is already initialized.
 * Otherwise renders the two-step bootstrap `Form` in the shared auth container.
 */
export function Setup() {
  const config = useServerConfig();

  if (!config) {
    return null;
  }

  if (config.initialized) {
    return <Navigate to={ROUTES.admin.configWizard} replace />;
  }

  return (
    <MyoxusOtherPageLayout showDownloadAction={false}>
      <AuthBackgroundArt />
      <SignInPageContainer>
        <Form />
      </SignInPageContainer>
    </MyoxusOtherPageLayout>
  );
}

export { Setup as Component };
