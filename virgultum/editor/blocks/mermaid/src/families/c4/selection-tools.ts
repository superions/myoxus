// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { c4BoundaryHiddenBy } from "./boundary-projection.js";
import { c4NodeGfxData } from "./object-data.js";
import { isC4ElementKind } from "../../engine/c4/index.js";
import { mermaidMessages as m } from "../../i18n.js";

/** Direct and Box selection share real Source identities. Boundary membership
 * is the projected Source membership, never a containment/overlap query. */
export const c4PageSelectionTools: MermaidPageSelectionToolsContribution = {
  selectableKinds: ["node", "edge", "subgraph"],
  boxSelectableKinds: ["node"],
  selectAllKinds: ["node"],
  operations: {
    moveSelection: true,
    deleteSelection: true,
    duplicateSelection: false,
  },
  resolveItems: (model) => [
    ...model.nodes.map((n) => ({
      editKey: n.id,
      kind: "node" as const,
      boxSelectable: !c4BoundaryHiddenBy(model, n.id),
      selectAllSelectable: !c4BoundaryHiddenBy(model, n.id),
    })),
    ...model.edges.map((e) => ({ editKey: e.id, kind: "edge" as const })),
    ...(model.subgraphs ?? []).map((g) => ({
      editKey: g.id,
      kind: "subgraph" as const,
    })),
  ],
  containerAction: {
    id: "c4.group",
    label: () => m.c4Group(),
    minimumSelectionCount: 2,
    eligibleKinds: ["node"],
    validationMessage: () => m.c4GroupSelection(),
    validate: ({ items, visualModel }) => {
      if (
        items.length < 2 ||
        new Set(items.map((i) => i.editKey)).size !== items.length ||
        items.some(
          (i) =>
            i.kind !== "node" ||
            !isC4ElementKind(
              c4NodeGfxData(
                visualModel.nodes.find((n) => n.id === i.editKey) ?? {},
              )?.kind ?? "",
            ),
        )
      )
        return { valid: false, code: "c4.group" };
      const parents = items.map((i) =>
        (visualModel.subgraphs ?? [])
          .filter((g) => g.nodeIds.includes(i.editKey))
          .map((g) => g.id),
      );
      return parents.every((p) => p.length <= 1) &&
        new Set(parents.map((p) => p[0] ?? null)).size === 1
        ? { valid: true }
        : { valid: false, code: "c4.group" };
    },
  },
};
