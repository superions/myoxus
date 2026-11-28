// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  DialogComponentProps,
  GLOBAL_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import {
  AuthService,
  DefaultServerService,
  ServersService,
} from "@myoxus/core/modules/server";
import { Unreachable } from "@myoxus/env/constant";
import {
  sendChangeEmailMutation,
  sendVerifyEmailMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { ConfirmModal, Input, notify } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

export const VerifyEmailDialog = ({
  close,
  server: serverBaseUrl,
  changeEmail,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["verify-email"]>) => {
  const t = useI18n();
  const defaultServerService = useService(DefaultServerService);
  const serversService = useService(ServersService);

  const server = serverBaseUrl
    ? serversService.getServerByBaseUrl(serverBaseUrl)
    : defaultServerService.server;
  if (!server) {
    throw new Unreachable("Server not found");
  }

  const authService = server.scope.get(AuthService);
  const account = useLiveData(authService.session.account$);
  const email = account?.email;
  const [hasSentEmail, setHasSentEmail] = useState(false);

  if (!email) {
    throw new Unreachable();
  }

  const handleSendEmail = useCallback(async () => {
    try {
      if (changeEmail) {
        await server.gql({
          query: sendChangeEmailMutation,
          variables: { callbackUrl: "/auth/changeEmail" },
        });
      } else {
        await server.gql({
          query: sendVerifyEmailMutation,
          variables: { callbackUrl: "/auth/verify-email" },
        });
      }

      notify.success({
        title: t["com.myoxus.auth.send.verify.email.hint"](),
      });
      setHasSentEmail(true);
    } catch (error) {
      console.error(error);
      notify.error({
        title: t["com.myoxus.auth.sent.change.email.fail"](),
      });
      throw error;
    }
  }, [changeEmail, server, t]);

  return (
    <ConfirmModal
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      title={
        changeEmail
          ? t["com.myoxus.settings.email.action.change"]()
          : t["com.myoxus.settings.email.action.verify"]()
      }
      description={
        changeEmail
          ? t["com.myoxus.auth.change.email.message"]({ email })
          : t["com.myoxus.auth.verify.email.message"]({ email })
      }
      cancelText={t["Cancel"]()}
      confirmText={
        hasSentEmail
          ? t["com.myoxus.auth.sent"]()
          : t["com.myoxus.auth.send.verify.email.hint"]()
      }
      confirmButtonOptions={{ disabled: hasSentEmail }}
      closeOnConfirm={false}
      onConfirm={handleSendEmail}
      contentOptions={{
        ["data-testid" as string]: "verify-email-modal",
      }}
    >
      <Input label={t["com.myoxus.settings.email"]()} disabled value={email} />
    </ConfirmModal>
  );
};
