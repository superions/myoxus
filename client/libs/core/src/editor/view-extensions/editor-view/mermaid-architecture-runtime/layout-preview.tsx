// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  DialogFooterActions,
  Modal,
  Stack,
} from "@myoxus/ui-facade";
import type {
  MermaidArchitectureEditorReactHostProps,
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
} from "@virgultum/block-mermaid";
import { useId, useState } from "react";

function visualModelBounds(model: MermaidVisualModel) {
  const items = [...model.nodes, ...(model.subgraphs ?? [])];
  if (!items.length) return { height: 1, width: 1, x: 0, y: 0 };
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  const shortestSide = Math.min(
    ...items.map((item) => Math.min(item.width, item.height)),
  );
  const padding = Math.max(Number.EPSILON, shortestSide / 2);
  return {
    height: bottom - top + padding * 2,
    width: right - left + padding * 2,
    x: left - padding,
    y: top - padding,
  };
}

function endpoint(
  node: MermaidVisualNode,
  position: MermaidVisualEdge["sourcePosition"],
) {
  const [x, y] = position ?? [0.5, 0.5];
  return {
    x: node.x + node.width * x,
    y: node.y + node.height * y,
  };
}

function PreviewLabel({
  anchor = "middle",
  baseline = "middle",
  value,
  x,
  y,
}: {
  readonly anchor?: "middle" | "start";
  readonly baseline?: "hanging" | "middle";
  readonly value: string;
  readonly x: number;
  readonly y: number;
}) {
  const lines = value.split("\n");
  const firstOffset = baseline === "middle" ? (1 - lines.length) * 0.6 : 0;
  return (
    <text
      dominantBaseline={baseline}
      fill="var(--myoxus-text-primary-color)"
      textAnchor={anchor}
      x={x}
      y={y}
    >
      {lines.map((line, index) => (
        <tspan
          dy={`${index === 0 ? firstOffset : 1.2}em`}
          key={`${index}:${line}`}
          x={x}
        >
          {line}
        </tspan>
      ))}
    </text>
  );
}

function ArchitectureLayoutPreviewSvg({
  label,
  model,
}: {
  readonly label: string;
  readonly model: MermaidVisualModel;
}) {
  const bounds = visualModelBounds(model);
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
  const markerId = `myoxus-mermaid-architecture-layout-preview-arrow-${useId().replaceAll(":", "")}`;
  return (
    <svg
      aria-label={model.accessibilityTitle || model.diagramTitle || label}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
      width="100%"
      fontFamily="var(--myoxus-typography-body-family)"
      fontSize="var(--myoxus-typography-body-size)"
    >
      <defs>
        <marker
          id={markerId}
          markerHeight="6"
          markerUnits="strokeWidth"
          markerWidth="6"
          orient="auto-start-reverse"
          refX="5"
          refY="3"
          viewBox="0 0 6 6"
        >
          <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--myoxus-border-color)" />
        </marker>
      </defs>
      {(model.subgraphs ?? []).map((group) => (
        <g key={group.id}>
          <rect
            fill="var(--myoxus-background-secondary-color)"
            height={group.height}
            stroke="var(--myoxus-border-color)"
            width={group.width}
            x={group.x}
            y={group.y}
          />
          <PreviewLabel
            baseline="hanging"
            value={group.displayLabel || group.title}
            x={group.x + group.width / 2}
            y={group.y}
          />
        </g>
      ))}
      {model.edges.map((edge) => {
        const source = nodesById.get(edge.source);
        const target = nodesById.get(edge.target);
        if (!source || !target) return null;
        const start = endpoint(source, edge.sourcePosition);
        const end = endpoint(target, edge.targetPosition);
        const self = source.id === target.id;
        const path = self
          ? `M ${start.x} ${start.y} C ${start.x + source.width} ${start.y - source.height} ${end.x + target.width} ${end.y + target.height} ${end.x} ${end.y}`
          : `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
        return (
          <g key={edge.id}>
            <path
              d={path}
              fill="none"
              markerEnd={
                edge.linkType === "arrow" || edge.linkType === "bidirectional"
                  ? `url(#${markerId})`
                  : undefined
              }
              markerStart={
                edge.linkType === "reverse" || edge.linkType === "bidirectional"
                  ? `url(#${markerId})`
                  : undefined
              }
              stroke="var(--myoxus-border-color)"
            />
            {edge.label ? (
              <PreviewLabel
                value={edge.label}
                x={(start.x + end.x) / 2}
                y={(start.y + end.y) / 2}
              />
            ) : null}
          </g>
        );
      })}
      {model.nodes.map((node) => (
        <g key={node.id}>
          {node.shape === "circle" ? (
            <circle
              cx={node.x + node.width / 2}
              cy={node.y + node.height / 2}
              fill="var(--myoxus-background-primary-color)"
              r={Math.min(node.width, node.height) / 2}
              stroke="var(--myoxus-border-color)"
            />
          ) : (
            <rect
              fill="var(--myoxus-background-primary-color)"
              height={node.height}
              stroke="var(--myoxus-border-color)"
              width={node.width}
              x={node.x}
              y={node.y}
            />
          )}
          {node.displayLabel || node.label ? (
            <PreviewLabel
              value={node.displayLabel || node.label}
              x={node.x + node.width / 2}
              y={node.y + node.height / 2}
            />
          ) : null}
        </g>
      ))}
    </svg>
  );
}

export function useArchitectureLayoutPreview(
  props: MermaidArchitectureEditorReactHostProps,
) {
  const t = useI18n();
  const [preview, setPreview] = useState<MermaidVisualModel | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  return {
    open: () => {
      setDiagnostic(null);
      setPreview(props.onLayoutPreview());
    },
    preview: preview ? (
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={props.labels.layout}
      >
        <Stack gap="sm">
          <ArchitectureLayoutPreviewSvg
            label={props.labels.layout}
            model={preview}
          />
          {diagnostic ? (
            <Alert color="myoxusError" role="alert" variant="light">
              {diagnostic}
            </Alert>
          ) : null}
          <DialogFooterActions>
            <Button onClick={() => setPreview(null)} variant="secondary">
              {t["com.myoxus.confirmModal.button.cancel"]()}
            </Button>
            <Button
              onClick={() => {
                const result = props.onLayoutApply(preview);
                setDiagnostic(result);
                if (!result) setPreview(null);
              }}
            >
              {props.labels.layout}
            </Button>
          </DialogFooterActions>
        </Stack>
      </Modal>
    ) : null,
  };
}
