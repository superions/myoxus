/**
 * Step 3: SMTP Configuration
 *
 * Configure email server for password resets, invitations, etc.
 * Fields: Host, Port, Username, Password, Sender Email
 * Optional: can be skipped and configured later via the settings panel.
 * Test email button to verify configuration.
 */
import { useMutation } from "@myoxus/admin/use-mutation";
import { sendTestEmailMutation } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Checkbox,
  Input,
  PasswordInput,
  Select,
  SettingsField,
  SettingsNotice,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useId, useState } from "react";

import { useAdminUpdateConfig } from "../../../hooks/use-admin-update-config";
import {
  ConfigWizardActions,
  ConfigWizardFieldList,
  ConfigWizardStep,
  ConfigWizardStepHeader,
} from "../primitives";

interface SmtpStepProps {
  onNext: () => void;
  onBusyChange?: (busy: boolean) => void;
}

type SmtpTransport = "plain" | "starttls" | "implicit_tls";

const SMTP_DEFAULT_PORT: Record<SmtpTransport, string> = {
  plain: "25",
  starttls: "587",
  implicit_tls: "465",
};

export function SmtpStep({ onNext, onBusyChange }: SmtpStepProps) {
  const i18n = useI18n();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [transport, setTransport] = useState<SmtpTransport>("starttls");
  const [verifyCertificate, setVerifyCertificate] = useState(true);
  const [senderEmail, setSenderEmail] = useState("");
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const { mutateMany: updateConfig, isLoading: isSaving } =
    useAdminUpdateConfig();
  const { trigger: sendTestEmail } = useMutation({
    mutation: sendTestEmailMutation,
  });
  const [isTesting, setIsTesting] = useState(false);
  const hostInputId = useId();
  const portInputId = useId();
  const usernameInputId = useId();
  const passwordInputId = useId();
  const senderInputId = useId();
  const transportInputId = useId();

  useEffect(() => {
    onBusyChange?.(isSaving || isTesting);
  }, [onBusyChange, isSaving, isTesting]);

  const validateSmtp = useCallback((): boolean => {
    if (!host.trim()) {
      setError(i18n.t("admin.configWizard.smtp.error.hostRequired"));
      return false;
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setError(i18n.t("admin.configWizard.smtp.error.portInvalid"));
      return false;
    }

    if (Boolean(username.trim()) !== Boolean(password.trim())) {
      setError(i18n.t("admin.configWizard.smtp.error.credentialsIncomplete"));
      return false;
    }

    setError("");
    return true;
  }, [host, i18n, password, port, username]);

  const handleTestEmail = useCallback(async () => {
    if (!validateSmtp()) {
      return;
    }

    setIsTesting(true);
    setError("");
    setSuccessMessage("");

    try {
      const result = await sendTestEmail({
        host,
        port: parseInt(port, 10),
        sender: senderEmail || "noreply@myoxus.local",
        username: username.trim() || null,
        password: password.trim() ? password : null,
        transport,
        verifyCertificate,
      });

      if (
        (result as { admin?: { sendTestEmail?: boolean } })?.admin
          ?.sendTestEmail
      ) {
        setSuccessMessage(i18n.t("admin.configWizard.smtp.testSuccess"));
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : i18n.t("admin.configWizard.smtp.error.test");
      setError(message);
    } finally {
      setIsTesting(false);
    }
  }, [
    host,
    port,
    username,
    password,
    transport,
    verifyCertificate,
    senderEmail,
    i18n,
    validateSmtp,
    sendTestEmail,
  ]);

  const handleSave = useCallback(async () => {
    if (!validateSmtp()) {
      return;
    }

    try {
      const portNum = parseInt(port, 10);
      await updateConfig([
        {
          module: "mail",
          key: "smtp_host",
          value: host,
        },
        {
          module: "mail",
          key: "smtp_port",
          value: portNum,
        },
        {
          module: "mail",
          key: "smtp_user",
          value: username.trim() || null,
        },
        {
          module: "mail",
          key: "smtp_pass",
          value: password.trim() ? password : null,
        },
        {
          module: "mail",
          key: "sender",
          value: senderEmail || "noreply@myoxus.local",
        },
        {
          module: "mail",
          key: "smtp_transport",
          value: transport,
        },
        {
          module: "mail",
          key: "smtp_verify_certificate",
          value: verifyCertificate,
        },
      ]);

      onNext();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : i18n.t("admin.configWizard.smtp.error.persist");
      setError(message);
    }
  }, [
    host,
    port,
    username,
    password,
    transport,
    verifyCertificate,
    senderEmail,
    updateConfig,
    onNext,
    i18n,
    validateSmtp,
  ]);

  return (
    <ConfigWizardStep>
      <ConfigWizardStepHeader
        title={i18n.t("admin.configWizard.smtp.title")}
        description={i18n.t("admin.configWizard.smtp.description")}
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {successMessage && (
        <SettingsNotice tone="success">{successMessage}</SettingsNotice>
      )}

      <ConfigWizardFieldList>
        <SettingsField
          label={i18n.t("admin.configWizard.smtp.host")}
          labelFor={hostInputId}
        >
          <Input
            id={hostInputId}
            type="text"
            required
            placeholder={i18n.t("admin.configWizard.smtp.hostPlaceholder")}
            value={host}
            onChange={(value) => {
              setHost(value);
              setError("");
            }}
            status={error && !host ? "error" : "default"}
          />
        </SettingsField>

        <SettingsField
          label={i18n.t("admin.configWizard.smtp.transport")}
          labelFor={transportInputId}
          description={i18n.t("admin.configWizard.smtp.transportHint")}
        >
          <Select
            id={transportInputId}
            value={transport}
            data={[
              {
                value: "starttls",
                label: i18n.t(
                  "admin.configWizard.smtp.transport.option.starttls",
                ),
              },
              {
                value: "implicit_tls",
                label: i18n.t(
                  "admin.configWizard.smtp.transport.option.implicit_tls",
                ),
              },
              {
                value: "plain",
                label: i18n.t("admin.configWizard.smtp.transport.option.plain"),
              },
            ]}
            onChange={(value) => {
              const next = value as SmtpTransport;
              if (port === SMTP_DEFAULT_PORT[transport]) {
                setPort(SMTP_DEFAULT_PORT[next]);
              }
              setTransport(next);
              setError("");
            }}
          />
        </SettingsField>

        <SettingsField
          label={i18n.t("admin.configWizard.smtp.port")}
          labelFor={portInputId}
          description={i18n.t("admin.configWizard.smtp.portHint")}
        >
          <Input
            id={portInputId}
            type="number"
            required
            placeholder="587"
            value={port}
            onChange={(value) => {
              setPort(value);
              setError("");
            }}
            min="1"
            max="65535"
            status={
              error && (parseInt(port, 10) < 1 || parseInt(port, 10) > 65535)
                ? "error"
                : "default"
            }
          />
        </SettingsField>

        <SettingsField
          label={i18n.t("admin.configWizard.smtp.verifyCertificate")}
          description={i18n.t("admin.configWizard.smtp.verifyCertificateHint")}
        >
          <Checkbox
            aria-label={i18n.t("admin.configWizard.smtp.verifyCertificate")}
            checked={verifyCertificate}
            disabled={transport === "plain"}
            onChange={(_, checked) => setVerifyCertificate(checked)}
          />
        </SettingsField>

        <SettingsField
          label={i18n.t("admin.configWizard.smtp.username")}
          labelFor={usernameInputId}
        >
          <Input
            id={usernameInputId}
            type="text"
            placeholder={i18n.t("admin.configWizard.smtp.usernamePlaceholder")}
            value={username}
            onChange={setUsername}
          />
        </SettingsField>

        <SettingsField
          label={i18n.t("admin.configWizard.smtp.password")}
          labelFor={passwordInputId}
        >
          <PasswordInput
            id={passwordInputId}
            placeholder="••••••••"
            value={password}
            onChange={setPassword}
          />
        </SettingsField>

        <SettingsField
          label={i18n.t("admin.configWizard.smtp.sender")}
          labelFor={senderInputId}
          description={i18n.t("admin.configWizard.smtp.senderHint")}
        >
          <Input
            id={senderInputId}
            type="email"
            placeholder="noreply@myoxus.local"
            value={senderEmail}
            onChange={setSenderEmail}
          />
        </SettingsField>

        <ConfigWizardActions centered={false}>
          <Button
            type="button"
            variant="outline"
            onClick={handleTestEmail}
            disabled={!host || isTesting || isSaving}
          >
            {isTesting
              ? i18n.t("common.testing")
              : i18n.t("admin.configWizard.smtp.test")}
          </Button>
        </ConfigWizardActions>
      </ConfigWizardFieldList>

      <ConfigWizardActions centered={false}>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!host || isSaving || isTesting || !!error}
        >
          {isSaving ? i18n.t("common.saving") : i18n.t("common.continue")}
        </Button>
        <Button
          variant="outline"
          onClick={onNext}
          disabled={isSaving || isTesting}
        >
          {i18n.t("admin.configWizard.smtp.skipForNow")}
        </Button>
      </ConfigWizardActions>
    </ConfigWizardStep>
  );
}
