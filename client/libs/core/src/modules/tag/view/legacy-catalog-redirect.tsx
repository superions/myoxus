// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useService } from "@myoxus/infra";
import { Loading } from "@myoxus/ui-facade";
import { useEffect } from "react";

export const Component = () => {
  const workbench = useService(WorkbenchService).workbench;
  useEffect(() => {
    workbench.open("/tags", { at: "active", replaceHistory: true });
  }, [workbench]);
  return <Loading />;
};
