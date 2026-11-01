// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  c4RelationshipLinkType,
  type MermaidC4Relationship,
} from "@virgultum/block-mermaid";

export function markerText(relationship: MermaidC4Relationship | undefined) {
  const type = relationship && c4RelationshipLinkType(relationship);
  return type === "bidirectional" ? "← →" : type === "reverse" ? "←" : "→";
}
