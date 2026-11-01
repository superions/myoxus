// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useService } from "@myoxus/infra";
import { Loading } from "@myoxus/ui-facade";
import { useEffect } from "react";

/**
 * Canonicalizes an unqualified workspace route through Workbench history.
 *
 * React Router's nested memory router is not the browser-history authority;
 * using the Workbench replacement preserves split-view and adapter invariants
 * while ensuring `/workspace/:id` never falls through as a document ID.
 */
export const Component = () => {
  const workbench = useService(WorkbenchService).workbench;
  useEffect(() => {
    workbench.open("/home", {
      at: "active",
      replaceHistory: true,
    });
  }, [workbench]);
  return <Loading />;
};
