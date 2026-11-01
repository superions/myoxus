// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type GLOBAL_DIALOG_SCHEMA,
  GlobalDialogService,
} from "@myoxus/core/modules/dialogs";
import { useLiveData, useService } from "@myoxus/infra";
import {
  type ComponentType,
  lazy,
  type LazyExoticComponent,
  Suspense,
} from "react";

type GlobalDialogComponent = ComponentType<any>;

const GLOBAL_DIALOGS = {
  "create-workspace": lazy(async () => {
    const { CreateWorkspaceDialog } = await import("./create-workspace");
    return { default: CreateWorkspaceDialog };
  }),
  "import-workspace": lazy(async () => {
    const { CurrentServerImportWorkspaceDialog } =
      await import("./import-workspace/current-server-dialog");
    return { default: CurrentServerImportWorkspaceDialog };
  }),
  "import-template": lazy(async () => {
    const { ImportTemplateDialog } = await import("./import-template");
    return { default: ImportTemplateDialog };
  }),
  "sign-in": lazy(async () => {
    const { SignInDialog } = await import("./sign-in");
    return { default: SignInDialog };
  }),
  "change-password": lazy(async () => {
    const { ChangePasswordDialog } = await import("./change-password");
    return { default: ChangePasswordDialog };
  }),
  "verify-email": lazy(async () => {
    const { VerifyEmailDialog } = await import("./verify-email");
    return { default: VerifyEmailDialog };
  }),
  "enable-cloud": lazy(async () => {
    const { EnableCloudDialog } = await import("./enable-cloud");
    return { default: EnableCloudDialog };
  }),
  "deleted-account": lazy(async () => {
    const { DeletedAccountDialog } = await import("./deleted-account");
    return { default: DeletedAccountDialog };
  }),
} satisfies Partial<
  Record<keyof GLOBAL_DIALOG_SCHEMA, LazyExoticComponent<ComponentType<any>>>
>;

/**
 * Renders application-scoped dialogs without placing their implementations in
 * the shell bundle. A dialog chunk is requested only after that dialog opens.
 */
export const GlobalDialogs = () => {
  const globalDialogService = useService(GlobalDialogService);
  const dialogs = useLiveData(globalDialogService.dialogs$);

  return (
    <>
      {dialogs.map((dialog) => {
        const DialogComponent = GLOBAL_DIALOGS[
          dialog.type as keyof typeof GLOBAL_DIALOGS
        ] as GlobalDialogComponent | undefined;
        if (!DialogComponent) {
          return null;
        }

        return (
          <Suspense key={dialog.id} fallback={null}>
            <DialogComponent
              {...(dialog.props as any)}
              close={(result?: unknown) => {
                globalDialogService.close(dialog.id, result);
              }}
            />
          </Suspense>
        );
      })}
    </>
  );
};
