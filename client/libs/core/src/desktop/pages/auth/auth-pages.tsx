// SPDX-License-Identifier: AGPL-3.0-or-later

import { getArtworkUrl } from "@myoxus/theme/artwork";
import type { PasswordLimitsFragment } from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { FetchService, ServerService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import {
  AuthActionStack,
  AuthInput,
  AuthPageContainer,
  ThemedImg,
  AuthStatusText,
  Box,
  Button,
  Checkbox,
  Divider,
  InlineLink,
  Input,
  notify,
  OnboardingActions,
  OnboardingDescription,
  OnboardingFieldList,
  OnboardingFooter,
  OnboardingFormBody,
  OnboardingFormCard,
  OnboardingMain,
  OnboardingStep,
  OnboardingStepHeader,
  OnboardingTitle,
  type User,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { type Location, useLocation, useNavigate } from "react-router";
import useSWR from "swr";

import { sanitizeAuthRedirectTarget } from "./common";

type QuestionOption = {
  type: "checkbox" | "input";
  label: string;
  value: string;
};

type Question = {
  id?: string;
  question: string;
  options?: QuestionOption[];
};

type QuestionnaireAnswer = {
  form: string;
  ask: string;
  answer: string[];
};

const emailRegex =
  /^(?:(?:[^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@(?:(?:\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|((?:[a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

function getCallbackUrl(location: Location) {
  const candidate =
    location.state?.callbackURL ??
    new URLSearchParams(location.search).get("redirect_uri");
  return sanitizeAuthRedirectTarget(
    typeof candidate === "string" ? candidate : undefined,
  );
}

function AuthButtonPage({
  title,
  subtitle,
  button,
  media,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  button: ReactNode;
  media?: ReactNode;
}) {
  return (
    <AuthPageContainer title={title} subtitle={subtitle} media={media}>
      {button}
    </AuthPageContainer>
  );
}

function useSetPassword(
  passwordLimits: PasswordLimitsFragment,
  onSetPassword: (password: string) => void,
) {
  const t = useI18n();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const passwordRef = useRef("");

  const passwordStatus = useMemo(() => {
    if (!password) return null;
    if (password.length < passwordLimits.minLength) {
      return {
        state: "error" as const,
        text: t["com.myoxus.auth.set.password.message.minlength"]({
          min: String(passwordLimits.minLength),
        }),
      };
    }
    if (password.length > passwordLimits.maxLength) {
      return {
        state: "error" as const,
        text: t["com.myoxus.auth.set.password.message.maxlength"]({
          max: String(passwordLimits.maxLength),
        }),
      };
    }
    return { state: "success" as const, text: "OK" };
  }, [password, passwordLimits.maxLength, passwordLimits.minLength, t]);
  const confirmStatus = useMemo(() => {
    if (!confirmPassword) return null;
    return password === confirmPassword
      ? { state: "success" as const, text: "OK" }
      : {
          state: "error" as const,
          text: t["com.myoxus.auth.sign.email.error"](),
        };
  }, [confirmPassword, password, t]);
  const canSubmit =
    !!password &&
    passwordStatus?.state === "success" &&
    confirmStatus?.state === "success";

  passwordRef.current = password;

  const form = (
    <AuthActionStack>
      <AuthInput
        type="password"
        label={t["com.myoxus.auth.set.password.save"]()}
        placeholder={t["com.myoxus.auth.set.password.placeholder"]({
          min: String(passwordLimits.minLength),
        })}
        value={password}
        onChange={(value) => setPassword(value.trim())}
        onEnter={() => {
          if (canSubmit) onSetPassword(passwordRef.current);
        }}
      />
      {passwordStatus ? (
        <AuthStatusText state={passwordStatus.state}>
          {passwordStatus.text}
        </AuthStatusText>
      ) : null}
      <AuthInput
        type="password"
        placeholder={t["com.myoxus.auth.set.password.placeholder.confirm"]()}
        value={confirmPassword}
        onChange={(value) => setConfirmPassword(value.trim())}
        onEnter={() => {
          if (canSubmit) onSetPassword(passwordRef.current);
        }}
      />
      {confirmStatus ? (
        <AuthStatusText state={confirmStatus.state}>
          {confirmStatus.text}
        </AuthStatusText>
      ) : null}
    </AuthActionStack>
  );

  return { form, canSubmit, passwordRef };
}

function SetPasswordForm({
  passwordLimits,
  showLater = false,
  onLater,
  onSetPassword,
}: {
  passwordLimits: PasswordLimitsFragment;
  showLater?: boolean;
  onLater?: () => void;
  onSetPassword: (password: string) => void;
}) {
  const t = useI18n();
  const { form, canSubmit, passwordRef } = useSetPassword(
    passwordLimits,
    onSetPassword,
  );
  return (
    <>
      {form}
      <AuthActionStack align="center" direction="row">
        <Button
          variant="primary"
          size="large"
          disabled={!canSubmit}
          onClick={() => onSetPassword(passwordRef.current)}
        >
          {t["com.myoxus.auth.set.password.save"]()}
        </Button>
        {showLater ? (
          <Button variant="plain" size="large" onClick={onLater}>
            {t["com.myoxus.auth.later"]()}
          </Button>
        ) : null}
      </AuthActionStack>
    </>
  );
}

function PasswordPage({
  passwordLimits,
  onSetPassword: propsOnSetPassword,
  onOpenMyoxus,
  successTitle,
  pendingTitle,
  successSubtitle,
  pendingSubtitle,
  showLater,
  openButtonText,
}: {
  passwordLimits: PasswordLimitsFragment;
  onSetPassword: (password: string) => Promise<void>;
  onOpenMyoxus: () => void;
  successTitle: ReactNode;
  pendingTitle: ReactNode;
  successSubtitle: ReactNode;
  pendingSubtitle: ReactNode;
  showLater?: boolean;
  openButtonText?: string;
}) {
  const t = useI18n();
  const [hasSetUp, setHasSetUp] = useState(false);
  const onSetPassword = useCallback(
    (password: string) => {
      propsOnSetPassword(password)
        .then(() => setHasSetUp(true))
        .catch((error) =>
          notify.error({
            title: t["com.myoxus.auth.password.set-failed"](),
            message: String(error),
          }),
        );
    },
    [propsOnSetPassword, t],
  );

  return (
    <AuthPageContainer
      title={hasSetUp ? successTitle : pendingTitle}
      subtitle={hasSetUp ? successSubtitle : pendingSubtitle}
    >
      {hasSetUp ? (
        <Button variant="primary" size="large" onClick={onOpenMyoxus}>
          {openButtonText ?? t["com.myoxus.auth.open.myoxus"]()}
        </Button>
      ) : (
        <SetPasswordForm
          passwordLimits={passwordLimits}
          onSetPassword={onSetPassword}
          showLater={showLater}
          onLater={() => setHasSetUp(true)}
        />
      )}
    </AuthPageContainer>
  );
}

export const ChangeEmailPage = ({
  onChangeEmail,
}: {
  onChangeEmail: (email: string) => Promise<boolean>;
  onOpenMyoxus: () => void;
}) => {
  const t = useI18n();
  const [hasSetUp, setHasSetUp] = useState(false);
  const [email, setEmail] = useState("");
  const [isValidEmail, setIsValidEmail] = useState(true);
  const [loading, setLoading] = useState(false);
  const onContinue = useCallback(() => {
    void (async () => {
      if (!emailRegex.test(email)) {
        setIsValidEmail(false);
        return;
      }
      setIsValidEmail(true);
      setLoading(true);
      const setup = await onChangeEmail(email);
      setLoading(false);
      setHasSetUp(setup);
    })();
  }, [email, onChangeEmail]);

  return (
    <AuthPageContainer
      title={t["com.myoxus.auth.change.email.page.title"]()}
      subtitle={t["com.myoxus.auth.change.email.page.subtitle"]()}
    >
      <AuthActionStack>
        <AuthInput
          label={t["com.myoxus.settings.email"]()}
          placeholder={t["com.myoxus.auth.sign.email.placeholder"]()}
          value={email}
          onChange={setEmail}
          error={!isValidEmail}
          errorHint={
            isValidEmail ? "" : t["com.myoxus.auth.sign.email.error"]()
          }
          onEnter={onContinue}
          disabled={hasSetUp}
        />
        <Button
          variant="primary"
          size="large"
          onClick={onContinue}
          loading={loading}
          disabled={hasSetUp}
        >
          {t["com.myoxus.auth.set.email.save"]()}
        </Button>
      </AuthActionStack>
    </AuthPageContainer>
  );
};

export const ChangePasswordPage = ({
  passwordLimits,
  onSetPassword,
  onOpenMyoxus,
}: {
  passwordLimits: PasswordLimitsFragment;
  onSetPassword: (password: string) => Promise<void>;
  onOpenMyoxus: () => void;
}) => {
  const t = useI18n();
  return (
    <PasswordPage
      passwordLimits={passwordLimits}
      onSetPassword={onSetPassword}
      onOpenMyoxus={onOpenMyoxus}
      successTitle={t["com.myoxus.auth.reset.password.page.success"]()}
      pendingTitle={t["com.myoxus.auth.reset.password.page.title"]()}
      successSubtitle={t[
        "com.myoxus.auth.sent.reset.password.success.message"
      ]()}
      pendingSubtitle={t["com.myoxus.auth.page.sent.email.subtitle"]({
        min: String(passwordLimits.minLength),
        max: String(passwordLimits.maxLength),
      })}
    />
  );
};

export const SetPasswordPage = ({
  passwordLimits,
  onSetPassword,
  onOpenMyoxus,
}: {
  passwordLimits: PasswordLimitsFragment;
  onSetPassword: (password: string) => Promise<void>;
  onOpenMyoxus: () => void;
}) => {
  const t = useI18n();
  return (
    <PasswordPage
      passwordLimits={passwordLimits}
      onSetPassword={onSetPassword}
      onOpenMyoxus={onOpenMyoxus}
      successTitle={t["com.myoxus.auth.set.password.page.success"]()}
      pendingTitle={t["com.myoxus.auth.set.password.page.title"]()}
      successSubtitle={t["com.myoxus.auth.sent.set.password.success.message"]()}
      pendingSubtitle={t["com.myoxus.auth.page.sent.email.subtitle"]({
        min: String(passwordLimits.minLength),
        max: String(passwordLimits.maxLength),
      })}
    />
  );
};

export const SignUpPage = ({
  passwordLimits,
  user: { email },
  onSetPassword,
  onOpenMyoxus,
  openButtonText,
}: {
  passwordLimits: PasswordLimitsFragment;
  user: { email?: string };
  onSetPassword: (password: string) => Promise<void>;
  openButtonText?: string;
  onOpenMyoxus: () => void;
}) => {
  const t = useI18n();
  return (
    <PasswordPage
      passwordLimits={passwordLimits}
      onSetPassword={onSetPassword}
      onOpenMyoxus={onOpenMyoxus}
      successTitle={t["com.myoxus.auth.sign.up.success.title"]()}
      pendingTitle={t["com.myoxus.auth.page.sent.email.title"]()}
      successSubtitle={t["com.myoxus.auth.sign.up.success.subtitle"]()}
      pendingSubtitle={
        <>
          {t["com.myoxus.auth.page.sent.email.subtitle"]({
            min: String(passwordLimits.minLength),
            max: String(passwordLimits.maxLength),
          })}
          <a href={`mailto:${email}`}>{email}</a>
        </>
      }
      showLater
      openButtonText={openButtonText}
    />
  );
};

export const SignInSuccessPage = ({
  onOpenMyoxus,
}: {
  onOpenMyoxus: () => void;
}) => {
  const t = useI18n();
  return (
    <AuthButtonPage
      media={<ThemedImg fluid alt="" lightSrc={getArtworkUrl("welcome")} />}
      title={t["com.myoxus.auth.signed.success.title"]()}
      subtitle={t["com.myoxus.auth.signed.success.subtitle"]()}
      button={
        <Button variant="primary" size="large" onClick={onOpenMyoxus}>
          {t["com.myoxus.auth.open.myoxus"]()}
        </Button>
      }
    />
  );
};

const QuestionnaireLinks = () => {
  const t = useI18n();
  return (
    <OnboardingActions data-myoxus-ui-role="auth-questionnaire-links">
      <InlineLink
        href={BUILD_CONFIG.licenseUrl}
        target="_blank"
        rel="noreferrer"
      >
        {t["com.myoxus.auth.public-links.license"]()}
      </InlineLink>
      <Divider orientation="vertical" />
      <InlineLink
        href={BUILD_CONFIG.securityUrl}
        target="_blank"
        rel="noreferrer"
      >
        {t["com.myoxus.auth.public-links.security"]()}
      </InlineLink>
    </OnboardingActions>
  );
};

const QuestionnaireLayout = ({
  actions,
  children,
}: {
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <OnboardingMain>
    <Box data-myoxus-ui-role="auth-questionnaire-shell" maw="64rem" w="100%">
      <OnboardingFormCard>
        <OnboardingFormBody>{children}</OnboardingFormBody>
        <OnboardingFooter bordered>
          <QuestionnaireLinks />
          {actions ? (
            <OnboardingActions data-myoxus-ui-role="auth-questionnaire-actions">
              {actions}
            </OnboardingActions>
          ) : null}
        </OnboardingFooter>
      </OnboardingFormCard>
    </Box>
  </OnboardingMain>
);

export const OnboardingPage = ({
  user,
  onOpenMyoxus,
}: {
  user: User;
  onOpenMyoxus: () => void;
}) => {
  const { fetch } = useService(FetchService);
  const { server } = useService(ServerService);
  const location = useLocation();
  const navigate = useNavigate();
  const [questionIdx, setQuestionIdx] = useState(0);
  const { data: questions } = useSWR<Question[]>(
    [server.id, "/api/worker/questionnaire"],
    () =>
      fetch("/api/worker/questionnaire").then((response) => response.json()),
    { suspense: true, revalidateOnFocus: false },
  );
  const [options, setOptions] = useState(new Set<string>());
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const callbackUrl = useMemo(() => getCallbackUrl(location), [location]);
  const question = questions?.[questionIdx];
  const completeQuestion = useCallback(() => {
    if (question?.id && user.id) {
      const answer: QuestionnaireAnswer = {
        form: user.id,
        ask: question.id,
        answer: [
          ...Array.from(options),
          ...Object.entries(inputs).map(([key, value]) => `${key}:${value}`),
        ],
      };
      fetch("/api/worker/questionnaire", {
        method: "POST",
        body: JSON.stringify(answer),
      }).finally(() => {
        setOptions(new Set());
        setInputs({});
        setQuestionIdx((index) => index + 1);
      });
      return;
    }
    setQuestionIdx((index) => index + 1);
  }, [fetch, inputs, options, question?.id, user.id]);

  if (!questions) return null;

  if (question) {
    return (
      <QuestionnaireLayout
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setQuestionIdx(questions.length)}
            >
              Skip
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={completeQuestion}
              suffix={<ArrowRightSmallIcon />}
            >
              {questionIdx === 0 ? "Start" : "Next"}
            </Button>
          </>
        }
      >
        <OnboardingStep data-myoxus-ui-role="auth-questionnaire-step">
          <OnboardingStepHeader>
            <OnboardingTitle variant="step">
              {question.question}
            </OnboardingTitle>
          </OnboardingStepHeader>
          <OnboardingFieldList>
            {question.options?.map((option) =>
              option.type === "checkbox" ? (
                <Checkbox
                  key={option.label}
                  name={option.value}
                  checked={options.has(option.value)}
                  onChange={(_event, checked) => {
                    setOptions((old) => {
                      const next = new Set(old);
                      if (checked) next.add(option.value);
                      else next.delete(option.value);
                      return next;
                    });
                  }}
                  label={option.label}
                />
              ) : (
                <Input
                  key={option.label}
                  type="text"
                  size="large"
                  placeholder={option.label}
                  value={inputs[option.value] || ""}
                  onChange={(value) =>
                    setInputs((prev) => ({
                      ...prev,
                      [option.value]: value,
                    }))
                  }
                />
              ),
            )}
          </OnboardingFieldList>
        </OnboardingStep>
      </QuestionnaireLayout>
    );
  }

  return (
    <QuestionnaireLayout
      actions={
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            if (callbackUrl) navigate(callbackUrl);
            else onOpenMyoxus();
          }}
          suffix={<ArrowRightSmallIcon />}
        >
          Get Started
        </Button>
      }
    >
      <OnboardingStep centered data-myoxus-ui-role="auth-questionnaire-thanks">
        <OnboardingStepHeader>
          <OnboardingTitle variant="hero">Thank you!</OnboardingTitle>
          <OnboardingDescription variant="hero">
            We will continue to enhance our products based on your feedback.
            Thank you once again for your supports.
          </OnboardingDescription>
        </OnboardingStepHeader>
      </OnboardingStep>
    </QuestionnaireLayout>
  );
};
