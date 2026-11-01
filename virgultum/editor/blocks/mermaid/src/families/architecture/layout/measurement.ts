// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mermaidArchitectureDiagramConfig,
  resolveMermaidArchitectureConfig,
  type MermaidArchitectureModel,
} from "../../../engine/architecture/index.js";
import {
  mermaidGfxShapeSize,
  mermaidGfxTypographyKey,
  resolveMermaidGfxTheme,
  type MermaidGfxTypography,
} from "../../../mermaid-gfx-theme.js";
import { visualNode } from "../../gfx-visual-model-helpers.js";
import type {
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../../runtime/gfx-model.js";
import {
  architectureNodeFamilyData,
  architectureNodeGfxData,
  architectureSubgraphFamilyData,
} from "../gfx-data.js";
import { architectureIconDisplay } from "../icon-display.js";

// Mermaid 11.17.2 derives the group icon from the Architecture padding while
// service and junction geometry use the independently configured iconSize.
const ARCHITECTURE_GROUP_ICON_PADDING_FACTOR = 0.75;

export type ArchitectureLayoutGroup = MermaidVisualSubgraph & {
  headerHeight: number;
  headerWidth: number;
  parentId: string;
};

export type ArchitectureLayoutMetrics = {
  readonly blockGap: number;
  readonly groupBlockInset: number;
  readonly groupInlineInset: number;
  readonly inlineGap: number;
};

export type ArchitectureRelationMeasurement = {
  readonly labelHeight: number;
  readonly labelWidth: number;
  readonly markerExtent: number;
  readonly portExtent: number;
};

export type ArchitectureLayoutMeasurement = {
  readonly config: ReturnType<typeof resolveMermaidArchitectureConfig>;
  readonly groups: ArchitectureLayoutGroup[];
  readonly metrics: ArchitectureLayoutMetrics;
  readonly nodes: MermaidVisualNode[];
  readonly relationMeasurements: ReadonlyMap<
    string,
    ArchitectureRelationMeasurement
  >;
  readonly typography: MermaidGfxTypography;
  readonly typographyKey: string;
};

export function architectureConfiguredTypography(
  config: ReturnType<typeof resolveMermaidArchitectureConfig>,
) {
  const { typography: projectedTypography } = resolveMermaidGfxTheme();
  const scale = config.fontSize / projectedTypography.fontSize;
  return {
    ...projectedTypography,
    fontSize: config.fontSize,
    letterSpacing: projectedTypography.letterSpacing * scale,
    lineHeight: projectedTypography.lineHeight * scale,
  };
}

export function architectureGroupMeasurement(
  label: string,
  icon: string,
  hasIcon: boolean,
  typography: MermaidGfxTypography,
  padding: number,
) {
  const iconSize = padding * ARCHITECTURE_GROUP_ICON_PADDING_FACTOR;
  const displayLabel = [hasIcon ? icon : "", label].filter(Boolean).join(" ");
  const measured = mermaidGfxShapeSize(displayLabel, typography);
  return {
    displayLabel,
    size: hasIcon
      ? {
          height: Math.max(measured.height, iconSize),
          width: Math.max(measured.width, iconSize),
        }
      : measured,
  };
}

export function architectureServiceMeasurement(
  label: string,
  icon: string,
  hasIcon: boolean,
  iconKind: "icon" | "none" | "text",
  typography: MermaidGfxTypography,
  iconSize: number,
) {
  const labelSize = mermaidGfxShapeSize(label, typography);
  return {
    details: hasIcon
      ? [
          {
            id: "architecture-icon",
            kind: "metadata" as const,
            label: icon,
            order: 0,
            sourceKey: `architecture.${iconKind}-icon`,
          },
        ]
      : undefined,
    height: (hasIcon ? iconSize : 0) + labelSize.height,
    width: Math.max(iconSize, labelSize.width),
  };
}

export function measureArchitectureLayout(model: MermaidArchitectureModel) {
  const config = resolveMermaidArchitectureConfig(
    mermaidArchitectureDiagramConfig(model),
  );
  const typography = architectureConfiguredTypography(config);
  const typographyKey = mermaidGfxTypographyKey(typography);
  const portExtent = typography.lineHeight / 2;
  const relationMeasurements = new Map(
    model.edges.map((edge) => {
      const label = edge.label
        ? mermaidGfxShapeSize(edge.label, typography)
        : { height: 0, width: 0 };
      return [
        edge.id,
        {
          labelHeight: label.height,
          labelWidth: label.width,
          markerExtent:
            typography.lineHeight *
            0.75 *
            (Number(edge.fromArrow) + Number(edge.toArrow)),
          portExtent,
        },
      ] as const;
    }),
  );
  const widestRelationLabel = Math.max(
    0,
    ...[...relationMeasurements.values()].map(({ labelWidth }) => labelWidth),
  );
  const tallestRelationLabel = Math.max(
    0,
    ...[...relationMeasurements.values()].map(({ labelHeight }) => labelHeight),
  );
  const metrics: ArchitectureLayoutMetrics = {
    blockGap: Math.max(
      config.nodeSeparation,
      tallestRelationLabel + portExtent * 2,
    ),
    groupBlockInset: config.padding,
    groupInlineInset: config.padding,
    inlineGap: Math.max(
      config.nodeSeparation,
      widestRelationLabel + portExtent * 2,
    ),
  };
  const services = [...model.services]
    .sort((left, right) => left.order - right.order)
    .map((service) => {
      const label = service.label || service.id;
      const icon = architectureIconDisplay(service.icon, service.iconKind);
      const measured = architectureServiceMeasurement(
        label,
        icon,
        service.hasIcon,
        service.iconKind,
        typography,
        config.iconSize,
      );
      return visualNode({
        details: measured.details,
        displayLabel: label,
        familyData: architectureNodeFamilyData({
          groupId: service.groupId,
          hasIcon: service.hasIcon,
          hasLabel: service.hasLabel,
          icon: service.icon,
          iconKind: service.iconKind,
          intrinsicHeight: measured.height,
          intrinsicWidth: measured.width,
          kind: "service",
          label: service.label,
          sourceId: service.id,
          typographyKey,
        }),
        height: measured.height,
        id: service.id,
        label: service.label || service.id,
        shape: "subroutine",
        textVerticalAlign: service.hasIcon ? "bottom" : "center",
        width: measured.width,
        x: 0,
        y: 0,
      });
    });
  const junctionDiameter = config.iconSize;
  const junctions = [...model.junctions]
    .sort((left, right) => left.order - right.order)
    .map((junction) =>
      visualNode({
        displayLabel: "",
        familyData: architectureNodeFamilyData({
          groupId: junction.groupId,
          hasIcon: false,
          hasLabel: false,
          icon: "",
          iconKind: "none",
          intrinsicHeight: junctionDiameter,
          intrinsicWidth: junctionDiameter,
          kind: "junction",
          label: "",
          sourceId: junction.id,
          typographyKey,
        }),
        height: junctionDiameter,
        id: junction.id,
        label: "",
        labelEditable: false,
        shape: "circle",
        width: junctionDiameter,
        x: 0,
        y: 0,
      }),
    );
  const nodes = [...services, ...junctions];
  const directNodeIdsByGroup = new Map<string, string[]>();
  for (const node of nodes) {
    const groupId = architectureNodeGfxData(node)?.groupId ?? "";
    const members = directNodeIdsByGroup.get(groupId) ?? [];
    members.push(node.id);
    directNodeIdsByGroup.set(groupId, members);
  }
  const groups: ArchitectureLayoutGroup[] = [...model.groups]
    .sort((left, right) => left.order - right.order)
    .map((group) => {
      const measured = architectureGroupMeasurement(
        group.label || group.id,
        architectureIconDisplay(group.icon),
        group.hasIcon,
        typography,
        config.padding,
      );
      return {
        direction: "TD",
        displayLabel: measured.displayLabel,
        familyData: architectureSubgraphFamilyData({
          hasIcon: group.hasIcon,
          hasLabel: group.hasLabel,
          icon: group.icon,
          intrinsicHeight: measured.size.height + metrics.groupBlockInset,
          intrinsicWidth: measured.size.width + metrics.groupInlineInset * 2,
          label: group.label,
          parentId: group.parentId,
          sourceId: group.id,
          typographyKey,
        }),
        headerHeight: measured.size.height,
        headerWidth: measured.size.width,
        height: measured.size.height + metrics.groupBlockInset,
        id: group.id,
        nodeIds: directNodeIdsByGroup.get(group.id) ?? [],
        parentId: group.parentId,
        title: group.label || group.id,
        width: measured.size.width + metrics.groupInlineInset * 2,
        x: 0,
        y: 0,
      };
    });
  return {
    config,
    groups,
    metrics,
    nodes,
    relationMeasurements,
    typography,
    typographyKey,
  } satisfies ArchitectureLayoutMeasurement;
}
