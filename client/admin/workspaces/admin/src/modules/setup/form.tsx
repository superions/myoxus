/**
 * First-run bootstrap has two screens: welcome and administrator credentials.
 * Navigate only after the same server-config resource confirms initialization;
 * admission then sends the new administrator through the shared sign-in flow.
 */
import { useI18n } from "@myoxus/i18n";
import { ROUTES } from "@myoxus/routes";
import {
  Button,
  notify,
  OnboardingActions,
  OnboardingDescription,
  OnboardingFooter,
  OnboardingFormBody,
  OnboardingFormCard,
  OnboardingProgressBars,
  OnboardingStep,
  OnboardingTitle,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { createFirstAdminUser } from "../../api/setup-bootstrap-api";
import { useAsyncAction } from "../../hooks/use-async-action";
import { useServerConfigResource } from "../common";
import { CreateAdmin } from "./create-admin";
import { type AdminCredentials, validateAdminCredentials } from "./validation";

const DEFAULT_PASSWORD_LIMITS = { minLength: 8, maxLength: 128 };

export enum SetupStep {
  Welcome = 0,
  CreateAdmin,
}

const Welcome = () => {
  const i18n = useI18n();
  return (
    <OnboardingStep compact>
      <OnboardingTitle variant="hero">
        {i18n.t("admin.setup.welcome")}
      </OnboardingTitle>
      <OnboardingDescription variant="hero">
        {i18n.t("admin.setup.welcome-description")}
      </OnboardingDescription>
    </OnboardingStep>
  );
};

const setupStepCount = 2;

export const Form = () => {
  const i18n = useI18n();
  const [current, setCurrent] = useState<SetupStep>(SetupStep.Welcome);

  const navigate = useNavigate();

  const [credentials, setCredentials] = useState<AdminCredentials>({
    name: "",
    email: "",
    password: "",
  });
  const [adminCreated, setAdminCreated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const [invalidEmail, setInvalidEmail] = useState(false);
  const [invalidPassword, setInvalidPassword] = useState(false);

  const { serverConfig, revalidate: refreshServerConfig } =
    useServerConfigResource();
  const passwordLimits =
    serverConfig?.credentialsRequirement.password ?? DEFAULT_PASSWORD_LIMITS;

  const isCreateAdminStep = current === SetupStep.CreateAdmin;

  const disableContinue =
    submitting ||
    ((!credentials.name || !credentials.email || !credentials.password) &&
      isCreateAdminStep);

  const createAdmin = useCallback(async () => {
    try {
      if (!adminCreated) {
        await createFirstAdminUser({
          name: credentials.name,
          email: credentials.email,
          password: credentials.password,
        });
        setAdminCreated(true);
      }
      const refreshedConfig = await refreshServerConfig();
      if (refreshedConfig?.initialized !== true) {
        throw new Error(i18n.t("admin.setup.refresh-failed"));
      }
      notify.success({ title: i18n.t("admin.setup.admin-created") });
    } catch (err) {
      notify.error({
        title: i18n.t("admin.setup.create-admin"),
        message: (err as Error).message,
      });
      console.error(err);
      throw err;
    }
  }, [adminCreated, credentials, refreshServerConfig, i18n]);

  const onNext = useAsyncAction(async () => {
    if (isCreateAdminStep) {
      if (submissionInFlight.current) return;
      if (
        !validateAdminCredentials(
          credentials.email,
          credentials.password,
          passwordLimits,
          setInvalidEmail,
          setInvalidPassword,
        )
      ) {
        return;
      } else {
        submissionInFlight.current = true;
        setSubmitting(true);
        try {
          await createAdmin();
          setInvalidEmail(false);
          setInvalidPassword(false);
          return navigate(ROUTES.admin.configWizard, { replace: true });
        } catch {
          // createAdmin already reports the server/revalidation failure. Keep
          // credential validation independent so a stale server cache is not
          // misrepresented as an invalid email or password.
          return;
        } finally {
          submissionInFlight.current = false;
          setSubmitting(false);
        }
      }
    }

    setCurrent((step) => (step + 1) as SetupStep);
  }, [
    createAdmin,
    current,
    credentials,
    isCreateAdminStep,
    navigate,
    passwordLimits,
  ]);

  const onPrevious = useAsyncAction(async () => {
    if (current > SetupStep.Welcome) {
      setCurrent((step) => (step - 1) as SetupStep);
    }
  }, [current]);

  const currentStep = useMemo(() => {
    if (current === SetupStep.Welcome) {
      return <Welcome />;
    }
    return (
      <CreateAdmin
        values={credentials}
        disabled={submitting || adminCreated}
        invalidEmail={invalidEmail}
        invalidPassword={invalidPassword}
        passwordLimits={passwordLimits}
        onChange={(field, value) => {
          setCredentials((current) => ({ ...current, [field]: value }));
          if (field === "email") setInvalidEmail(false);
          if (field === "password") setInvalidPassword(false);
        }}
      />
    );
  }, [
    current,
    credentials,
    invalidEmail,
    invalidPassword,
    passwordLimits,
    submitting,
    adminCreated,
  ]);

  if (!serverConfig) {
    return null;
  }

  return (
    <Stack
      renderRoot={(props) => <form {...props} noValidate />}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disableContinue) void onNext();
      }}
    >
      <OnboardingFormCard variant="config">
        <OnboardingFormBody>{currentStep}</OnboardingFormBody>
        <OnboardingFooter>
          <OnboardingProgressBars count={setupStepCount} current={current} />
          <OnboardingActions>
            {current > SetupStep.Welcome && (
              <Button
                type="button"
                onClick={onPrevious}
                variant="outline"
                disabled={submitting || adminCreated}
              >
                {i18n.t("admin.setup.back")}
              </Button>
            )}
            <Button
              type="submit"
              disabled={disableContinue}
              loading={isCreateAdminStep && submitting}
            >
              {i18n.t("admin.setup.continue")}
            </Button>
          </OnboardingActions>
        </OnboardingFooter>
      </OnboardingFormCard>
    </Stack>
  );
};
