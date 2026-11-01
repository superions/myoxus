/**
 * Polymorphic auth action page (`/auth/:authType`).
 *
 * A single route handles several post-authentication actions distinguished by
 * the `:authType` path segment. The supported values are defined in
 * `authTypeSchema` and validated by the route `loader` — invalid types receive
 * a hard redirect to `/404`.
 *
 * Supported auth types:
 * - `onboarding`             — welcome screen shown after first sign-up
 * - `setPassword`            — set initial password (magic-link accounts)
 * - `signIn`                 — sign-in success confirmation
 * - `changePassword`         — change existing password (token required)
 * - `signUp`                 — complete sign-up (set display name / password)
 * - `changeEmail`            — initiate email-change flow
 * - `confirm-change-email`   — confirm the new email address
 * - `verify-email`           — verify email after registration
 * - `subscription-redirect`  — (not rendered, kept for redirect compat)
 *
 * Token and user-id are read from search params and forwarded directly to the
 * GraphQL mutations (`changePasswordMutation`, `sendVerifyChangeEmailMutation`).
 */
import {
  changePasswordMutation,
  sendVerifyChangeEmailMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { useCallback } from "react";
import {
  type LoaderFunction,
  redirect,
  useParams,
  useSearchParams,
} from "react-router";
import { z } from "zod";

import { useMutation } from "../../../components/hooks/use-mutation";
import {
  RouteLogic,
  useNavigateHelper,
} from "../../../components/hooks/use-navigate-helper";
import { AuthService, ServerService } from "../../../modules/server";
import { AppContainer } from "../../components/app-container";
import {
  ChangeEmailPage,
  ChangePasswordPage,
  OnboardingPage,
  SetPasswordPage,
  SignInSuccessPage,
  SignUpPage,
} from "./auth-pages";
import { ConfirmChangeEmail } from "./confirm-change-email";
import { ConfirmVerifiedEmail } from "./email-verified-email";

/** Zod schema used to validate the `:authType` route parameter. */
const authTypeSchema = z.enum([
  "onboarding",
  "setPassword",
  "signIn",
  "changePassword",
  "signUp",
  "changeEmail",
  "confirm-change-email",
  "subscription-redirect",
  "verify-email",
]);

export const Component = () => {
  const authService = useService(AuthService);
  const account = useLiveData(authService.session.account$);
  const t = useI18n();
  const serverService = useService(ServerService);
  const passwordLimits = useLiveData(
    serverService.server.credentialsRequirement$.map((r) => r?.password),
  );

  const { authType } = useParams();
  const [searchParams] = useSearchParams();

  const { trigger: changePassword } = useMutation({
    mutation: changePasswordMutation,
  });

  const { trigger: sendVerifyChangeEmail } = useMutation({
    mutation: sendVerifyChangeEmailMutation,
  });

  const { jumpToIndex } = useNavigateHelper();

  const onSendVerifyChangeEmail = useCallback(
    async (email: string) => {
      const res = await sendVerifyChangeEmail({
        token: searchParams.get("token") || "",
        email,
        callbackUrl: `/auth/confirm-change-email`,
      }).catch(console.error);

      // FIXME: There is not notification
      if (res?.sendVerifyChangeEmail) {
        notify.success({
          title: t["com.myoxus.auth.sent.verify.email.hint"](),
        });
      } else {
        notify.error({
          title: t["com.myoxus.auth.sent.change.email.fail"](),
        });
      }

      return !!res?.sendVerifyChangeEmail;
    },
    [searchParams, sendVerifyChangeEmail, t],
  );

  const onSetPassword = useCallback(
    async (password: string) => {
      await changePassword({
        token: searchParams.get("token") || "",
        userId: searchParams.get("userId") || "",
        newPassword: password,
      });
    },
    [changePassword, searchParams],
  );
  const onOpenMyoxus = useCallback(() => {
    jumpToIndex(RouteLogic.REPLACE);
  }, [jumpToIndex]);

  if (!passwordLimits) {
    return <AppContainer fallback />;
  }

  switch (authType) {
    case "onboarding":
      return (
        account && <OnboardingPage user={account} onOpenMyoxus={onOpenMyoxus} />
      );
    case "signUp": {
      return (
        account && (
          <SignUpPage
            user={account}
            passwordLimits={passwordLimits}
            onSetPassword={onSetPassword}
            onOpenMyoxus={onOpenMyoxus}
          />
        )
      );
    }
    case "signIn": {
      return <SignInSuccessPage onOpenMyoxus={onOpenMyoxus} />;
    }
    case "changePassword": {
      return (
        <ChangePasswordPage
          passwordLimits={passwordLimits}
          onSetPassword={onSetPassword}
          onOpenMyoxus={onOpenMyoxus}
        />
      );
    }
    case "setPassword": {
      return (
        <SetPasswordPage
          passwordLimits={passwordLimits}
          onSetPassword={onSetPassword}
          onOpenMyoxus={onOpenMyoxus}
        />
      );
    }
    case "changeEmail": {
      return (
        <ChangeEmailPage
          onChangeEmail={onSendVerifyChangeEmail}
          onOpenMyoxus={onOpenMyoxus}
        />
      );
    }
    case "confirm-change-email": {
      return <ConfirmChangeEmail onOpenMyoxus={onOpenMyoxus} />;
    }
    case "verify-email": {
      return <ConfirmVerifiedEmail onOpenMyoxus={onOpenMyoxus} />;
    }
  }
  return null;
};

/**
 * React Router loader for the `/auth/:authType` route.
 *
 * Validates the `:authType` segment against `authTypeSchema` before the
 * component mounts. Redirects to `/404` for any unknown or missing auth type
 * so the component can assume a valid type without defensive checks.
 */
export const loader: LoaderFunction = async (args) => {
  if (!args.params.authType) {
    return redirect("/404");
  }
  if (!authTypeSchema.safeParse(args.params.authType).success) {
    return redirect("/404");
  }

  return null;
};
