// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Input,
  PasswordInput,
  OnboardingDescription,
  OnboardingFieldList,
  OnboardingStep,
  OnboardingStepContent,
  OnboardingStepHeader,
  OnboardingTitle,
} from "@myoxus/ui-facade";

import type { AdminCredentials } from "./validation";

export function CreateAdmin({
  values,
  invalidEmail,
  invalidPassword,
  passwordLimits,
  onChange,
  disabled = false,
}: {
  disabled?: boolean;
  values: AdminCredentials;
  invalidEmail: boolean;
  invalidPassword: boolean;
  passwordLimits: { minLength: number; maxLength: number };
  onChange: (field: keyof AdminCredentials, value: string) => void;
}) {
  const i18n = useI18n();
  const passwordHint = i18n.t("admin.setup.password-hint", {
    min: String(passwordLimits.minLength),
    max: String(passwordLimits.maxLength),
  });

  return (
    <OnboardingStep compact>
      <OnboardingStepContent>
        <OnboardingStepHeader>
          <OnboardingTitle variant="step">
            {i18n.t("admin.setup.create-admin")}
          </OnboardingTitle>
          <OnboardingDescription variant="step">
            {i18n.t("admin.setup.create-admin-description")}
          </OnboardingDescription>
        </OnboardingStepHeader>
        <OnboardingFieldList>
          <Input
            label={i18n.t("admin.setup.name")}
            name="name"
            autoComplete="name"
            autoFocus
            value={values.name}
            onChange={(value) => onChange("name", value)}
            disabled={disabled}
            required
          />
          <Input
            label={i18n.t("admin.auth.email")}
            name="username"
            autoComplete="username"
            type="email"
            value={values.email}
            onChange={(value) => onChange("email", value)}
            error={
              invalidEmail ? i18n.t("admin.setup.invalid-email") : undefined
            }
            disabled={disabled}
            required
          />
          <PasswordInput
            label={i18n.t("admin.auth.password")}
            name="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(value) => onChange("password", value)}
            minLength={passwordLimits.minLength}
            maxLength={passwordLimits.maxLength}
            description={passwordHint}
            error={
              invalidPassword
                ? i18n.t("admin.setup.invalid-password")
                : undefined
            }
            disabled={disabled}
            required
          />
        </OnboardingFieldList>
      </OnboardingStepContent>
    </OnboardingStep>
  );
}
