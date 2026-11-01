// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ClassMarker,
  MermaidClassRelation,
} from "../../engine/class/index.js";
import type {
  MermaidVisualEdge,
  MermaidVisualEndpointMarker,
} from "../runtime/gfx-model.js";
import { classEdgeFamilyData } from "./gfx-data.js";
const markers: Record<ClassMarker, MermaidVisualEndpointMarker> = {
  none: "none",
  arrow: "arrow",
  inheritance: "hollow-triangle",
  aggregation: "hollow-diamond",
  composition: "diamond",
  lollipop: "hollow-circle",
};
export function classRelationProjection(
  relation: MermaidClassRelation,
  ids: ReadonlyMap<string, string>,
  siblings: readonly MermaidClassRelation[] = [relation],
): MermaidVisualEdge {
  const parallels = siblings.filter(
    (other) =>
      (other.from === relation.from && other.to === relation.to) ||
      (other.from === relation.to && other.to === relation.from),
  );
  const index = parallels.findIndex(
    (other) => other.sourceKey === relation.sourceKey,
  );
  const port = (index + 1) / (parallels.length + 1);
  const loop = relation.from === relation.to;
  const forward = relation.from.localeCompare(relation.to) <= 0;
  return {
    id: relation.sourceKey,
    source: ids.get(relation.from)!,
    target: ids.get(relation.to)!,
    label: relation.label,
    displayLabel: relation.label,
    labelEditable: false,
    labelPlacement: "top",
    sourceMarker: markers[relation.fromMarker],
    targetMarker: markers[relation.toMarker],
    style: relation.lineStyle === "dashed" ? "dotted" : "solid",
    connectorMode: loop ? "curve" : "straight",
    sourcePosition: loop
      ? [1, port / 2]
      : parallels.length > 1
        ? [forward ? 1 : 0, port]
        : undefined,
    targetPosition: loop
      ? [1, 0.5 + port / 2]
      : parallels.length > 1
        ? [forward ? 0 : 1, port]
        : undefined,
    endpointLabels: {
      source: relation.fromCardinality,
      target: relation.toCardinality,
    },
    familyData: classEdgeFamilyData({
      fromCardinality: relation.fromCardinality,
      toCardinality: relation.toCardinality,
      relationKind: relation.kind,
      noteLink: false,
    }),
  };
}
