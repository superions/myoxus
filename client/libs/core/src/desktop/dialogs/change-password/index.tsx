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
import { useEffect, useState } from "react";

export const ChangePasswordDialog = ({
  close,
  server: serverBaseUrl,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["change-password"]>) => {
  const t = useI18n();
  const defaultServerService = useService(DefaultServerService);
  const serversService = useService(ServersService);
  let server;

  if (serverBaseUrl) {
    server = serversService.getServerByBaseUrl(serverBaseUrl);
    if (!server) {
      throw new Unreachable("Server not found");
    }
  } else {
    server = defaultServerService.server;
  }

  const authService = server.scope.get(AuthService);
  const account = useLiveData(authService.session.account$);
  const email = account?.email;
  const hasPassword = account?.info?.hasPassword;
  const [hasSentEmail, setHasSentEmail] = useState(false);
  const passwordLimits = useLiveData(
    server.credentialsRequirement$.map((r) => r?.password),
  );

  useEffect(() => {
    if (!account) {
      // we are logged out, close the dialog
      close();
    }
  }, [account, close]);

  const onSendEmail = async () => {
    try {
      if (hasPassword) {
        await server.gql({
          query: sendChangePasswordEmailMutation,
          variables: {
            callbackUrl: `/auth/changePassword`,
          },
        });
      } else {
        await server.gql({
          query: sendSetPasswordEmailMutation,
          variables: {
            callbackUrl: `/auth/setPassword`,
          },
        });
      }

      notify.success({
        title: hasPassword
          ? t["com.myoxus.auth.sent.change.password.hint"]()
          : t["com.myoxus.auth.sent.set.password.hint"](),
      });
      setHasSentEmail(true);
    } catch (err) {
      console.error(err);
      notify.error({
        title: t["com.myoxus.auth.sent.change.email.fail"](),
      });
      throw err;
    }
  };

  if (!passwordLimits) {
    // TODO(@eyhn): loading & error UI
    return null;
  }

  return (
    <ConfirmModal
      open
      onOpenChange={(open) => !open && close()}
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
      onConfirm={onSendEmail}
      contentOptions={{
        ["data-testid" as string]: "change-password-modal",
      }}
    >
      <Input label={t["com.myoxus.settings.email"]()} disabled value={email} />
    </ConfirmModal>
  );
};
