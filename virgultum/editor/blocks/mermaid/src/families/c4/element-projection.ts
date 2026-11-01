// SPDX-License-Identifier: AGPL-3.0-or-later

import { C4_CALLS } from "../../engine/c4/runtime-contract.js";
import { c4ResolvedElementShape } from "../../engine/c4/resolve.js";
import type { MermaidC4Element } from "../../engine/c4/model.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";

/** Metadata remains in local fields; cards show the authored label and C4 identity. */
export function c4ElementDisplayLabel(element: {
  label: string;
  kind: string;
  technology: string;
  description: string;
}) {
  return [
    element.label,
    `[${c4StereotypeLabel(element.kind)}${element.technology ? `: ${element.technology}` : ""}]`,
    element.description,
  ]
    .filter(Boolean)
    .join("\n");
}
export function c4ElementVisualShape(
  element: Pick<MermaidC4Element, "kind" | "sprite" | "tags" | "resolution">,
): MermaidVisualNode["shape"] {
  const shape = c4ResolvedElementShape(element);
  return shape === "cylinder" ? "database" : shape;
}

export function c4ElementCallFields(kind: string) {
  const contract = C4_CALLS[kind];
  return contract?.category === "element" ? contract.slots : [];
}

/** Native C4 stereotypes describe body kind; Db/Queue and External use their
 * native shape/palette distinctions instead of leaking declaration spellings. */
export function c4StereotypeLabel(kind: string) {
  if (kind.startsWith("Person")) return "Person";
  if (kind.startsWith("System")) return "Software System";
  if (kind.startsWith("Container")) return "Container";
  if (kind.startsWith("Component")) return "Component";
  return kind;
}
