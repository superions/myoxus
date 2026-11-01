import { SignInPanel, type SignInStep } from "@myoxus/core/components/sign-in";
import type {
  DialogComponentProps,
  GLOBAL_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import type { AuthSessionStatus } from "@myoxus/core/modules/server/entities/session";
import { Modal } from "@myoxus/ui-facade";
import { useCallback } from "react";

import {
  AUTH_DIALOG_BODY_PADDING,
  AUTH_DIALOG_WIDTH,
  AUTH_SIGN_IN_DIALOG_MAX_HEIGHT,
  AUTH_SIGN_IN_DIALOG_MIN_HEIGHT,
} from "../auth-dialog-layout";

export const SignInDialog = ({
  close,
  server: initialServerBaseUrl,
  step,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["sign-in"]>) => {
  const onAuthenticated = useCallback(
    (status: AuthSessionStatus) => {
      if (status === "authenticated") {
        close();
      }
    },
    [close],
  );
  return (
    <Modal
      open
      persistent
      onOpenChange={() => close()}
      width={AUTH_DIALOG_WIDTH}
      minHeight={AUTH_SIGN_IN_DIALOG_MIN_HEIGHT}
      maxHeight={AUTH_SIGN_IN_DIALOG_MAX_HEIGHT}
      contentOptions={{
        ["data-testid" as string]: "auth-modal",
        bodyPadding: AUTH_DIALOG_BODY_PADDING,
      }}
    >
      <SignInPanel
        onSkip={close}
        onAuthenticated={onAuthenticated}
        server={initialServerBaseUrl}
        initStep={step as SignInStep}
      />
    </Modal>
  );
};
