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
  sendChangePasswordEmailMutation,
  sendSetPasswordEmailMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { ConfirmModal, Input, notify } from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

export const ChangePasswordDialog = ({
  close,
  server: serverBaseUrl,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["change-password"]>) => {
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
  const passwordLimits = useLiveData(
    server.credentialsRequirement$.map((req) => req?.password),
  );
  const [hasSentEmail, setHasSentEmail] = useState(false);

  const hasPassword = Boolean(account?.info?.hasPassword);

  useEffect(() => {
    if (!account) {
      close();
    }
  }, [account, close]);

  const handleSendEmail = useCallback(async () => {
    try {
      if (hasPassword) {
        await server.gql({
          query: sendChangePasswordEmailMutation,
          variables: { callbackUrl: "/auth/changePassword" },
        });
      } else {
        await server.gql({
          query: sendSetPasswordEmailMutation,
          variables: { callbackUrl: "/auth/setPassword" },
        });
      }

      notify.success({
        title: hasPassword
          ? t["com.myoxus.auth.sent.change.password.hint"]()
          : t["com.myoxus.auth.sent.set.password.hint"](),
      });
      setHasSentEmail(true);
    } catch (error) {
      console.error(error);
      notify.error({
        title: t["com.myoxus.auth.sent.change.email.fail"](),
      });
      throw error;
    }
  }, [hasPassword, server, t]);

  if (!passwordLimits) {
    return null;
  }

  return (
    <ConfirmModal
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      title={
        hasPassword
          ? t["com.myoxus.auth.reset.password"]()
          : t["com.myoxus.auth.set.password"]()
      }
      description={
        hasPassword
          ? t["com.myoxus.auth.reset.password.message"]()
          : t["com.myoxus.auth.set.password.message"]({
              min: String(passwordLimits.minLength),
              max: String(passwordLimits.maxLength),
            })
      }
      cancelText={t["Cancel"]()}
      confirmText={
        hasSentEmail
          ? t["com.myoxus.auth.sent"]()
          : hasPassword
            ? t["com.myoxus.auth.send.reset.password.link"]()
            : t["com.myoxus.auth.send.set.password.link"]()
      }
      confirmButtonOptions={{ disabled: hasSentEmail }}
      closeOnConfirm={false}
      onConfirm={handleSendEmail}
      contentOptions={{
        ["data-testid" as string]: "change-password-modal",
      }}
    >
      <Input
        label={t["com.myoxus.settings.email"]()}
        disabled
        value={account?.email}
      />
    </ConfirmModal>
  );
};
