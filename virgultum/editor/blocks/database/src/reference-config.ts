// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfigExtensionFactory } from "@virgultum/std";

import type { DatabaseReferenceViewExtensionOptions } from "./reference-view";

/** Runtime bridge for the server-backed reference renderer only. */
export const DatabaseReferenceConfigExtension =
  ConfigExtensionFactory<DatabaseReferenceViewExtensionOptions>(
    "myoxus:database:reference",
  );
