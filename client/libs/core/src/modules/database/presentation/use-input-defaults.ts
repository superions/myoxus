// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AssistantInputFragmentFragment as AssistantInputFragment,
  type AssistantPackageFragmentFragment as AssistantPackageFragment,
  type AssistantValueFragmentFragment as AssistantValueFragment,
} from "@myoxus/graphql";
import { useEffect, useRef } from "react";
import { resolvedAssistantValue, visibleAssistantAnswers } from "./values";

/** Defaults initialize one native form scope. They never overwrite later local
 * edits when a newer package is read or leak a hidden/default identity value
 * into another destination. */
export function useAssistantInputDefaults(
  descriptor: AssistantPackageFragment | null | undefined,
  scope: string,
  apply: (input: AssistantInputFragment, value: AssistantValueFragment) => void,
) {
  const applied = useRef<string | null>(null);
  const latest = useRef(apply);
  latest.current = apply;
  useEffect(() => {
    if (!descriptor) return;
    const key = scope;
    if (applied.current === key) return;
    applied.current = key;
    const defaults = visibleAssistantAnswers(descriptor, {}, true);
    for (const input of descriptor.inputs) {
      const value = resolvedAssistantValue(input, defaults);
      if (value) latest.current(input, value);
    }
  }, [descriptor, scope]);
}
