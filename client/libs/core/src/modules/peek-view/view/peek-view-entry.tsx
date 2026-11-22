// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLiveData, useService } from "@myoxus/infra";
import { lazy, Suspense, useEffect, useState } from "react";
import { PeekViewService } from "../services/peek-view";

const Manager = lazy(async () => ({
  default: (await import("./peek-view-manager")).PeekViewManagerModal,
}));
export function PeekViewManagerModal() {
  const active = useLiveData(useService(PeekViewService).peekView.active$);
  const [mounted, setMounted] = useState(false);
  // Keep the manager after the first open so its close animation and
  // focus restoration survive clearing the active target.
  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);
  return mounted || active ? (
    <Suspense>
      <Manager />
    </Suspense>
  ) : null;
}
