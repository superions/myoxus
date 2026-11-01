import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import {
  AuthService,
  CaptchaService,
  ServerService,
} from "@myoxus/core/modules/server";
import type { AuthSessionStatus } from "@myoxus/core/modules/server/entities/session";
import { Unreachable } from "@myoxus/env/constant";
import { UserFriendlyError } from "@myoxus/error";
import { ServerDeploymentType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  AuthActionStack,
  AuthContainer,
  AuthContent,
  AuthFooter,
  AuthHeader,
  AuthHiddenInput,
  AuthInput,
  Button,
  notify,
} from "@myoxus/ui-facade";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";

import type { SignInState } from ".";
import { AuthContextNotice } from "./auth-context";
import { Back } from "./back";
import { Captcha } from "./captcha";

export const SignInWithPasswordStep = ({
  state,
  changeState,
  onAuthenticated,
}: {
  state: SignInState;
  changeState: Dispatch<SetStateAction<SignInState>>;
  onAuthenticated?: (status: AuthSessionStatus) => void;
}) => {
  const t = useI18n();
  const authService = useService(AuthService);

  const email = state.email;

  if (!email) {
    throw new Unreachable();
  }

  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState(false);
  const [passwordErrorHint, setPasswordErrorHint] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const captchaService = useService(CaptchaService);
  const serverService = useService(ServerService);
  const isStandalone = useLiveData(
    serverService.server.config$.selector(
      (c) => c.type === ServerDeploymentType.Standalone,
    ),
  );
  const serverName = useLiveData(
    serverService.server.config$.selector((c) => c.serverName),
  );

  const verifyToken = useLiveData(captchaService.verifyToken$);
  const needCaptcha = useLiveData(captchaService.needCaptcha$);
  const isCaptchaLoading = useLiveData(captchaService.isLoading$);
  const isCaptchaResolved = useLiveData(captchaService.hasResolved$);
  const [isLoading, setIsLoading] = useState(false);

  const loginStatus = useLiveData(authService.session.status$);

  useEffect(() => {
    if (loginStatus === "authenticated") {
      notify.success({
        title: t["com.myoxus.auth.toast.title.signed-in"](),
        message: t["com.myoxus.auth.toast.message.signed-in"](),
      });
    }
    onAuthenticated?.(loginStatus);
  }, [loginStatus, onAuthenticated, t]);

  useEffect(() => {
    setPasswordErrorHint(t["com.myoxus.auth.password.error"]());
  }, [t]);

  useEffect(() => {
    captchaService.revalidate();
  }, [captchaService]);

  const onSignIn = useAsyncCallback(async () => {
    if (
      isLoading ||
      isCaptchaLoading ||
      !isCaptchaResolved ||
      (!verifyToken && needCaptcha)
    )
      return;
    setIsLoading(true);

    try {
      await authService.signInPassword({
        email,
        password,
        verifyToken,
        honeypot,
      });
    } catch (err) {
      captchaService.revalidate();
      console.error(err);
      const error = UserFriendlyError.fromAny(err);

      if (
        error.is("WRONG_SIGN_IN_CREDENTIALS") ||
        error.is("PASSWORD_REQUIRED")
      ) {
        setPasswordError(true);
        setPasswordErrorHint(t["com.myoxus.auth.password.error"]());
      } else {
        setPasswordError(false);
        notify.error({
          title: t["com.myoxus.auth.toast.title.failed"](),
          message: error.is("REQUEST_ABORTED")
            ? t["error.NETWORK_ERROR"]()
            : t[`error.${error.name}`](error.data),
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [
    isLoading,
    isCaptchaLoading,
    isCaptchaResolved,
    verifyToken,
    needCaptcha,
    captchaService,
    authService,
    email,
    password,
    honeypot,
    t,
  ]);

  const sendMagicLink = useCallback(() => {
    changeState((prev) => ({ ...prev, step: "signInWithEmail" }));
  }, [changeState]);

  return (
    <AuthContainer>
      <AuthHeader
        title={t["com.myoxus.auth.sign.in"]()}
        subTitle={serverName}
      />
      <AuthContextNotice authContext={state.authContext} />

      <AuthContent>
        <AuthHiddenInput value={honeypot} onChange={setHoneypot} />
        <AuthInput
          label={t["com.myoxus.settings.email"]()}
          // Keep the real username eligible for credential autofill, not the bot trap.
          readOnly
          name="username"
          autoComplete="username"
          value={email}
        />
        <AuthInput
          autoFocus
          data-testid="password-input"
          label={t["com.myoxus.auth.password"]()}
          value={password}
          type="password"
          name="password"
          autoComplete="current-password"
          onChange={(value: string) => {
            setPassword(value);
            if (passwordError) {
              setPasswordError(false);
              setPasswordErrorHint(t["com.myoxus.auth.password.error"]());
            }
          }}
          error={passwordError}
          errorHint={passwordErrorHint}
          onEnter={onSignIn}
        />
        {!isStandalone && (
          <AuthActionStack align="end">
            <Button
              data-testid="send-magic-link-button"
              variant="plain"
              onClick={sendMagicLink}
            >
              {t["com.myoxus.auth.sign.auth.code.send-email.sign-in"]()}
            </Button>
          </AuthActionStack>
        )}
        {needCaptcha && <Captcha />}
        <Button
          data-testid="sign-in-button"
          variant="primary"
          size="extraLarge"
          block
          disabled={
            isLoading ||
            isCaptchaLoading ||
            !isCaptchaResolved ||
            (!verifyToken && needCaptcha)
          }
          onClick={onSignIn}
        >
          {t["com.myoxus.auth.sign.in"]()}
        </Button>
      </AuthContent>
      <AuthFooter>
        <Back changeState={changeState} />
      </AuthFooter>
    </AuthContainer>
  );
};
