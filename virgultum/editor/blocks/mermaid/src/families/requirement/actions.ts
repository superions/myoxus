// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  deleteRequirementSelection,
  addRequirementObject,
  addRequirementRelation,
  editRequirementRelation,
  requirementNoChange,
  editRequirementFields,
  renameRequirementAlias,
  editRequirementTypography,
  editRequirementDirection,
  copyRequirementSelection,
  pasteRequirementSelection,
  editRequirementComment,
  editRequirementDiagramTitle,
  editRequirementAccessibility,
  type MermaidRequirementModel,
  type RequirementCommandResult,
} from "../../engine/requirement/index.js";
import { mermaidMessages as m } from "../../i18n.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import type { MermaidGfxConnectionProposal } from "../runtime/editor-capabilities.js";
import {
  readRequirementProjectionModel,
  reconcileRequirementProjection,
} from "./readback.js";
import { requirementModelToGfxVisualModel } from "./visual-model.js";
import type { RequirementReactHostProps } from "./react-host-contract.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { layoutRequirementGraph, requirementCardMetrics } from "./layout.js";
import { routeRequirementRelations } from "./relation-projection.js";
import { requirementNodeGfxData } from "./gfx-data.js";
import { measuredMermaidEdgeRouting } from "../runtime/graph-ports.js";
import { mermaidGfxTypographyForNode } from "../../mermaid-gfx-theme.js";

export function createRequirementDiagramConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onDiagramSettings"] {
  return (direction, layout, basis, accessibility) => {
    if (port.getReadonly() || port.getSource() !== basis)
      return { changed: false, diagnostic: m.mmdImportInvalid() };
    const stored = port.getVisualModel(),
      model = readRequirementProjectionModel(basis, stored);
    if (!model) return { changed: false, diagnostic: m.mmdImportInvalid() };
    const directed = editRequirementDirection(model, direction, {
      baseSource: basis,
    });
    if (directed.status === "rejected")
      return { changed: false, diagnostic: m.mmdImportInvalid() };
    const edited = accessibility
      ? editRequirementAccessibility(directed.model, accessibility, {
          baseSource: directed.source,
        })
      : directed;
    const result =
      edited.changed || edited.status === "rejected" ? edited : directed;
    if (result.status === "rejected")
      return { changed: false, diagnostic: m.mmdImportInvalid() };
    const visual = reconcileRequirementProjection(
      requirementModelToGfxVisualModel(result.model),
      stored,
    );
    const next = layout ? layoutRequirementGraph(visual) : visual;
    const geometryChanged = next.nodes.some((node) => {
      const old = stored.nodes.find((old) => old.id === node.id);
      return (
        !old ||
        Math.abs(node.x - old.x) > 1e-6 ||
        Math.abs(node.y - old.y) > 1e-6
      );
    });
    const portsChanged = next.edges.some((edge) => {
      const old = stored.edges.find((old) => old.id === edge.id);
      return (
        JSON.stringify([
          edge.sourcePosition,
          edge.targetPosition,
          edge.labelPlacement,
        ]) !==
        JSON.stringify([
          old?.sourcePosition,
          old?.targetPosition,
          old?.labelPlacement,
        ])
      );
    });
    if (!result.changed && !geometryChanged && !portsChanged)
      return { changed: false };
    const committed = port.applyVisualModel(next, {
      preserveSourceBytes: true,
      ...(result.changed
        ? { sourceWrite: { baseSource: basis, source: result.source } }
        : {}),
    });
    return {
      changed: committed.applied,
      diagnostic: committed.applied
        ? undefined
        : (committed.diagnostic ?? m.mmdImportInvalid()),
    };
  };
}

export const requirementPageSelectionTools: MermaidPageSelectionToolsContribution =
  {
    boxSelectableKinds: ["node"],
    selectableKinds: ["node", "edge"],
    selectAllKinds: ["node"],
    operations: {
      deleteSelection: true,
      duplicateSelection: true,
      moveSelection: true,
    },
    resolveItems: (visual) => [
      ...visual.nodes.map((node) => ({
        editKey: node.id,
        kind: "node" as const,
      })),
      ...visual.edges.map((edge) => ({
        editKey: edge.id,
        kind: "edge" as const,
      })),
    ],
  };

export type RequirementCommandPort = {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidGfxActionContext["visualModel"];
  applyVisualModel: MermaidGfxActionContext["applyVisualModel"];
  selectAfterProjection: MermaidGfxActionContext["selectAfterProjection"];
  selectManyAfterProjection?: MermaidGfxActionContext["selectManyAfterProjection"];
  getSelectedItems?: () => readonly {
    kind: "node" | "edge";
    editKey: string;
  }[];
  /** Native selectors can retain deleted IDs until explicitly cleared. */
  clearSelection?: () => void;
};
export function createRequirementTitleConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onTitle"] {
  return (title, basis) =>
    consumeRequirementCommand(port, basis, (model) =>
      editRequirementDiagramTitle(model, title, { baseSource: basis }),
    );
}
export function createRequirementCommentConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onComment"] {
  return (command, basis) =>
    consumeRequirementCommand(port, basis, (model) =>
      editRequirementComment(model, command, { baseSource: basis }),
    );
}

/** Clipboard and Duplicate share one checked Source/geometry/history commit.
 * Place the entire fragment below existing cards; never relay out neighbours. */
export function createRequirementPasteConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onPaste"] {
  return (fragment, basis, geometry = []) => {
    if (port.getReadonly() || port.getSource() !== basis)
      return { changed: false };
    const stored = port.getVisualModel(),
      model = readRequirementProjectionModel(basis, stored);
    if (!model) return { changed: false };
    const result = pasteRequirementSelection(model, fragment, {
      baseSource: basis,
    });
    if (!result.changed)
      return { changed: false, diagnostic: m.mmdImportInvalid() };
    const visual = reconcileRequirementProjection(
      requirementModelToGfxVisualModel(result.model),
      stored,
    );
    const copies = visual.nodes.filter((node) =>
      result.copiedKeys.includes(requirementNodeGfxData(node)?.sourceKey ?? ""),
    );
    const baseline = Math.max(
      0,
      ...stored.nodes.map((node) => node.y + node.height),
    );
    // A non-overlapping card is not enough: copied parallel lanes also need
    // their measured routing clearance outside the original graph's obstacles.
    const typography = mermaidGfxTypographyForNode({});
    const gap =
      typography.lineHeight +
      2 *
        Math.max(
          0,
          ...visual.edges.map(
            (edge) =>
              measuredMermaidEdgeRouting(visual, edge, typography)
                .routingClearance ?? 0,
          ),
        );
    const left = Math.min(
      ...geometry.map((node) => node.x),
      ...copies.map((node) => node.x),
    );
    const top = Math.min(
      ...(geometry.length ? geometry : copies).map((node) => node.y),
    );
    copies.forEach((node, index) => {
      const original = geometry[index];
      if (original)
        Object.assign(node, {
          x: original.x - left,
          y: original.y - top + baseline + gap,
          width: Math.max(node.width, original.width),
          height: Math.max(node.height, original.height),
        });
      else node.y += baseline + gap - top;
    });
    for (const node of visual.nodes) {
      const original = stored.nodes.find((original) => original.id === node.id);
      if (original)
        Object.assign(node, {
          x: original.x,
          y: original.y,
          width: original.width,
          height: original.height,
        });
    }
    const after = copies.map((node) => ({
      kind: "node" as const,
      editKey: node.id,
    }));
    const applied = port.applyVisualModel(routeRequirementRelations(visual), {
      preserveSourceBytes: true,
      sourceWrite: { baseSource: basis, source: result.source },
      selectionHistory: { before: port.getSelectedItems?.() ?? [], after },
    });
    if (applied.applied) port.selectManyAfterProjection?.(after);
    return { changed: applied.applied, diagnostic: applied.diagnostic };
  };
}
export function createRequirementDuplicateConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onDuplicate"] {
  return (keys, basis) => {
    const visual = port.getVisualModel(),
      model = readRequirementProjectionModel(basis, visual);
    const fragment = model && copyRequirementSelection(model, keys);
    if (!fragment) return { changed: false };
    const geometry = [...model!.requirements, ...model!.elements]
      .filter((object) => keys.includes(object.sourceKey ?? ""))
      .flatMap(
        (object) => visual.nodes.find((node) => node.id === object.id) ?? [],
      );
    return createRequirementPasteConsumer(port)(fragment, basis, geometry);
  };
}
export function createRequirementRelationConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onSaveRelation"] {
  return (draft, basis, proposal) =>
    consumeRequirementCommand(
      port,
      basis,
      (model) => requirementRelationCandidate(model, draft, basis, proposal),
      undefined,
      m.visualConnectionInvalidTarget,
      proposal,
    );
}
export function createRequirementRelationPreview(
  port: RequirementCommandPort,
  preview?: MermaidGfxActionContext["previewVisualModel"],
): RequirementReactHostProps["previewRelation"] {
  return (draft, basis, proposal) => {
    if (!preview || port.getReadonly() || port.getSource() !== basis)
      return null;
    const stored = port.getVisualModel(),
      model = readRequirementProjectionModel(basis, stored);
    if (!model) return null;
    const result = requirementRelationCandidate(model, draft, basis, proposal);
    if (
      result.status === "rejected" ||
      (!result.changed && !proposal?.endpoint)
    )
      return null;
    const visual = reconcileRequirementProjection(
      requirementModelToGfxVisualModel(result.model),
      stored,
    );
    projectConnectionPorts(
      visual,
      result.selection ?? proposal?.edgeId,
      proposal,
      stored,
    );
    return preview(visual, {
      scopeToViewport: true,
      includeInNavigation: true,
    });
  };
}
function requirementRelationCandidate(
  model: MermaidRequirementModel,
  draft: Parameters<RequirementReactHostProps["onSaveRelation"]>[0],
  basis: string,
  proposal?: MermaidGfxConnectionProposal,
) {
  if (!proposal?.edgeId)
    return addRequirementRelation(model, draft, { baseSource: basis });
  const relation = model.relations.find(
    (relation) => relation.id === proposal.edgeId,
  );
  return relation?.sourceKey
    ? editRequirementRelation(model, relation.sourceKey, draft, {
        baseSource: basis,
      })
    : requirementNoChange(model, "invalid");
}
function projectConnectionPorts(
  visual: MermaidGfxActionContext["visualModel"],
  selection?: string,
  proposal?: MermaidGfxConnectionProposal,
  stored?: MermaidGfxActionContext["visualModel"],
) {
  const edge = visual.edges.find((edge) => edge.id === selection);
  if (!edge || !proposal) return;
  const previous = stored?.edges.find((previous) => previous.id === edge.id);
  for (const endpoint of ["source", "target"] as const)
    if (proposal.edgeId && previous && edge[endpoint] !== previous[endpoint]) {
      if (endpoint === "source") {
        edge.sourcePortId = undefined;
        edge.sourcePosition = undefined;
      } else {
        edge.targetPortId = undefined;
        edge.targetPosition = undefined;
      }
    }
  if (
    edge.source === proposal.sourceNodeId &&
    (!proposal.edgeId || proposal.endpoint === "source")
  ) {
    edge.sourcePortId = proposal.sourcePortId;
    edge.sourcePosition = proposal.sourcePosition;
  }
  if (
    edge.target === proposal.targetNodeId &&
    (!proposal.edgeId || proposal.endpoint === "target")
  ) {
    edge.targetPortId = proposal.targetPortId;
    edge.targetPosition = proposal.targetPosition;
  }
  visual.edges = routeRequirementRelations(visual).edges;
}
export function createRequirementFieldConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onSave"] {
  return (key, values, basis, typography, references, removeProperties) =>
    consumeRequirementCommand(
      port,
      basis,
      (model) => {
        const { name, ...otherValues } = values;
        const renamed =
          name === undefined
            ? requirementNoChange(model)
            : renameRequirementAlias(model, key, name, references, {
                baseSource: basis,
              });
        if (renamed.status === "rejected") return renamed;
        const edited = editRequirementFields(renamed.model, key, otherValues, {
          baseSource: renamed.source,
          removeProperties,
        });
        const fields =
          edited.changed || edited.status === "rejected" ? edited : renamed;
        if (
          fields.status === "rejected" ||
          !typography ||
          !Object.keys(typography).length
        )
          return fields;
        const formatted = editRequirementTypography(
          fields.model,
          key,
          typography,
          { baseSource: fields.source },
        );
        return formatted.changed || formatted.status === "rejected"
          ? formatted
          : fields;
      },
      undefined,
      undefined,
      undefined,
      Boolean(typography && Object.keys(typography).length),
    );
}
export function createRequirementDeleteConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onDelete"] {
  return (keys, basis, references, confirmed) => {
    let before: { kind: "node" | "edge"; editKey: string }[] = [];
    const result = consumeRequirementCommand(
      {
        ...port,
        applyVisualModel: (visual, options) =>
          port.applyVisualModel(visual, {
            ...options,
            selectionHistory: { before, after: [] },
          }),
      },
      basis,
      (model) => {
        before = [...model.requirements, ...model.elements, ...model.relations]
          .filter((object) => keys.includes(object.sourceKey ?? ""))
          .map((object) => ({
            kind: "from" in object ? "edge" : "node",
            editKey: object.id,
          }));
        const result = deleteRequirementSelection(model, keys, {
          baseSource: basis,
          references,
          confirmed,
        });
        // Deletion clears the selection; Undo restores these semantic records on
        // the existing document entry, not an arbitrary surviving card.
        return { ...result, selection: undefined };
      },
    );
    if (result.changed) port.clearSelection?.();
    return result;
  };
}
export function createRequirementObjectConsumer(
  port: RequirementCommandPort,
): RequirementReactHostProps["onCreate"] {
  return (kind, name, basis, placement) =>
    consumeRequirementCommand(
      port,
      basis,
      (model) => addRequirementObject(model, kind, name, { baseSource: basis }),
      placement,
      m.requirementAliasUnavailable,
    );
}
function consumeRequirementCommand(
  port: RequirementCommandPort,
  basis: string,
  command: (model: MermaidRequirementModel) => RequirementCommandResult,
  placement?: { centerX: number; centerY: number },
  rejected = m.mmdImportInvalid,
  connection?: MermaidGfxConnectionProposal,
  preserveNeighbours = false,
) {
  const current = port.getSource();
  const reject = () => ({ changed: false, diagnostic: m.mmdImportInvalid() });
  if (port.getReadonly() || current !== basis) return reject();
  const stored = port.getVisualModel();
  const model = readRequirementProjectionModel(current, stored);
  if (!model) return reject();
  const result = command(model);
  if (result.status === "rejected")
    return { changed: false, diagnostic: rejected() };
  if (!result.changed && !connection?.edgeId) return { changed: false };
  const visual = reconcileRequirementProjection(
    requirementModelToGfxVisualModel(result.model),
    stored,
  );
  if (preserveNeighbours && result.selection) {
    // Formatting owns only the selected card. Keep neighbours fixed even when
    // its measured growth requires finding a new free position for that card.
    for (const node of visual.nodes) {
      if (node.id === result.selection) continue;
      const before = stored.nodes.find((before) => before.id === node.id);
      if (before)
        Object.assign(node, {
          x: before.x,
          y: before.y,
          width: before.width,
          height: before.height,
        });
    }
    const selected = visual.nodes.find((node) => node.id === result.selection);
    if (selected)
      for (;;) {
        const collision = visual.nodes.find(
          (other) =>
            other !== selected &&
            selected.x < other.x + other.width &&
            selected.x + selected.width > other.x &&
            selected.y < other.y + other.height &&
            selected.y + selected.height > other.y,
        );
        if (!collision) break;
        selected.y =
          collision.y +
          collision.height +
          requirementCardMetrics(selected).typography.lineHeight;
      }
  }
  if (placement && result.selection) {
    const node = visual.nodes.find((node) => node.id === result.selection);
    if (node) {
      node.x = placement.centerX - node.width / 2;
      node.y = placement.centerY - node.height / 2;
    }
  }
  projectConnectionPorts(
    visual,
    result.selection ?? connection?.edgeId,
    connection,
    stored,
  );
  if (!result.changed) {
    const next = visual.edges.find((edge) => edge.id === connection?.edgeId),
      before = stored.edges.find((edge) => edge.id === connection?.edgeId);
    const ports = (edge: typeof next) => [
      edge?.source,
      edge?.target,
      edge?.sourcePortId,
      edge?.targetPortId,
      edge?.sourcePosition,
      edge?.targetPosition,
    ];
    if (JSON.stringify(ports(next)) === JSON.stringify(ports(before)))
      return { changed: false };
  }
  const committed = port.applyVisualModel(visual, {
    preserveSourceBytes: true,
    sourceWrite: { baseSource: current, source: result.source },
    ...(connection?.edgeId
      ? {
          selectionHistory: {
            before: [{ kind: "edge" as const, editKey: connection.edgeId }],
            after: [{ kind: "edge" as const, editKey: connection.edgeId }],
          },
        }
      : {}),
  });
  if (!committed.applied)
    return {
      changed: false,
      diagnostic: committed.diagnostic ?? m.mmdImportInvalid(),
    };
  const selection = result.selection ?? connection?.edgeId;
  if (selection)
    port.selectAfterProjection(
      {
        editKey: selection,
        kind: visual.nodes.some((n) => n.id === selection) ? "node" : "edge",
      },
      connection?.edgeId ? { focus: true } : undefined,
    );
  return {
    changed: true,
    sourceBasis: result.source,
    selection: result.selection,
  };
}
