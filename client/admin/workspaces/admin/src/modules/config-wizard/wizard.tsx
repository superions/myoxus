/**
 * Multi-step configuration wizard container.
 *
 * Uses explicit state-driven navigation to navigate through 5 steps:
 * 1. ExternalUrl
 * 2. CryptoKey
 * 3. Smtp
 * 4. AuthMethod
 * 5. Complete
 *
 * Each step owns its completion contract and advances via `onNext`; the shell
 * only owns progress and backward navigation. Writable steps persist their
 * values, while deployment-owned settings provide guidance without a browser
 * write path.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  OnboardingCounter,
  OnboardingDescription,
  OnboardingFooter,
  OnboardingFormBody,
  OnboardingFormCard,
  OnboardingKicker,
  OnboardingMain,
  OnboardingShell,
  OnboardingSideCard,
  OnboardingSideCopy,
  SettingsSectionHeading,
  Stepper,
  StepperStep,
} from "@myoxus/ui-facade";
import { Activity, useCallback, useState } from "react";

import { AuthMethodStep } from "./steps/auth-method";
import { CompleteStep } from "./steps/complete";
import { CryptoKeyStep } from "./steps/crypto-key";
import { ExternalUrlStep } from "./steps/external-url";
import { SmtpStep } from "./steps/smtp";

export enum WizardStep {
  ExternalUrl = 0,
  CryptoKey = 1,
  Smtp = 2,
  AuthMethod = 3,
  Complete = 4,
}

export function Wizard() {
  const i18n = useI18n();
  const [currentStep, setCurrentStep] = useState<WizardStep>(
    WizardStep.ExternalUrl,
  );
  const [busy, setBusy] = useState(false);
  const totalSteps = 5;
  const canGoNext = currentStep < totalSteps - 1;
  const canGoBack =
    currentStep > 0 && currentStep < WizardStep.Complete && !busy;

  const handleNext = useCallback(() => {
    if (canGoNext) {
      setBusy(false);
      setCurrentStep((currentStep + 1) as WizardStep);
    }
  }, [currentStep, canGoNext]);

  const handleBack = useCallback(() => {
    if (canGoBack) {
      setCurrentStep((currentStep - 1) as WizardStep);
    }
  }, [currentStep, canGoBack]);

  const stepLabels = [
    i18n.t("admin.configWizard.step.externalUrl"),
    i18n.t("admin.configWizard.step.cryptoKey"),
    i18n.t("admin.configWizard.step.smtp"),
    i18n.t("admin.configWizard.step.authMethod"),
    i18n.t("admin.configWizard.step.complete"),
  ];

  return (
    <OnboardingMain>
      <OnboardingShell variant="config">
        <OnboardingSideCard variant="config">
          <OnboardingSideCopy>
            <OnboardingKicker>Myoxus</OnboardingKicker>
            <SettingsSectionHeading level={1}>
              {i18n.t("admin.configWizard.title")}
            </SettingsSectionHeading>
            <OnboardingDescription>
              {i18n.t("admin.configWizard.description")}
            </OnboardingDescription>
          </OnboardingSideCopy>

          <Stepper
            active={currentStep}
            orientation="vertical"
            ariaLabel={i18n.t("admin.configWizard.progressLabel")}
            uiRole="config-wizard-progress"
          >
            {stepLabels.map((label) => (
              <StepperStep key={label} label={label} />
            ))}
          </Stepper>
        </OnboardingSideCard>

        <OnboardingFormCard variant="config">
          {/*
           * This wizard is intentionally desktop/admin only. Keep progress in
           * the side-card Stepper instead of reintroducing a mobile header.
           */}
          <OnboardingFormBody>
            {/* Preserve drafts on Back. Activity suspends hidden-step effects,
                so completion writes start only when that step becomes active. */}
            <Activity
              mode={
                currentStep === WizardStep.ExternalUrl ? "visible" : "hidden"
              }
            >
              <ExternalUrlStep onNext={handleNext} onBusyChange={setBusy} />
            </Activity>
            <Activity
              mode={currentStep === WizardStep.CryptoKey ? "visible" : "hidden"}
            >
              <CryptoKeyStep onNext={handleNext} />
            </Activity>
            <Activity
              mode={currentStep === WizardStep.Smtp ? "visible" : "hidden"}
            >
              <SmtpStep onNext={handleNext} onBusyChange={setBusy} />
            </Activity>
            <Activity
              mode={
                currentStep === WizardStep.AuthMethod ? "visible" : "hidden"
              }
            >
              <AuthMethodStep onNext={handleNext} onBusyChange={setBusy} />
            </Activity>
            <Activity
              mode={currentStep === WizardStep.Complete ? "visible" : "hidden"}
            >
              <CompleteStep />
            </Activity>
          </OnboardingFormBody>

          <OnboardingFooter bordered>
            <Button
              variant="outline"
              onClick={handleBack}
              disabled={!canGoBack}
            >
              {i18n.t("common.back")}
            </Button>
            <OnboardingCounter>
              {currentStep + 1} / {totalSteps}
            </OnboardingCounter>
          </OnboardingFooter>
        </OnboardingFormCard>
      </OnboardingShell>
    </OnboardingMain>
  );
}
