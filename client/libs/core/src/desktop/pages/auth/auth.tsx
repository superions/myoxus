// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

export const loader: LoaderFunction = async ({ params }) => {
  if (!params.authType || !authTypeSchema.safeParse(params.authType).success) {
    return redirect("/404");
  }
  return null;
};

export function Component() {
  const t = useI18n();
  const authService = useService(AuthService);
  const serverService = useService(ServerService);
  const account = useLiveData(authService.session.account$);
  const passwordLimits = useLiveData(
    serverService.server.credentialsRequirement$.map((req) => req?.password),
  );

  const { authType } = useParams();
  const [searchParams] = useSearchParams();
  const { jumpToIndex } = useNavigateHelper();

  const { trigger: changePassword } = useMutation({
    mutation: changePasswordMutation,
  });
  const { trigger: sendVerifyChangeEmail } = useMutation({
    mutation: sendVerifyChangeEmailMutation,
  });

  const handleSendVerifyChangeEmail = useCallback(
    async (email: string) => {
      const response = await sendVerifyChangeEmail({
        token: searchParams.get("token") ?? "",
        email,
        callbackUrl: "/auth/confirm-change-email",
      }).catch(console.error);

      if (response?.sendVerifyChangeEmail) {
        notify.success({
          title: t["com.myoxus.auth.sent.verify.email.hint"](),
        });
      } else {
        notify.error({
          title: t["com.myoxus.auth.sent.change.email.fail"](),
        });
      }
      return Boolean(response?.sendVerifyChangeEmail);
    },
    [searchParams, sendVerifyChangeEmail, t],
  );

  const handleSetPassword = useCallback(
    async (newPassword: string) => {
      await changePassword({
        token: searchParams.get("token") ?? "",
        userId: searchParams.get("userId") ?? "",
        newPassword,
      });
    },
    [changePassword, searchParams],
  );

  const handleOpenMyoxus = useCallback(() => {
    jumpToIndex(RouteLogic.REPLACE);
  }, [jumpToIndex]);

  if (!passwordLimits) {
    return <AppContainer fallback />;
  }

  switch (authType) {
    case "onboarding":
      return account ? (
        <OnboardingPage user={account} onOpenMyoxus={handleOpenMyoxus} />
      ) : null;
    case "signUp":
      return account ? (
        <SignUpPage
          user={account}
          passwordLimits={passwordLimits}
          onSetPassword={handleSetPassword}
          onOpenMyoxus={handleOpenMyoxus}
        />
      ) : null;
    case "signIn":
      return <SignInSuccessPage onOpenMyoxus={handleOpenMyoxus} />;
    case "changePassword":
      return (
        <ChangePasswordPage
          passwordLimits={passwordLimits}
          onSetPassword={handleSetPassword}
          onOpenMyoxus={handleOpenMyoxus}
        />
      );
    case "setPassword":
      return (
        <SetPasswordPage
          passwordLimits={passwordLimits}
          onSetPassword={handleSetPassword}
          onOpenMyoxus={handleOpenMyoxus}
        />
      );
    case "changeEmail":
      return (
        <ChangeEmailPage
          onChangeEmail={handleSendVerifyChangeEmail}
          onOpenMyoxus={handleOpenMyoxus}
        />
      );
    case "confirm-change-email":
      return <ConfirmChangeEmail onOpenMyoxus={handleOpenMyoxus} />;
    case "verify-email":
      return <ConfirmVerifiedEmail onOpenMyoxus={handleOpenMyoxus} />;
    default:
      return null;
  }
}
