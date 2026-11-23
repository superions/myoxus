// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MountReactPortal } from "@myoxus/lit-react";
import {
  MermaidFamilyReactHostExtension,
  type MermaidViewBinding,
  mermaidPieRendererToken,
  type MermaidPieReactHostProps,
  mermaidQuadrantRendererToken,
  type MermaidQuadrantReactHostProps,
  mermaidXyRendererToken,
  type MermaidXyReactHostProps,
  mermaidRadarRendererToken,
  type MermaidRadarReactHostProps,
  mermaidSankeyRendererToken,
  type MermaidSankeyReactHostProps,
  mermaidTreemapRendererToken,
  type MermaidTreemapReactHostProps,
  createMermaidFamilyReactRendererHost,
  type MermaidBlockShellReactHostProps,
  type MermaidEmbeddedTitleReactHostProps,
  type MermaidShellNoticeReactHostProps,
} from "@virgultum/block-mermaid";
import type { ExtensionType } from "@virgultum/core/store";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { EditorActionMenu } from "./editor-chrome/action-menu";
import { EditorEmbeddedUIRoot } from "./embedded-ui-root";
import { DeferredMermaidChart } from "./deferred-mermaid-chart";
import { createMermaidTimelineRendererRegistration } from "./mermaid-timeline-runtime";
import { createMermaidGanttRendererRegistration } from "./mermaid-gantt-runtime";
import { createMermaidKanbanRendererRegistration } from "./mermaid-kanban-runtime";
import { createMermaidJourneyRendererRegistration } from "./mermaid-journey-runtime";
import { createMermaidSequenceRendererRegistration } from "./mermaid-sequence-runtime";
import { createMermaidErRendererRegistration } from "./mermaid-er-runtime";
import { createMermaidClassRendererRegistration } from "./mermaid-class-runtime";
import { createMermaidPacketRendererRegistration } from "./mermaid-packet-runtime";
import { createMermaidArchitectureRendererRegistration } from "./mermaid-architecture-runtime";
import {
  MermaidBlockShell,
  MermaidEmbeddedTitle,
  MermaidEditorShellNotice,
} from "./mermaid-editor-workbench";
import { createMermaidFlowchartRendererRegistration } from "./mermaid-flowchart-runtime";
import { createMermaidBlockRendererRegistration } from "./mermaid-block-diagram-runtime";
import { createMermaidStateRendererRegistration } from "./mermaid-state-runtime";
import {
  createMermaidGitGraphRendererRegistration,
  createMermaidGitGraphRepairRegistration,
} from "./mermaid-gitgraph-runtime";
import { createMermaidC4RendererRegistration } from "./mermaid-c4-runtime";
import { createMermaidMindmapRendererRegistration } from "./mermaid-mindmap-runtime";
import { createMermaidRequirementRendererRegistration } from "./mermaid-requirement-runtime";

function MermaidView({ binding }: { binding: MermaidViewBinding }) {
  const view = useSyncExternalStore(binding.subscribe, binding.getSnapshot);
  useLayoutEffect(() => binding.afterCommit?.(), [binding, view]);
  return view;
}

export function patchMermaidFamilyReactHost(
  mountPortal: MountReactPortal,
): ExtensionType {
  const rendererHost = createMermaidFamilyReactRendererHost([
    createMermaidFlowchartRendererRegistration(),
    createMermaidGanttRendererRegistration(),
    createMermaidTimelineRendererRegistration(),
    createMermaidKanbanRendererRegistration(),
    {
      token: mermaidPieRendererToken,
      render: (props: MermaidPieReactHostProps) => (
        <DeferredMermaidChart key="pie" kind="pie" props={props} />
      ),
    },
    {
      token: mermaidQuadrantRendererToken,
      render: (props: MermaidQuadrantReactHostProps) => (
        <DeferredMermaidChart key="quadrant" kind="quadrant" props={props} />
      ),
    },
    {
      token: mermaidXyRendererToken,
      render: (props: MermaidXyReactHostProps) => (
        <DeferredMermaidChart key="xy" kind="xy" props={props} />
      ),
    },
    {
      token: mermaidRadarRendererToken,
      render: (props: MermaidRadarReactHostProps) => (
        <DeferredMermaidChart key="radar" kind="radar" props={props} />
      ),
    },
    {
      token: mermaidSankeyRendererToken,
      render: (props: MermaidSankeyReactHostProps) => (
        <DeferredMermaidChart key="sankey" kind="sankey" props={props} />
      ),
    },
    {
      token: mermaidTreemapRendererToken,
      render: (props: MermaidTreemapReactHostProps) => (
        <DeferredMermaidChart key="treemap" kind="treemap" props={props} />
      ),
    },
    createMermaidJourneyRendererRegistration(),
    createMermaidPacketRendererRegistration(),
    createMermaidClassRendererRegistration(),
    createMermaidErRendererRegistration(),
    createMermaidSequenceRendererRegistration(),
    createMermaidStateRendererRegistration(),
    createMermaidBlockRendererRegistration(),
    createMermaidC4RendererRegistration(),
    createMermaidGitGraphRendererRegistration(),
    createMermaidGitGraphRepairRegistration(),
    createMermaidMindmapRendererRegistration(),
    createMermaidRequirementRendererRegistration(),
    createMermaidArchitectureRendererRegistration(),
  ]);
  return MermaidFamilyReactHostExtension({
    ...rendererHost,
    mount: (anchor, binding) =>
      mountPortal(
        anchor,
        <EditorEmbeddedUIRoot portalRoot={anchor}>
          <MermaidView binding={binding} />
        </EditorEmbeddedUIRoot>,
      ),
    renderContextMenu: (controls) => <EditorActionMenu controls={controls} />,
    renderEmbeddedTitle: (props: MermaidEmbeddedTitleReactHostProps) => (
      <MermaidEmbeddedTitle props={props} />
    ),
    renderBlockShell: (props: MermaidBlockShellReactHostProps) => (
      <MermaidBlockShell props={props} />
    ),
    renderShellNotice: (props: MermaidShellNoticeReactHostProps) => (
      <MermaidEditorShellNotice props={props} />
    ),
  });
}
