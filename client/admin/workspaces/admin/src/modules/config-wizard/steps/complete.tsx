/**
 * Step 5: Setup Complete
 *
 * Final step: confirms server readback before offering dashboard navigation.
 * Sets `system.setupCompleted = true` in the background.
 */
import { useI18n } from "@myoxus/i18n";
import { CheckIcon } from "@myoxus/icons/react";
import { ROUTES } from "@myoxus/routes";
import { Button, SettingsNotice } from "@myoxus/ui-facade";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useAdminUpdateConfig } from "../../../hooks/use-admin-update-config";
import { useServerSetupStatus } from "../../../hooks/use-server-setup-status";
import {
  ConfigWizardActions,
  ConfigWizardCompleteIcon,
  ConfigWizardStep,
  ConfigWizardStepHeader,
} from "../primitives";

export function CompleteStep() {
  const i18n = useI18n();
  const navigate = useNavigate();
  const [completed, setCompleted] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const persisted = useRef(false);
  const { mutate: updateConfig } = useAdminUpdateConfig();
  const { refetch: refetchSetupStatus } = useServerSetupStatus();
  const persistErrorMessage = i18n.t(
    "admin.configWizard.complete.error.persist",
  );
  const verifyErrorMessage = i18n.t("admin.configWizard.complete.error.verify");

  useEffect(() => {
    let cancelled = false;
    const markSetupComplete = async () => {
      let persistenceConfirmed = persisted.current;
      setCompletionError(null);
      try {
        if (!persistenceConfirmed) {
          await updateConfig({
            module: "system",
            key: "setupCompleted",
            value: true,
          });
          persisted.current = true;
          persistenceConfirmed = true;
        }
        const status = await refetchSetupStatus();
        if (status?.setupCompleted !== true) {
          throw new Error("setup completion was not confirmed");
        }
        if (cancelled) return;
        setCompletionError(null);
        setCompleted(true);
      } catch (err) {
        if (cancelled) return;
        setCompletionError(
          persistenceConfirmed ? verifyErrorMessage : persistErrorMessage,
        );
        console.error("config_wizard.setup_completion_failed", err);
      }
    };

    void markSetupComplete();
    return () => {
      cancelled = true;
    };
  }, [
    attempt,
    persistErrorMessage,
    refetchSetupStatus,
    updateConfig,
    verifyErrorMessage,
  ]);

  return (
    <ConfigWizardStep centered>
      {completed && (
        <ConfigWizardCompleteIcon>
          <CheckIcon size="var(--mantine-spacing-xl)" aria-hidden="true" />
        </ConfigWizardCompleteIcon>
      )}
      <ConfigWizardStepHeader
        title={
          completed
            ? i18n.t("admin.configWizard.complete.title")
            : i18n.t("admin.configWizard.step.complete")
        }
        description={
          completed
            ? i18n.t("admin.configWizard.complete.description")
            : completionError
              ? ""
              : i18n.t("common.saving")
        }
      />

      {completionError ? (
        <SettingsNotice tone="error" data-testid="setup-completion-error">
          {completionError}
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            {i18n.t("admin.error.retry")}
          </Button>
        </SettingsNotice>
      ) : null}

      {completed && (
        <ConfigWizardActions>
          <Button
            variant="primary"
            onClick={() => navigate(ROUTES.admin.dashboard)}
          >
            {i18n.t("admin.configWizard.complete.goToDashboard")}
          </Button>
        </ConfigWizardActions>
      )}
    </ConfigWizardStep>
  );
}
