/** Shared operator-facing projection of server-owned setup findings. */
import { useI18n } from "@myoxus/i18n";
import { SettingsListItemMeta, SettingsNotice, Stack } from "@myoxus/ui-facade";

import { useServerSetupStatus } from "../hooks/use-server-setup-status";

const FINDING_MESSAGE_KEYS = {
  CRYPTO_UNSAFE: "admin.operationalReadiness.finding.cryptoUnsafe",
  SERVER_ORIGIN_INVALID:
    "admin.operationalReadiness.finding.serverOriginInvalid",
  SMTP_UNAVAILABLE: "admin.operationalReadiness.finding.smtpUnavailable",
  AUTH_METHOD_UNAVAILABLE:
    "admin.operationalReadiness.finding.authMethodUnavailable",
  RATE_LIMIT_DISABLED: "admin.operationalReadiness.finding.rateLimitDisabled",
} as const;

export function OperationalReadinessNotice() {
  const i18n = useI18n();
  const { data: status } = useServerSetupStatus();
  if (!status?.setupCompleted || status.findings.length === 0) {
    return null;
  }

  const critical = status.findings.filter(
    (finding) => finding.severity === "critical",
  );
  const warnings = status.findings.filter(
    (finding) => finding.severity !== "critical",
  );
  const renderMessages = (findings: typeof status.findings) => (
    <Stack>
      {findings.map((finding) => {
        const key =
          FINDING_MESSAGE_KEYS[
            finding.code as keyof typeof FINDING_MESSAGE_KEYS
          ];
        return (
          <SettingsListItemMeta key={`${finding.severity}:${finding.code}`}>
            {key
              ? i18n.t(key)
              : i18n.t("admin.operationalReadiness.finding.unknown", {
                  code: finding.code,
                })}
          </SettingsListItemMeta>
        );
      })}
    </Stack>
  );

  return (
    <Stack data-testid="operational-readiness-notices">
      {critical.length > 0 ? (
        <SettingsNotice
          tone="error"
          title={i18n.t("admin.operationalReadiness.critical.title")}
        >
          {renderMessages(critical)}
        </SettingsNotice>
      ) : null}
      {warnings.length > 0 ? (
        <SettingsNotice
          tone="warning"
          title={i18n.t("admin.operationalReadiness.warning.title")}
        >
          {renderMessages(warnings)}
        </SettingsNotice>
      ) : null}
    </Stack>
  );
}
