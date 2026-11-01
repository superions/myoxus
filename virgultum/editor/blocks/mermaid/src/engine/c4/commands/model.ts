// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../model.js";

export function cloneC4Model(model: MermaidC4Model) {
  // Keep non-finite handler results intact so diagnostics retain the real DB value.
  return structuredClone(model);
}

export type C4CommandResult = {
  status: "changed" | "unchanged" | "invalid";
  source: string;
  model: MermaidC4Model;
  bindings: { previous: MermaidC4Model["sourceDocument"] };
  selection?: string;
  diagnostic?: string;
  /** Only explicit Source layout/move commands request packing of these stable parent scopes. */
  reflowScopes?: readonly (string | null)[];
  /** Explicit config changes ask the renderer to measure new content before packing. */
  measureContent?: boolean;
  /** A newly created Source boundary encloses exactly these retained live objects. */
  boundaryFromSelection?: readonly string[];
};
export function c4CommandResult(
  model: MermaidC4Model,
  next: { source: string; model: MermaidC4Model },
  selection?: string,
): C4CommandResult {
  return {
    ...next,
    bindings: { previous: next.model.sourceDocument },
    status:
      model.sourceDocument.source === next.source ? "unchanged" : "changed",
    selection,
  };
}
export function c4NoChange(
  model: MermaidC4Model,
  diagnostic?: string,
): C4CommandResult {
  return {
    source: model.sourceDocument.source,
    model,
    bindings: { previous: model.sourceDocument },
    status: diagnostic ? "invalid" : "unchanged",
    diagnostic,
  };
}
