/**
 * "Send Test Email" action button for the Mailer settings group.
 *
 * Uses the current canonical `mail` snapshot values (including unsaved
 * edits) as the input to `sendTestEmailMutation`.
 * Success and error results are surfaced as `notify` toasts rather than inline
 * form errors, since this is a fire-and-forget test operation.
 */
import { useMutation } from "@myoxus/admin/use-mutation";
import type { UserFriendlyError } from "@myoxus/error";
import { sendTestEmailMutation } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Button, notify } from "@myoxus/ui-facade";
import { useCallback } from "react";

import type { AppConfig } from "../config";

/**
 * Button that triggers a test email send using the currently configured SMTP settings.
 *
 * @param appConfig - The current (possibly patched / unsaved) app config;
 *   canonical mail fields are projected to the transport diagnostic input.
 */
export function SendTestEmail({ appConfig }: { appConfig: AppConfig }) {
  const i18n = useI18n();
  const { trigger } = useMutation({
    mutation: sendTestEmailMutation,
  });

  const onClick = useCallback(async () => {
    const mail = appConfig.mail ?? {};
    try {
      await trigger({
        host: mail.smtp_host,
        port: mail.smtp_port,
        name: mail.smtp_name ?? null,
        sender: mail.sender,
        username: mail.smtp_user ?? null,
        password: mail.smtp_pass ?? null,
        transport: mail.smtp_transport,
        verifyCertificate: mail.smtp_verify_certificate,
      });
      notify.success({
        title: i18n.t("admin.common.test-email-sent"),
        message: i18n.t("admin.common.test-email-sent-description"),
      });
    } catch (error) {
      notify.error({
        title: i18n.t("admin.common.test-email-failed"),
        message: (error as UserFriendlyError).message,
      });
    }
  }, [appConfig, i18n, trigger]);

  return (
    <Button onClick={onClick}>{i18n.t("admin.common.send-test-email")}</Button>
  );
}
