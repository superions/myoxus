/**
 * Server configuration wizard — shown when the server is initialized but not fully configured.
 *
 * Multi-step wizard that guides admins through essential server setup:
 * 1. External URL — HTTPS endpoint for the server
 * 2. Crypto Key — Deployment-owned secret guidance
 * 3. SMTP — Email configuration
 * 4. Auth Method — Login method (magic-link, OAuth, etc.)
 * 5. Complete — Finalization
 *
 * Uses `serverSetupStatus` query to check if setup is needed.
 * Writable steps save configuration via `adminUpdateConfig`; the crypto step
 * documents the file-only, restart-bound deployment contract instead.
 * Final step sets `system.setupCompleted = true`.
 */
import { useI18n } from "@myoxus/i18n";
import {
  AuthBackgroundArt,
  Button,
  Group,
  MyoxusLoader,
  MyoxusOtherPageLayout,
  OnboardingFormCard,
  OnboardingMain,
  SettingsNotice,
  SettingsSectionHeading,
  Stack,
} from "@myoxus/ui-facade";
import { useEffect, useState } from "react";
import { Navigate } from "react-router";

import { useServerSetupStatus } from "../../hooks/use-server-setup-status";
import { Wizard } from "./wizard";

export function ConfigWizard() {
  const i18n = useI18n();
  const {
    data: setupStatus,
    isLoading,
    error,
    refetch,
  } = useServerSetupStatus();
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!isLoading && !error && setupStatus?.setupCompleted === false) {
      setStarted(true);
    }
  }, [error, isLoading, setupStatus?.setupCompleted]);

  // Admission is checked once. CompleteStep owns readback and the visible
  // confirmation; its SWR update must not unmount it before that confirmation.
  if (!started && !isLoading && setupStatus?.setupCompleted) {
    return <Navigate to="/adminfrontend/dashboard" />;
  }

  if (!started && error) {
    return (
      <MyoxusOtherPageLayout showDownloadAction={false}>
        <AuthBackgroundArt />
        <OnboardingMain>
          <OnboardingFormCard variant="config">
            <Stack>
              <SettingsSectionHeading level={1}>
                {i18n.t("admin.configWizard.title")}
              </SettingsSectionHeading>
              <SettingsNotice
                tone="error"
                title={i18n.t("admin.config.error.load-failed")}
              >
                {i18n.t("admin.config.error.load-failed-desc")}
              </SettingsNotice>
              <Group>
                <Button
                  type="button"
                  onClick={() =>
                    void refetch(undefined, { throwOnError: false })
                  }
                >
                  {i18n.t("admin.error.retry")}
                </Button>
              </Group>
            </Stack>
          </OnboardingFormCard>
        </OnboardingMain>
      </MyoxusOtherPageLayout>
    );
  }

  if (!started) {
    return (
      <MyoxusOtherPageLayout showDownloadAction={false}>
        <AuthBackgroundArt />
        <OnboardingMain loading>
          <MyoxusLoader
            size="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
            aria-hidden="true"
          />
        </OnboardingMain>
      </MyoxusOtherPageLayout>
    );
  }

  return (
    <MyoxusOtherPageLayout showDownloadAction={false}>
      <AuthBackgroundArt />
      <Wizard />
    </MyoxusOtherPageLayout>
  );
}

export { ConfigWizard as Component };
