import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { AuthService, CaptchaService } from "@myoxus/core/modules/server";
import type { AuthSessionStatus } from "@myoxus/core/modules/server/entities/session";
import { Unreachable } from "@myoxus/env/constant";
import { UserFriendlyError } from "@myoxus/error";
import { Trans, useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  AuthCaptchaArea,
  AuthContainer,
  AuthContent,
  AuthFooter,
  AuthHeader,
  AuthHiddenInput,
  AuthInlineActionButton,
  AuthInput,
  AuthStatusText,
  Button,
  notify,
} from "@myoxus/ui-facade";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { SignInState } from ".";
import { AuthContextNotice } from "./auth-context";
import { Back } from "./back";
import { Captcha } from "./captcha";

export const SignInWithEmailStep = ({
  state,
  changeState,
  onAuthenticated,
}: {
  state: SignInState;
  changeState: Dispatch<SetStateAction<SignInState>>;
  onAuthenticated?: (status: AuthSessionStatus) => void;
}) => {
  const initialSent = useRef(false);
  const [resendCountDown, setResendCountDown] = useState(0);

  const email = state.email;

  if (!email) {
    throw new Unreachable();
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setResendCountDown((c) => Math.max(c - 1, 0));
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  const [isSending, setIsSending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | undefined>();
  const [honeypot, setHoneypot] = useState("");

  const t = useI18n();
  const authService = useService(AuthService);
  const captchaService = useService(CaptchaService);

  const verifyToken = useLiveData(captchaService.verifyToken$);
  const needCaptcha = useLiveData(captchaService.needCaptcha$);
  const isCaptchaLoading = useLiveData(captchaService.isLoading$);
  const isCaptchaResolved = useLiveData(captchaService.hasResolved$);

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
    captchaService.revalidate();
  }, [captchaService]);

  const sendEmail = useAsyncCallback(async () => {
    if (
      isSending ||
      isCaptchaLoading ||
      !isCaptchaResolved ||
      (!verifyToken && needCaptcha)
    )
      return;
    setIsSending(true);
    try {
      setResendCountDown(60);
      await authService.sendEmailMagicLink(
        email,
        verifyToken,
        state.redirectUrl,
        honeypot,
      );
    } catch (err) {
      captchaService.revalidate();
      console.error(err);
      const error = UserFriendlyError.fromAny(err);
      notify.error({
        title: t["com.myoxus.auth.toast.title.failed"](),
        message: t[`error.${error.name}`](error.data),
      });
    }
    setIsSending(false);
  }, [
    authService,
    captchaService,
    email,
    honeypot,
    isCaptchaLoading,
    isCaptchaResolved,
    isSending,
    needCaptcha,
    state.redirectUrl,
    verifyToken,
    t,
  ]);

  useEffect(() => {
    if (
      !initialSent.current &&
      isCaptchaResolved &&
      (verifyToken || !needCaptcha)
    ) {
      initialSent.current = true;
      sendEmail();
    }
  }, [initialSent, isCaptchaResolved, needCaptcha, sendEmail, verifyToken]);

  const onSignInWithPasswordClick = useCallback(() => {
    changeState((prev) => ({ ...prev, step: "signInWithPassword" }));
  }, [changeState]);

  const onOtpChanged = useCallback((value: string) => {
    setOtp(value);
    setOtpError(undefined);
  }, []);

  const onContinue = useAsyncCallback(async () => {
    if (isVerifying) return;

    if (otp.length !== 6 || !/[0-9]{6}/.test(otp)) {
      setOtpError(t["com.myoxus.auth.sign.auth.code.invalid"]());
      return;
    }

    setIsVerifying(true);

    try {
      await authService.signInMagicLink(email, otp, false);
    } catch (e) {
      notify.error({
        title: (e as UserFriendlyError).message,
      });
      setOtpError(t["com.myoxus.auth.sign.auth.code.invalid"]());
    } finally {
      setIsVerifying(false);
    }
  }, [authService, email, isVerifying, otp, t]);

  const honeypotField = (
    <AuthHiddenInput value={honeypot} onChange={setHoneypot} />
  );

  return !verifyToken && needCaptcha ? (
    <>
      <AuthHeader title={t["com.myoxus.auth.sign.in"]()} />
      <AuthContent>
        {honeypotField}
        <AuthCaptchaArea>
          <Captcha />
        </AuthCaptchaArea>
      </AuthContent>
      <Back changeState={changeState} />
    </>
  ) : (
    <AuthContainer>
      <AuthHeader
        title={t["com.myoxus.auth.sign.in"]()}
        subTitle={t["com.myoxus.auth.sign.in.sent.email.subtitle"]()}
      />
      <AuthContextNotice authContext={state.authContext} />
      <AuthContent>
        {honeypotField}
        <p>
          <Trans
            i18nKey="com.myoxus.auth.sign.auth.code.hint"
            values={{ email }}
            components={{ a: <a href={`mailto:${email}`} /> }}
          />
        </p>

        <AuthInput
          placeholder={t["com.myoxus.auth.sign.auth.code"]()}
          onChange={onOtpChanged}
          error={!!otpError}
          errorHint={otpError}
          onEnter={onContinue}
          type="text"
          required={true}
          maxLength={6}
        />

        <Button
          data-testid="continue-code-button"
          size="extraLarge"
          block={true}
          onClick={onContinue}
          disabled={!!otpError || isVerifying}
          loading={isVerifying}
        >
          {t["com.myoxus.auth.sign.auth.code.continue"]()}
        </Button>

        <Button
          disabled={resendCountDown > 0}
          variant="plain"
          onClick={sendEmail}
        >
          {resendCountDown <= 0 ? (
            t["com.myoxus.auth.sign.auth.code.resend"]()
          ) : (
            <Trans
              i18nKey="com.myoxus.auth.sign.auth.code.resend.hint"
              values={{ second: resendCountDown }}
            />
          )}
        </Button>
      </AuthContent>

      <AuthFooter>
        <AuthStatusText>
          {t["com.myoxus.auth.sign.auth.code.message"]()}
          &nbsp;
          {state.hasPassword && (
            <Trans
              i18nKey="com.myoxus.auth.sign.auth.code.message.password"
              components={{
                1: (
                  <AuthInlineActionButton
                    data-testid="sign-in-with-password"
                    onClick={onSignInWithPasswordClick}
                  />
                ),
              }}
            />
          )}
        </AuthStatusText>

        <Back changeState={changeState} />
      </AuthFooter>
    </AuthContainer>
  );
};
