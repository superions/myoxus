// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type TemplateApplicationAction,
  TemplateApplicationService,
} from "../services/template-application";
import type { InstantiateTemplateOptions } from "../services/template-instantiation";

/** Return focus after React restores the invoking control, without timers or DOM lookup. */
export function useTemplateApplicationAction(
  action: Exclude<TemplateApplicationAction, "journal">,
  targetDocId?: string,
  sourceDocId?: string,
  callerPending = false,
) {
  const service = useService(TemplateApplicationService);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const key = targetDocId
    ? TemplateApplicationService.targetKey(targetDocId)
    : TemplateApplicationService.creationKey(action, sourceDocId);
  const pending = useLiveData(
    useMemo(
      () => service.pending$.selector((keys) => keys.has(key)),
      [key, service],
    ),
  );
  useEffect(() => {
    // The caller can keep its trigger disabled beyond the native service flight.
    // Preserve the focus request until that control is enabled in React too.
    if (!pending && !callerPending && restoreFocus) {
      triggerRef.current?.focus();
      setRestoreFocus(false);
    }
  }, [callerPending, pending, restoreFocus]);
  const apply = useCallback(
    async (sourceId: string, options: InstantiateTemplateOptions) => {
      const result = await service.apply(sourceId, options, action);
      if (
        !result.ok &&
        result.reason !== "busy" &&
        result.reason !== "rollback-failed"
      )
        setRestoreFocus(true);
      return result;
    },
    [action, service],
  );
  return { apply, pending, triggerRef };
}
