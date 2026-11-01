// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Argument } from "./model.js";
import { C4_CALLS, isC4ElementKind } from "./runtime-contract.js";
import { C4WriteError } from "./patches.js";

/** Kind changes move receiving slots, never reinterpret Technology as Description.
 * Named keys retain their exact spelling and receiving slot; lost slots need an explicit intent. */
export function remapC4ElementArguments(
  from: string,
  to: string,
  args: readonly MermaidC4Argument[],
) {
  if (!isC4ElementKind(from) || !isC4ElementKind(to))
    throw new C4WriteError("Unknown C4 element kind");
  const old = C4_CALLS[from].slots,
    next = C4_CALLS[to].slots;
  const result: MermaidC4Argument[] = [],
    lost: { field: string; index: number; argument: MermaidC4Argument }[] = [];
  args.forEach((argument, index) => {
    const target =
      index >= old.length
        ? next.length + index - old.length
        : next.indexOf(old[index]);
    if (target < 0) {
      if (argument.value || argument.key || argument.named)
        lost.push({ field: old[index], index, argument: { ...argument } });
      return;
    }
    while (result.length <= target) result.push({ key: "", value: "" });
    result[target] = { ...argument };
  });
  return { arguments: result, lost };
}
