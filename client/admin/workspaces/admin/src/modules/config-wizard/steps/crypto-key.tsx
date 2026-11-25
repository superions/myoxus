/**
 * Step 2: Crypto Key Configuration
 *
 * Explains the deployment-owned encryption key boundary.
 *
 * `crypto.private_key` is intentionally file-only and restart-bound. The
 * browser must never generate, read, or persist this server secret.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  OnboardingActions,
  OnboardingStep,
  OnboardingStepHeader,
  SettingsNotice,
  SettingsSectionDescription,
  SettingsSectionHeading,
} from "@myoxus/ui-facade";

interface CryptoKeyStepProps {
  onNext: () => void;
}

export function CryptoKeyStep({ onNext }: CryptoKeyStepProps) {
  const i18n = useI18n();

  return (
    <OnboardingStep compact>
      <OnboardingStepHeader>
        <SettingsSectionHeading level={2}>
          {i18n.t("admin.configWizard.cryptoKey.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.configWizard.cryptoKey.runtimeDescription")}
        </SettingsSectionDescription>
      </OnboardingStepHeader>

      <SettingsNotice
        tone="info"
        title={i18n.t("admin.configWizard.cryptoKey.deploymentTitle")}
      >
        {i18n.t("admin.configWizard.cryptoKey.deploymentText")}
      </SettingsNotice>

      <SettingsNotice
        tone="warning"
        title={i18n.t("admin.configWizard.cryptoKey.restartTitle")}
      >
        {i18n.t("admin.configWizard.cryptoKey.restartText")}
      </SettingsNotice>

      <OnboardingActions fullWidth justify="flex-end">
        <Button variant="primary" onClick={onNext}>
          {i18n.t("common.continue")}
        </Button>
      </OnboardingActions>
    </OnboardingStep>
  );
}
