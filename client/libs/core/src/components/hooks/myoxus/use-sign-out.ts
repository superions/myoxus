import { AuthService, DefaultServerService } from "@myoxus/core/modules/server";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { UserFriendlyError } from "@myoxus/error";
import { ServerFeature } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService, useServiceOptional, useServices } from "@myoxus/infra";
import {
  type ConfirmModalProps,
  notify,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

import { useNavigateHelper } from "../use-navigate-helper";

type SignOutConfirmModalI18NKeys =
  "title" | "description" | "cancel" | "confirm";

export const useSignOut = ({
  onConfirm,
  confirmButtonOptions,
  contentOptions,
  ...props
}: ConfirmModalProps = {}) => {
  const t = useI18n();
  const { openConfirmModal } = useConfirmModal();
  const { jumpToSignIn, jumpToIndex } = useNavigateHelper();

  const authService = useService(AuthService);
  const workbench = useServiceOptional(WorkbenchService)?.workbench;
  const { defaultServerService } = useServices({ DefaultServerService });

  const signOut = useCallback(async () => {
    const enableLocalWorkspace =
      canUseLocalWorkspaces() &&
      (BUILD_CONFIG.isNative ||
        defaultServerService.server.config$.value.features.includes(
          ServerFeature.LocalWorkspace,
        ));

    try {
      // Authentication invalidation may release the workspace and its storage.
      // Obtain the existing pane/dialog decisions while saving is still allowed,
      // rather than relying on a later router blocker or scope disposal.
      if (workbench && !(await workbench.requestCloseGuards())) return;
      await onConfirm?.();
      // An awaited caller can open another session; do not sign it out without
      // admitting its close too. With no new participant this stays synchronous.
      if (workbench && !(await workbench.requestCloseGuards())) return;
      await authService.signOut();
      if (enableLocalWorkspace) {
        jumpToIndex();
      } else {
        jumpToSignIn();
      }
    } catch (err) {
      console.error(err);
      const error = UserFriendlyError.fromAny(err);
      notify.error(error);
    }
  }, [
    authService,
    jumpToIndex,
    jumpToSignIn,
    defaultServerService,
    onConfirm,
    workbench,
  ]);

  const getDefaultText = useCallback(
    (key: SignOutConfirmModalI18NKeys) => {
      return t[`com.myoxus.auth.sign-out.confirm-modal.${key}`]();
    },
    [t],
  );

  const confirmSignOut = useCallback(() => {
    openConfirmModal({
      title: getDefaultText("title"),
      description: getDefaultText("description"),
      cancelText: getDefaultText("cancel"),
      confirmText: getDefaultText("confirm"),
      confirmButtonOptions: {
        ...confirmButtonOptions,
        variant: "error",
        ["data-testid" as string]: "confirm-sign-out-button",
      },
      contentOptions: {
        ...contentOptions,
        ["data-testid" as string]: "confirm-sign-out-modal",
      },
      onConfirm: signOut,
      ...props,
    });
  }, [
    confirmButtonOptions,
    contentOptions,
    getDefaultText,
    openConfirmModal,
    props,
    signOut,
  ]);

  return confirmSignOut;
};
