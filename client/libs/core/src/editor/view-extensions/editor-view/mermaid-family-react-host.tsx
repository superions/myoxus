// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LitPortalDecorator, ReactToLit } from "@myoxus/lit-react";
import { MyoxusEmbeddedUIProvider } from "@myoxus/ui-facade/provider";
import {
  MermaidFamilyReactHostExtension,
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
import type { ExtensionType } from "@virgultum/store";
import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
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

function findMermaidThemeScope(element: Element): Element | null {
  let current: Element | null = element;
  while (current) {
    const themeScope = current.closest(
      "[data-theme='light'], [data-theme='dark']",
    );
    if (themeScope) return themeScope;

    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function resolveMermaidColorScheme(
  portalRoot: HTMLElement,
): "dark" | "light" | undefined {
  const theme = findMermaidThemeScope(portalRoot)?.getAttribute("data-theme");
  return theme === "dark" || theme === "light" ? theme : undefined;
}

function ensureMermaidPortalSelector(portalRoot: HTMLElement) {
  const attribute = "data-myoxus-mermaid-react-root";
  let id = portalRoot.getAttribute(attribute);
  if (!id) {
    id = portalRoot.getAttribute("portalid");
    if (!id) throw new Error("Mermaid React portal is missing its anchor id");
    portalRoot.setAttribute(attribute, id);
  }
  return `[${attribute}="${id}"]`;
}

/** Keep Mantine controls aligned with the nearest Page/Edgeless renderer. */
function MermaidEmbeddedUIRoot({
  children,
  portalRoot,
}: PropsWithChildren<{ portalRoot: HTMLElement }>) {
  const [colorScheme, setColorScheme] = useState<"dark" | "light" | undefined>(
    () => resolveMermaidColorScheme(portalRoot),
  );
  const [cssVariablesSelector] = useState(() =>
    ensureMermaidPortalSelector(portalRoot),
  );
  const getRootElement = useCallback(() => portalRoot, [portalRoot]);

  useEffect(() => {
    const themeScope = findMermaidThemeScope(portalRoot);
    if (!themeScope) return undefined;
    const update = () => setColorScheme(resolveMermaidColorScheme(portalRoot));
    update();
    const observer = new MutationObserver(update);
    observer.observe(themeScope, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, [portalRoot]);

  return (
    <MyoxusEmbeddedUIProvider
      colorScheme={colorScheme}
      cssVariablesSelector={cssVariablesSelector}
      getRootElement={getRootElement}
    >
      {children}
    </MyoxusEmbeddedUIProvider>
  );
}

export function patchMermaidFamilyReactHost(
  reactToLit: ReactToLit,
): ExtensionType {
  const decorateMermaidPortal: LitPortalDecorator = (
    portalElement,
    portalRoot,
  ) => (
    <MermaidEmbeddedUIRoot portalRoot={portalRoot}>
      {portalElement as ReactNode}
    </MermaidEmbeddedUIRoot>
  );
  const mermaidReactToLit: ReactToLit = (element, rerendering) =>
    reactToLit(element, rerendering, decorateMermaidPortal);
  const rendererHost = createMermaidFamilyReactRendererHost([
    createMermaidFlowchartRendererRegistration(mermaidReactToLit),
    createMermaidGanttRendererRegistration(mermaidReactToLit),
    createMermaidTimelineRendererRegistration(mermaidReactToLit),
    createMermaidKanbanRendererRegistration(mermaidReactToLit),
    {
      token: mermaidPieRendererToken,
      render: (props: MermaidPieReactHostProps) =>
        mermaidReactToLit(
          <DeferredMermaidChart key="pie" kind="pie" props={props} />,
          true,
        ),
    },
    {
      token: mermaidQuadrantRendererToken,
      render: (props: MermaidQuadrantReactHostProps) =>
        mermaidReactToLit(
          <DeferredMermaidChart key="quadrant" kind="quadrant" props={props} />,
          true,
        ),
    },
    {
      token: mermaidXyRendererToken,
      render: (props: MermaidXyReactHostProps) =>
        mermaidReactToLit(
          <DeferredMermaidChart key="xy" kind="xy" props={props} />,
          true,
        ),
    },
    {
      token: mermaidRadarRendererToken,
      render: (props: MermaidRadarReactHostProps) =>
        mermaidReactToLit(
          <DeferredMermaidChart key="radar" kind="radar" props={props} />,
          true,
        ),
    },
    {
      token: mermaidSankeyRendererToken,
      render: (props: MermaidSankeyReactHostProps) =>
        mermaidReactToLit(
          <DeferredMermaidChart key="sankey" kind="sankey" props={props} />,
          true,
        ),
    },
    {
      token: mermaidTreemapRendererToken,
      render: (props: MermaidTreemapReactHostProps) =>
        mermaidReactToLit(
          <DeferredMermaidChart key="treemap" kind="treemap" props={props} />,
          true,
        ),
    },
    createMermaidJourneyRendererRegistration(mermaidReactToLit),
    createMermaidPacketRendererRegistration(mermaidReactToLit),
    createMermaidClassRendererRegistration(mermaidReactToLit),
    createMermaidErRendererRegistration(mermaidReactToLit),
    createMermaidSequenceRendererRegistration(mermaidReactToLit),
    createMermaidStateRendererRegistration(mermaidReactToLit),
    createMermaidBlockRendererRegistration(mermaidReactToLit),
    createMermaidC4RendererRegistration(mermaidReactToLit),
    createMermaidGitGraphRendererRegistration(mermaidReactToLit),
    createMermaidGitGraphRepairRegistration(mermaidReactToLit),
    createMermaidMindmapRendererRegistration(mermaidReactToLit),
    createMermaidRequirementRendererRegistration(mermaidReactToLit),
    createMermaidArchitectureRendererRegistration(mermaidReactToLit),
  ]);
  return MermaidFamilyReactHostExtension({
    ...rendererHost,
    renderEmbeddedTitle: (props: MermaidEmbeddedTitleReactHostProps) =>
      mermaidReactToLit(<MermaidEmbeddedTitle props={props} />, true),
    renderBlockShell: (props: MermaidBlockShellReactHostProps) =>
      mermaidReactToLit(<MermaidBlockShell props={props} />, true),
    renderShellNotice: (props: MermaidShellNoticeReactHostProps) =>
      mermaidReactToLit(<MermaidEditorShellNotice props={props} />, true),
  });
}
