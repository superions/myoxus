// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  DialogComponentProps,
  GLOBAL_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";

import { CurrentServerScopeProvider } from "../../../components/providers/current-server-scope";
import { ImportWorkspaceDialog } from ".";

/** Keeps workspace import mutations scoped to the server that owns the workspace. */
export const CurrentServerImportWorkspaceDialog = (
  props: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["import-workspace"]>,
) => (
  <CurrentServerScopeProvider>
    <ImportWorkspaceDialog {...props} />
  </CurrentServerScopeProvider>
);
