/**
 * Step 1: External URL Configuration
 *
 * Input for `server.origin` with:
 * - Validation: must start with https:// or http://
 * - Auto-detection: suggests current browser origin
 * - Save via `adminUpdateConfig` mutation
 */
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Group,
  Input,
  MonoText,
  OnboardingActions,
  OnboardingStep,
  OnboardingStepHeader,
  SettingsNotice,
  SettingsSectionDescription,
  SettingsSectionHeading,
  Text,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

import { useAdminUpdateConfig } from "../../../hooks/use-admin-update-config";

interface ExternalUrlStepProps {
  onNext: () => void;
  onBusyChange?: (busy: boolean) => void;
}

export function ExternalUrlStep({
  onNext,
  onBusyChange,
}: ExternalUrlStepProps) {
  const i18n = useI18n();
  const [externalUrl, setExternalUrl] = useState("");
  const [error, setError] = useState("");
  const { mutate: updateConfig, isLoading } = useAdminUpdateConfig();

  useEffect(() => {
    onBusyChange?.(isLoading);
  }, [onBusyChange, isLoading]);

  const suggestedUrl =
    typeof window !== "undefined" ? window.location.origin : "";

  const validateUrl = useCallback(
    (url: string): boolean => {
      if (!url.startsWith("https://") && !url.startsWith("http://")) {
        setError(i18n.t("admin.configWizard.externalUrl.error.protocol"));
        return false;
      }
      if (url.endsWith("/")) {
        setError(i18n.t("admin.configWizard.externalUrl.error.trailingSlash"));
        return false;
      }
      setError("");
      return true;
    },
    [i18n],
  );

  const handleSuggestedUrl = useCallback(() => {
    setExternalUrl(suggestedUrl);
    validateUrl(suggestedUrl);
  }, [suggestedUrl, validateUrl]);

  const handleUrlChange = useCallback(
    (value: string) => {
      setExternalUrl(value);
      validateUrl(value);
    },
    [validateUrl],
  );

  const handleSave = useCallback(async () => {
    if (isLoading || !validateUrl(externalUrl)) {
      return;
    }

    try {
      await updateConfig({
        module: "server",
        key: "origin",
        value: externalUrl,
      });
      onNext();
    } catch {
      setError(i18n.t("admin.configWizard.externalUrl.error.persist"));
    }
  }, [externalUrl, updateConfig, onNext, i18n, validateUrl, isLoading]);

  return (
    <OnboardingStep compact>
      <OnboardingStepHeader>
        <SettingsSectionHeading level={2}>
          {i18n.t("admin.configWizard.externalUrl.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.configWizard.externalUrl.description")}
        </SettingsSectionDescription>
      </OnboardingStepHeader>

      <Input
        label={i18n.t("admin.configWizard.externalUrl.label")}
        type="url"
        placeholder={i18n.t("admin.configWizard.externalUrl.placeholder")}
        value={externalUrl}
        onChange={handleUrlChange}
        onEnter={handleSave}
        error={error || undefined}
        disabled={isLoading}
      />

      <SettingsNotice tone="neutral">
        <Group>
          <Text>
            {i18n.t("admin.configWizard.externalUrl.current")}:{" "}
            <MonoText>{suggestedUrl}</MonoText>
          </Text>
          <Button
            type="button"
            variant="outline"
            onClick={handleSuggestedUrl}
            disabled={isLoading}
          >
            {i18n.t("admin.configWizard.externalUrl.useCurrent")}
          </Button>
        </Group>
      </SettingsNotice>

      <OnboardingActions fullWidth justify="flex-end">
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!externalUrl || isLoading || !!error}
        >
          {isLoading ? i18n.t("common.saving") : i18n.t("common.continue")}
        </Button>
      </OnboardingActions>
    </OnboardingStep>
  );
}
