// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MonoText,
  OnboardingActions,
  OnboardingCompleteIcon,
  OnboardingFieldList,
  OnboardingInlineControls,
  OnboardingStep as FacadeOnboardingStep,
  OnboardingStepHeader,
  SettingsListItemMeta,
  SettingsSectionDescription,
  SettingsSectionHeading,
} from "@myoxus/ui-facade";
import type { PropsWithChildren } from "react";

export function ConfigWizardStep({
  children,
  centered = false,
}: PropsWithChildren<{ centered?: boolean }>) {
  return (
    <FacadeOnboardingStep
      centered={centered}
      compact
      data-myoxus-ui-role="config-wizard-step"
    >
      {children}
    </FacadeOnboardingStep>
  );
}

export function ConfigWizardStepHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <OnboardingStepHeader>
      <SettingsSectionHeading level={2}>{title}</SettingsSectionHeading>
      <SettingsSectionDescription>{description}</SettingsSectionDescription>
    </OnboardingStepHeader>
  );
}

export function ConfigWizardFieldList({ children }: PropsWithChildren) {
  return <OnboardingFieldList>{children}</OnboardingFieldList>;
}

export function ConfigWizardActions({
  children,
  centered = true,
}: PropsWithChildren<{ centered?: boolean }>) {
  return (
    <OnboardingActions
      fullWidth={!centered}
      justify={centered ? "center" : "flex-end"}
      data-myoxus-ui-role="config-wizard-actions"
    >
      {children}
    </OnboardingActions>
  );
}

export function ConfigWizardInlineControls({ children }: PropsWithChildren) {
  return (
    <OnboardingInlineControls data-myoxus-ui-role="config-wizard-inline-controls">
      {children}
    </OnboardingInlineControls>
  );
}

export function ConfigWizardHelpText({ children }: PropsWithChildren) {
  return <SettingsListItemMeta>{children}</SettingsListItemMeta>;
}

export function ConfigWizardInlineCode({ children }: PropsWithChildren) {
  return <MonoText>{children}</MonoText>;
}

export function ConfigWizardCompleteIcon({ children }: PropsWithChildren) {
  return (
    <OnboardingCompleteIcon data-myoxus-ui-role="config-wizard-complete-icon">
      {children}
    </OnboardingCompleteIcon>
  );
}
