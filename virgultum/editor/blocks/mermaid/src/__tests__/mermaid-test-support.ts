import { serializeMermaidVisualFamilyData } from "../families/runtime/gfx-family-data.js";
import { existsSync, readFileSync } from "node:fs";

import { codeBlockMarkdownAdapterMatcher } from "@virgultum/block-code";
import { Bound } from "@virgultum/global/gfx";
import {
  ConnectorLabelOffsetAnchor,
  ConnectorMode,
  type MermaidBlockModel,
  MermaidBlockSchema,
} from "@virgultum/model";
import { FeatureFlagService } from "@virgultum/shared/services";
import type { BlockStdScope } from "@virgultum/std";
import { internalPrimitives } from "@virgultum/store";
import type { SlashMenuContext } from "@virgultum/widget-slash-menu";
import { html, render } from "lit";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import {
  createMermaidBlockSnapshot,
  isMermaidMarkdownCodeNode,
  mermaidBlockMarkdownAdapterMatcher,
} from "../adapters/markdown.js";
import type { MermaidVisualHistoryEntry } from "../mermaid-block-constants.js";

import {
  addMermaidVisualNode,
  addMermaidVisualSubgraph,
  applyMermaidVisualModelCommand,
  connectMermaidVisualNodes,
  createMermaidBlockInsertProps,
  createMermaidElementIndexMaps,
  deleteMermaidVisualSelection,
  ensureMermaidProjectionOwnerCommand,
  getMermaidVisualFrameGeometry,
  getMermaidVisualElementOriginFromAnchor,
  getMermaidVisualModelForEditing,
  insertMermaidBlockCommand,
  insertMermaidEdgelessDiagramCommand,
  moveMermaidVisualNode,
  reconnectMermaidVisualEdge,
  renameMermaidVisualEdge,
  renameMermaidVisualSubgraph,
  resizeMermaidVisualNode,
  resizeMermaidVisualSubgraph,
  setMermaidVisualEdgeC4Relationship,
  setMermaidVisualEdgeLinkType,
  setMermaidVisualEdgeRequirementRelationKind,
  setMermaidVisualEdgeStyle,
  setMermaidVisualEdgeStyleStatement,
  setMermaidVisualNodeShape,
  setMermaidVisualNodeStyleClass,
  setMermaidVisualSubgraphDirection,
  syncMermaidVisualModelFromProjectionOwnerCommand,
} from "../commands.js";
import {
  addMermaidGfxEdgeCommand,
  applyMermaidGfxEdgeCommand,
  applyMermaidGfxNodeCommand,
  applyMermaidGfxSubgraphCommand,
  reconnectMermaidGfxEdgeCommand,
} from "../families/runtime/gfx-commands.js";
export {
  createMermaidVisualFamilyData,
  parseMermaidVisualFamilyData,
  serializeMermaidVisualFamilyData,
} from "../families/runtime/gfx-family-data.js";
export {
  architectureEdgeFamilyData,
  architectureEdgeGfxData,
  architectureNodeFamilyData,
  architectureNodeGfxData,
  architectureSubgraphFamilyData,
  architectureSubgraphGfxData,
} from "../families/architecture/gfx-data.js";
export { applyArchitectureSemanticFieldMutations } from "../families/architecture/mutations/index.js";
import type {
  MermaidEditorCapabilities,
  MermaidEditorShellProjection,
} from "../families/runtime/editor-capabilities.js";
import type {
  MermaidBlockShellReactHostProps,
  MermaidShellNoticeReactHostProps,
} from "../families/runtime/shell-contract.js";
import { resolveMermaidHostResolution } from "../families/runtime/host-controller.js";
import type { MermaidTimelineReactHostProps } from "../families/timeline/react-host-contract.js";
import type { MermaidPieReactHostProps } from "../families/charts/pie/react-host-contract.js";
import type { MermaidSankeyReactHostProps } from "../families/charts/sankey/react-host-contract.js";
import type { MermaidTreemapReactHostProps } from "../families/charts/treemap/react-host-contract.js";
import type { MermaidPacketReactHostProps } from "../families/packet/react-host-contract.js";
import type { MermaidJourneyReactHostProps } from "../families/journey/react-host-contract.js";
import type { MermaidKanbanReactHostProps } from "../families/kanban/react-host-contract.js";
import {
  insertMermaidEdgelessToolbarTemplate,
  getMermaidEdgelessToolbarTemplates,
} from "../edgeless-toolbar/index.js";
import { effects } from "../effects.js";
import {
  addMermaidArchitectureEdge,
  generateMermaidArchitectureSource,
  parseMermaidArchitectureSource,
  renameMermaidArchitectureEdge,
  renameMermaidArchitectureService,
} from "../engine/architecture/index.js";
import {
  addMermaidBlockDiagramEdge,
  generateMermaidBlockDiagramSource,
  parseMermaidBlockDiagramSource,
  renameMermaidBlockDiagramEdge,
  renameMermaidBlockDiagramNode,
} from "../engine/block/index.js";
import {
  addMermaidC4Relationship,
  generateMermaidC4Source,
  parseMermaidC4Source,
  renameMermaidC4Element,
  renameMermaidC4Relationship,
} from "../engine/c4/index.js";
import {
  generateMermaidClassSource,
  parseMermaidClassSource,
} from "../engine/class/index.js";
import { detectMermaidDiagramType } from "../engine/diagram-types.js";
import {
  addErRelationship,
  editErRelationship,
  generateMermaidErSource,
  parseMermaidErSource,
} from "../engine/er/index.js";
import { parseMermaidSourceToVisualModel } from "../engine/flowchart.js";
import { generateMermaidSourceFromVisualModel } from "../engine/flowchart-writer.js";
import {
  createDefaultMermaidVisualModel,
  DEFAULT_MERMAID_FLOWCHART_SOURCE,
} from "../families/flowchart/defaults.js";
import {
  getMermaidVisualNodeDetailElementEntries,
  resolveMermaidConnectorLabelXYWH,
  toMermaidConnectorElementProps as toRawMermaidConnectorElementProps,
  toMermaidNodeDetailElementProps,
  toMermaidShapeElementProps as toRawMermaidShapeElementProps,
  toMermaidSubgraphElementProps as toRawMermaidSubgraphElementProps,
} from "../families/runtime/gfx-element-projection.js";
import { resolveMermaidGfxEdgeEndpointPositions } from "../families/runtime/gfx-model.js";
import { createMermaidVisualModelFromGfxElements } from "../families/runtime/gfx-element-readback.js";
import {
  projectNeutralMermaidGfxConnectorElement,
  projectNeutralMermaidGfxNodeElement,
  projectNeutralMermaidGfxSubgraphElement,
} from "../families/runtime/gfx-element-projection-defaults.js";
import {
  typeOwnedMermaidEdgeElementProjection,
  typeOwnedMermaidNodeDetailElementProjection,
  typeOwnedMermaidNodeElementProjection,
  typeOwnedMermaidSubgraphElementProjection,
} from "../families/runtime/gfx-owner-hooks.js";
import {
  MERMAID_GFX_SUBGRAPH_ROLE as MERMAID_FLOWCHART_SUBGRAPH_ROLE,
  MERMAID_GFX_DETAIL_ROLE,
} from "../families/runtime/gfx-element-roles.js";
import {
  createMermaidGfxModelHash as createMermaidVisualHash,
  type MermaidVisualModel,
} from "../families/runtime/gfx-model.js";

import {
  applyGanttCommand,
  parseMermaidGanttSource,
} from "../engine/gantt/index.js";
import {
  generateMermaidGitGraphSource,
  parseMermaidGitGraphSource,
} from "../engine/gitgraph/index.js";
import {
  generateMermaidJourneySource,
  moveMermaidJourneyStepToSection,
  parseMermaidJourneySource,
  renameMermaidJourneySection,
  renameMermaidJourneyStep,
  setMermaidJourneyStepActors,
  setMermaidJourneyStepScore,
} from "../engine/journey/index.js";
import {
  generateMermaidKanbanSource,
  applyKanbanCommand,
  parseMermaidKanbanSource,
} from "../engine/kanban/index.js";
import {
  generateMermaidMindmapSource,
  parseMermaidMindmapSource,
  renameMermaidMindmapNode,
  setMermaidMindmapNodeShape,
} from "../engine/mindmap/index.js";
import {
  applyPacketCommand,
  parseMermaidPacketSource,
} from "../engine/packet/index.js";
import { parseMermaidPieSource } from "../engine/charts/pie/parser.js";
import {
  isMermaidProductDiagramType,
  MERMAID_PRODUCT_DIAGRAM_SPECS,
  MERMAID_PRODUCT_DIAGRAM_TYPES,
  MERMAID_PRODUCT_TEMPLATES,
} from "../engine/product-types.js";
import {
  addMermaidRequirementRelation,
  generateMermaidRequirementSource,
  parseMermaidRequirementSource,
  renameMermaidRequirementRelation,
  setMermaidRequirementRisk,
} from "../engine/requirement/index.js";
import {
  addMermaidSequenceMessage,
  generateMermaidSequenceSource,
  parseMermaidSequenceSource,
  renameMermaidSequenceMessage,
  renameMermaidSequenceParticipant,
} from "../engine/sequence/index.js";
import {
  addStateTransition,
  parseMermaidStateSource,
  setStateHeading,
  editStateTransition,
} from "../engine/state/index.js";
import { parseMermaidTimelineSource } from "../engine/timeline/index.js";
import { isMermaidFamilyVisualEditingDiagramType } from "../families/index.js";
import { resolveMermaidFamilyRuntime } from "../families/runtime/registry.js";
import { getMermaidVisualHistoryStacks } from "../mermaid-visual-source-history.js";
import { mermaidMessages, setMermaidI18nTranslator } from "../i18n.js";
import { MermaidBlockComponent } from "../mermaid-block.js";
import { createMermaidPageSelectionState } from "../mermaid-page-selection-state.js";
import {
  createMermaidPageViewportState,
  type MermaidPageViewportProjection,
  type MermaidPageViewportState,
} from "../mermaid-page-viewport-state.js";
import {
  generateMermaidSourceFromGfxVisualModel,
  parseMermaidSourceToGfxVisualModel,
} from "../mermaid-gfx-graph-adapters.js";
import {
  getMermaidGfxShapePalette,
  isMermaidGraphGfxDiagramType,
} from "../families/runtime/gfx-graph-operations.js";
import { DEFAULT_MERMAID_FONT_FAMILY } from "../renderer.js";
import {
  canShowMermaidSlashItem,
  mermaidSlashMenuConfig,
} from "../slash-menu.js";
import {
  getMermaidBlockSource,
  getMermaidBlockTitle,
  hashMermaidSource,
  normalizeMermaidSourceInput,
  setMermaidBlockText,
} from "../utils.js";

function testPageViewportProjection(
  state: MermaidPageViewportState,
  mode: MermaidPageViewportProjection["mode"] = "visual",
): MermaidPageViewportProjection {
  return {
    mode,
    onAvailabilityChange: () => undefined,
    onPositionChange: () => undefined,
    onResolvedScaleChange: () => undefined,
    onZoomChange: () => undefined,
    resolveCenterPosition: () => null,
    resolveNavigationGeometry: () => null,
    state,
  };
}

function toMermaidShapeElementProps(
  node: Parameters<typeof toRawMermaidShapeElementProps>[0],
  ownerBound: Parameters<typeof toRawMermaidShapeElementProps>[1],
  diagramDirection?: Parameters<typeof toRawMermaidShapeElementProps>[2],
  diagramTitle?: Parameters<typeof toRawMermaidShapeElementProps>[3],
  projection = projectNeutralMermaidGfxNodeElement(node),
) {
  return toRawMermaidShapeElementProps(
    node,
    ownerBound,
    diagramDirection,
    diagramTitle,
    projection,
  );
}

function toMermaidSubgraphElementProps(
  subgraph: Parameters<typeof toRawMermaidSubgraphElementProps>[0],
  ownerBound: Parameters<typeof toRawMermaidSubgraphElementProps>[1],
  projection = projectNeutralMermaidGfxSubgraphElement(),
) {
  return toRawMermaidSubgraphElementProps(subgraph, ownerBound, projection);
}

function toMermaidConnectorElementProps(
  edge: Parameters<typeof toRawMermaidConnectorElementProps>[0],
  idMap: Parameters<typeof toRawMermaidConnectorElementProps>[1],
  labelXYWH?: Parameters<typeof toRawMermaidConnectorElementProps>[2],
  projection = projectNeutralMermaidGfxConnectorElement(edge),
) {
  return toRawMermaidConnectorElementProps(edge, idMap, labelXYWH, projection);
}

export function yMapFromRecord(props: Record<string, unknown>) {
  return {
    get: (key: string) => props[key],
  };
}

export function expectPresent<T>(value: T): asserts value is NonNullable<T> {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
}

export function expectMermaidVisualHash(
  hash: string | null,
): asserts hash is string {
  expect(hash).toBeTruthy();
}

export function expectMermaidVisualModel(
  model: MermaidVisualModel | null,
): asserts model is MermaidVisualModel {
  expectPresent(model);
}

export function createSlashContext({
  flag,
  schemaRegistered,
}: {
  flag: boolean;
  schemaRegistered: boolean;
}): SlashMenuContext {
  return {
    model: {
      store: {
        schema: {
          flavourSchemaMap: new Map(
            schemaRegistered ? [[MermaidBlockSchema.model.flavour, {}]] : [],
          ),
        },
      },
    },
    std: {
      get: (service: unknown) => {
        expect(service).toBe(FeatureFlagService);
        return {
          getFlag: (key: string) => {
            expect(key).toBe("enable_mermaid_block");
            return flag;
          },
        };
      },
    },
  } as unknown as SlashMenuContext;
}

export function renderFakeFlowchartGfxEditor(
  readonly: boolean,
  {
    diagramType = "flowchart",
    displayOnly = false,
  }: { diagramType?: string; displayOnly?: boolean } = {},
) {
  return html`<div
    class="myoxus-mermaid-gfx-editor"
    data-diagram-type=${diagramType}
    data-mermaid-display-mode=${displayOnly ? "display" : "edit"}
    data-mermaid-gfx-editable=${displayOnly ? "false" : "true"}
    data-mermaid-gfx-surface="true"
  >
    ${
      displayOnly
        ? null
        : html`<div
            class="myoxus-mermaid-visual-toolbar"
            data-myoxus-ui-role="toolbar-surface"
            @beforeinput=${(event: Event) => event.stopPropagation()}
            @click=${(event: Event) => event.stopPropagation()}
            @input=${(event: Event) => event.stopPropagation()}
            @keydown=${(event: Event) => event.stopPropagation()}
            @keypress=${(event: Event) => event.stopPropagation()}
            @keyup=${(event: Event) => event.stopPropagation()}
            @mousedown=${(event: Event) => event.stopPropagation()}
            @mouseup=${(event: Event) => event.stopPropagation()}
            @pointerdown=${(event: Event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Add node"
              ?disabled=${readonly}
            ></button>
          </div>`
    }
    <div data-myoxus-ui-role="mermaid-editor-workarea-owner">
      <div class="myoxus-mermaid-gfx-viewport"></div>
    </div>
    ${
      displayOnly
        ? null
        : html`<div class="myoxus-mermaid-viewport-resize-row">
            <button
              class="myoxus-mermaid-viewport-resize-handle"
              type="button"
              aria-label=${mermaidMessages.visualResizeViewport()}
            ></button>
          </div>`
    }
  </div>`;
}

export function installProjectedMermaidTestTheme() {
  const values: Record<string, string> = {
    "--myoxus-background-primary-color": "rgb(255, 255, 255)",
    "--myoxus-background-error-color": "rgb(255, 225, 225)",
    "--myoxus-background-processing-color": "rgb(225, 240, 255)",
    "--myoxus-background-secondary-color": "rgb(245, 245, 245)",
    "--myoxus-background-success-color": "rgb(230, 250, 235)",
    "--myoxus-background-warning-color": "rgb(255, 240, 215)",
    "--myoxus-border-color": "rgb(80, 80, 80)",
    "--myoxus-error-color": "rgb(175, 55, 55)",
    "--myoxus-primary-color": "rgb(70, 90, 210)",
    "--myoxus-processing-color": "rgb(45, 105, 150)",
    "--myoxus-success-color": "rgb(30, 130, 70)",
    "--myoxus-text-primary-color": "rgb(20, 20, 20)",
    "--myoxus-document-text-on-light-fill": "rgb(20, 20, 20)",
    "--myoxus-document-text-on-dark-fill": "rgb(235, 235, 235)",
    "--myoxus-text-secondary-color": "rgb(90, 90, 90)",
    "--myoxus-typography-body-family": "Inter",
    "--myoxus-typography-body-font-style": "normal",
    "--myoxus-typography-body-letter-spacing": "0px",
    "--myoxus-typography-body-line-height": "24px",
    "--myoxus-typography-body-size": "16px",
    "--myoxus-typography-body-small-size": "12px",
    "--myoxus-typography-body-weight": "400",
    "--myoxus-typography-h1-size": "24px",
    "--myoxus-typography-h3-size": "20px",
    "--myoxus-warning-color": "rgb(190, 95, 40)",
  };
  vi.stubGlobal("getComputedStyle", (element: Element) => {
    const requestedColor = (element as HTMLElement).style?.color.match(
      /^var\((--[^)]+)\)$/,
    )?.[1];
    return {
      backgroundColor: values["--myoxus-background-primary-color"],
      borderBottomColor: values["--myoxus-background-success-color"],
      borderColor: values["--myoxus-border-color"],
      borderLeftColor: values["--myoxus-border-color"],
      borderRightColor: values["--myoxus-primary-color"],
      borderTopColor: values["--myoxus-background-secondary-color"],
      color:
        (requestedColor ? values[requestedColor] : undefined) ??
        ((element as HTMLElement).style?.color ||
          values["--myoxus-text-primary-color"]),
      fontFamily: values["--myoxus-typography-body-family"],
      fontSize: values["--myoxus-typography-body-size"],
      fontStyle: values["--myoxus-typography-body-font-style"],
      fontWeight: values["--myoxus-typography-body-weight"],
      getPropertyValue: (property: string) => values[property] ?? "",
      letterSpacing: values["--myoxus-typography-body-letter-spacing"],
      lineHeight: values["--myoxus-typography-body-line-height"],
      outlineColor: values["--myoxus-text-secondary-color"],
      textDecorationColor: values["--myoxus-success-color"],
    } as CSSStyleDeclaration;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text: string) =>
      ({ width: Array.from(text).length * 8 }) as TextMetrics,
  } as CanvasRenderingContext2D);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
}

export function createMermaidGfxCommandFixture(source: string) {
  const parsed = parseMermaidSourceToGfxVisualModel(source);
  const fallbackParsed = parsed.model
    ? null
    : parseMermaidSourceToVisualModel(source);
  const visualModel = parsed.model ?? fallbackParsed?.model;
  if (!visualModel) {
    throw new Error("Mermaid GFX command fixture requires a visual model");
  }
  const ownerBound = new Bound(100, 200, 640, 420);
  const elements = new Map<string, Record<string, unknown>>();
  const childIds: string[] = [];
  const meta = (props: Record<string, unknown>) => {
    const values = new Map(
      Object.entries(props).filter(([key]) => key.startsWith("mermaid")),
    );
    return {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    };
  };
  const withElementBound = (element: Record<string, unknown>) => {
    Object.defineProperty(element, "elementBound", {
      get: () => {
        if (typeof element.xywh === "string")
          return Bound.deserialize(element.xywh);
        const source = elements.get((element.source as { id: string }).id)!;
        const target = elements.get((element.target as { id: string }).id)!;
        return Bound.deserialize(source.xywh as string).unite(
          Bound.deserialize(target.xywh as string),
        );
      },
    });
    return element;
  };
  const addExistingElement = (
    id: string,
    type: "connector" | "shape",
    props: Record<string, unknown>,
  ) => {
    const element = withElementBound({
      ...props,
      id,
      type,
      yMap: meta(props),
    });
    elements.set(id, element);
    childIds.push(id);
    return element;
  };
  const idMap = new Map<string, string>();
  for (const subgraph of visualModel.subgraphs ?? []) {
    const id = `subgraph-${subgraph.id}`;
    idMap.set(subgraph.id, id);
    addExistingElement(
      id,
      "shape",
      toMermaidSubgraphElementProps(
        subgraph,
        ownerBound,
        typeOwnedMermaidSubgraphElementProjection(visualModel, subgraph),
      ),
    );
  }
  for (const node of visualModel.nodes) {
    const id = `shape-${node.id}`;
    idMap.set(node.id, id);
    addExistingElement(
      id,
      "shape",
      toMermaidShapeElementProps(
        node,
        ownerBound,
        visualModel.direction,
        visualModel.diagramTitle,
        typeOwnedMermaidNodeElementProjection(visualModel, node),
      ),
    );
  }
  for (const [index, edge] of visualModel.edges.entries()) {
    addExistingElement(
      `connector-${index + 1}`,
      "connector",
      toMermaidConnectorElementProps(
        edge,
        idMap,
        undefined,
        typeOwnedMermaidEdgeElementProjection(visualModel, edge, index),
      ),
    );
  }

  const mutableText = (initial: string) => {
    let value = initial;
    return {
      get length() {
        return value.length;
      },
      delete: () => {
        value = "";
      },
      insert: (next: string) => {
        value = next;
      },
      toString: () => value,
    };
  };
  const sourceText = mutableText(source);
  const mermaidBlock = {
    addChildren: (models: Array<{ id: string }>) => {
      for (const model of models) {
        if (!childIds.includes(model.id)) childIds.push(model.id);
      }
    },
    removeChildren: (models: Array<{ id: string }>) => {
      const removeIds = new Set(models.map((model) => model.id));
      for (let index = childIds.length - 1; index >= 0; index--) {
        if (removeIds.has(childIds[index])) childIds.splice(index, 1);
      }
    },
    get childIds() {
      return childIds;
    },
    flavour: "myoxus:mermaid",
    id: "mermaid-1",
    props: {
      childElementIds: Object.fromEntries(childIds.map((id) => [id, true])),
      diagramType: visualModel.diagramType,
      // Occurrence-owned cold reads need the same persisted bindings as the real owner.
      familyData:
        visualModel.diagramType === "gitGraph" ||
        visualModel.diagramType === "mindmap"
          ? serializeMermaidVisualFamilyData(visualModel.familyData)
          : undefined,
      source: sourceText,
      sourceHash: parsed.sourceHash,
      title: mutableText("Flow"),
    },
    surface: {
      getElementById: (id: string) => elements.get(id) ?? null,
      store: {
        getModelById: (id: string) => elements.get(id) ?? null,
      },
    },
    yBlock: yMapFromRecord({}),
    xywh: ownerBound.serialize(),
  } as unknown as MermaidBlockModel;
  let nextElementIndex = 1;
  const workspace = { docs: new Map() };
  const std = {
    command: { exec: () => [false, null] },
    get: () => ({
      addElement: (
        type: "connector" | "shape",
        props: Record<string, unknown>,
      ) => {
        const id = `${type}-new-${nextElementIndex++}`;
        elements.set(
          id,
          withElementBound({
            ...props,
            groups: [],
            id,
            type,
            yMap: meta(props),
          }),
        );
        return id;
      },
      removeElement: (id: string) => {
        elements.delete(id);
      },
    }),
    selection: {
      clear: () => undefined,
      create: (_selection: unknown, payload: unknown) => payload,
      set: () => undefined,
    },
    store: {
      captureSync: () => undefined,
      getBlock: (id: string) => {
        if (id === "mermaid-1") return { model: mermaidBlock };
        return null;
      },
      getBlocksByFlavour: (flavour: string) => {
        if (flavour === "myoxus:mermaid") return [{ model: mermaidBlock }];
        if (flavour === "myoxus:surface") return [{ model: { id: "surface" } }];
        return [];
      },
      getModelById: (id: string) => elements.get(id) ?? null,
      getParent: () => ({ flavour: "myoxus:surface", id: "surface" }),
      id: "doc-1",
      readonly: false,
      transact: (fn: () => void) => fn(),
      workspace,
    },
    workspace,
  } as unknown as BlockStdScope;
  Object.assign(mermaidBlock, { store: std.store });
  return {
    childIds,
    elements,
    owner: mermaidBlock,
    mermaidBlock,
    setSource: (nextSource: string) => {
      sourceText.delete();
      sourceText.insert(nextSource);
    },
    std,
    source: () => sourceText.toString(),
  };
}

function renderTestFamilyEditor(
  token: { readonly id: string },
  props:
    | MermaidTreemapReactHostProps
    | MermaidJourneyReactHostProps
    | MermaidKanbanReactHostProps
    | MermaidPacketReactHostProps
    | MermaidPieReactHostProps
    | MermaidSankeyReactHostProps
    | MermaidTimelineReactHostProps,
) {
  if (token.id === "pie") {
    const pie = props as MermaidPieReactHostProps;
    return html`<div
      data-testid="mermaid-pie-view"
      data-diagram-type="pie"
      data-readonly=${pie.readonly ? "true" : "false"}
    ></div>`;
  }
  if (token.id === "treemap") {
    const chart = props as MermaidTreemapReactHostProps;
    return html`<div
      class="myoxus-mermaid-chart-editor"
      data-diagram-type=${chart.model.diagramType}
      data-readonly=${chart.readonly ? "true" : "false"}
    ></div>`;
  }
  if (token.id === "sankey") {
    const sankey = props as MermaidSankeyReactHostProps;
    return html`<div
      data-testid="mermaid-sankey-view"
      data-diagram-type="sankey"
      data-readonly=${sankey.readonly ? "true" : "false"}
    ></div>`;
  }
  if (token.id === "journey") {
    const journey = props as MermaidJourneyReactHostProps;
    return html`<div
      class="myoxus-mermaid-journey-editor"
      data-readonly=${journey.readonly ? "true" : "false"}
    ></div>`;
  }
  if (token.id === "kanban") {
    const kanban = props as MermaidKanbanReactHostProps;
    return html`<div
      class="myoxus-mermaid-kanban-editor"
      data-readonly=${kanban.readonly ? "true" : "false"}
    ></div>`;
  }
  if (token.id === "packet") {
    const packet = props as MermaidPacketReactHostProps;
    return html`<div
      class="myoxus-mermaid-packet-editor"
      data-readonly=${packet.readonly ? "true" : "false"}
    ></div>`;
  }
  const temporal = props as MermaidTimelineReactHostProps;
  return html`<div
    class="myoxus-mermaid-temporal-editor"
    data-diagram-type=${temporal.model.diagramType}
    data-readonly=${temporal.readonly ? "true" : "false"}
  ></div>`;
}

export function renderVisualEditorForSource(source: string, readonly = false) {
  const host = document.createElement("div");
  const pageViewportState = createMermaidPageViewportState();
  const prototype = MermaidBlockComponent.prototype as unknown as {
    _renderClassEditor: (model: unknown) => unknown;
    _renderC4Editor: (model: unknown) => unknown;
    _renderErEditor: (model: unknown) => unknown;
    _renderArchitectureEditor: (model: unknown) => unknown;
    _renderBlockDiagramEditor: (model: unknown) => unknown;
    _renderRequirementEditor: (model: unknown) => unknown;
    _renderStateEditor: (model: unknown) => unknown;
    _renderVisualNode: (node: unknown) => unknown;
    _renderGfxEditor: (model: unknown) => unknown;
    _renderTemporalEditor: (model: unknown) => unknown;
    _renderKanbanEditor: (model: unknown) => unknown;
  };
  const component = {
    _cancelPageSelectionMode: () => undefined,
    _clearPendingVisualSelectionProjection: () => undefined,
    _clearVisualSelectionState: () => undefined,
    blockId: "mermaid-test",
    model: {
      id: "mermaid-test",
      props: {
        source,
      },
      yBlock: yMapFromRecord({}),
    },
    requestUpdate: () => undefined,
    _renderArchitectureEditor: prototype._renderArchitectureEditor,
    _renderBlockDiagramEditor: prototype._renderBlockDiagramEditor,
    _renderC4Editor: prototype._renderC4Editor,
    _renderClassEditor: prototype._renderClassEditor,
    _renderErEditor: prototype._renderErEditor,
    _renderRequirementEditor: prototype._renderRequirementEditor,
    _renderStateEditor: prototype._renderStateEditor,
    _renderVisualNode: prototype._renderVisualNode,
    _renderGfxEditor: (model: { diagramType?: string }) =>
      renderFakeFlowchartGfxEditor(readonly, {
        diagramType: model?.diagramType,
      }),
    _renderCapabilities: (
      capabilities: MermaidEditorCapabilities,
      displayOnly = false,
    ) =>
      capabilities.project(
        {
          commitSource: () => undefined,
          getSource: () => source,
          getActionTarget: () => null,
          getHeaderActionTarget: () => null,
          getPageViewport: () => testPageViewportProjection(pageViewportState),
          getSelectionAction: () => null,
          getReactHost: () =>
            ({
              renderFamilyEditor: renderTestFamilyEditor,
            }) as never,
          getReadonly: () => readonly,
          getSessionState: () => undefined,
          getTransientState: () => undefined,
          openSource: () => undefined,
          renderGfx: (model) => ({
            actions: null,
            body: renderFakeFlowchartGfxEditor(readonly || displayOnly, {
              displayOnly,
              diagramType: model.diagramType,
            }),
          }),
          renderSourceFirst: () => html`<div role="status"></div>`,
          setSelectionAction: () => undefined,
          setSessionState: () => undefined,
          setTitlePresentationPreview: () => undefined,
          setTransientState: () => undefined,
        },
        displayOnly,
      ),
    _renderTemporalEditor: (resolution: { diagramType?: string }) =>
      html`<div
        class="myoxus-mermaid-temporal-editor"
        data-diagram-type=${resolution.diagramType ?? ""}
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _renderKanbanEditor: () =>
      html`<div
        class="myoxus-mermaid-kanban-editor"
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _renderChartEditor: (resolution: { diagramType?: string }) =>
      html`<div
        class="myoxus-mermaid-chart-editor"
        data-diagram-type=${resolution.diagramType ?? ""}
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _renderJourneyFacadeEditor: () =>
      html`<div
        class="myoxus-mermaid-journey-editor"
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _renderPacketFacadeEditor: () =>
      html`<div
        class="myoxus-mermaid-packet-editor"
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _getMermaidVisualModelForEditing() {
      return getMermaidVisualModelForEditing(
        {
          store: (this as { store: unknown }).store,
          workspace: { docs: new Map() },
        } as never,
        (this as { model: unknown }).model as never,
      );
    },
    _handleStartClassConnection: () => undefined,
    _handleStartC4Connection: () => undefined,
    _handleStartArchitectureConnection: () => undefined,
    _handleStartBlockDiagramConnection: () => undefined,
    _handleStartErConnection: () => undefined,
    _handleStartGanttConnection: () => undefined,
    _handleStartGitConnection: () => undefined,
    _handleStartRequirementConnection: () => undefined,
    _handleStartSequenceConnection: () => undefined,
    _handleStartStateConnection: () => undefined,
    _isConnectingClassNodes: false,
    _isConnectingC4Elements: false,
    _isConnectingArchitectureServices: false,
    _isConnectingBlockDiagramNodes: false,
    _isConnectingErEntities: false,
    _isConnectingGanttTasks: false,
    _isConnectingGitCommits: false,
    _isConnectingRequirementCards: false,
    _isConnectingSequenceParticipants: false,
    _isConnectingStateNodes: false,
    _selectedVisualNodeId: "A",
    _stopEditorEvent: (event: Event) => event.stopPropagation(),
    store: {
      getBlock: () => null,
      getParent: () => null,
      readonly,
    },
  };
  Object.assign(component.model, { store: component.store });
  const template = (
    MermaidBlockComponent.prototype as unknown as {
      _renderVisualEditor: (
        state: ReturnType<typeof resolveMermaidHostResolution>,
      ) => MermaidEditorShellProjection;
    }
  )._renderVisualEditor.call(
    component,
    resolveMermaidHostResolution(
      resolveMermaidFamilyRuntime(
        source,
        component._getMermaidVisualModelForEditing(),
      ),
    ),
  );

  render(template.body as never, host);
  return host;
}

export function renderBlockForSource({
  displayMode = "edit",
  mode = "visual",
  readonly = false,
  source,
  viewportHeight = null,
}: {
  displayMode?: "display" | "edit";
  mode?: "source" | "visual";
  readonly?: boolean;
  source: string;
  viewportHeight?: number | null;
}) {
  const host = document.createElement("div");
  const pageViewportState = createMermaidPageViewportState();
  const prototype = MermaidBlockComponent.prototype as unknown as {
    _getPreviewNotice: () => MermaidShellNoticeReactHostProps | undefined;
    _getDisplayMode: () => "display" | "edit";
    _getVisualViewportHeight: (autoHeight: number) => number;
    _getEditableEventTarget: (event: Event) => HTMLElement | null;
    _handleBlockKeydown: (event: KeyboardEvent) => void;
    _renderViewBody: (options: unknown) => unknown;
    _renderPreview: () => unknown;
    _renderVisualEditor: () => unknown;
    _renderVisualNode: (node: unknown) => unknown;
    _renderGfxEditor: (
      model: unknown,
      options?: { displayOnly?: boolean },
    ) => unknown;
    _updatePageSelectionAvailability: (options: {
      enabled: boolean;
      preserveSelection: boolean;
      preserveTool: boolean;
    }) => void;
  };
  const component = {
    _handleBlankDiagram: () => undefined,
    _handleBlockKeydown: prototype._handleBlockKeydown,
    _handleDeleteVisualSelection: () => undefined,
    _handleEdgeStyleChange: () => undefined,
    _handleFileImport: () => undefined,
    _handleImportClick: () => undefined,
    _handleLayoutChange: () => undefined,
    _handlePaletteChange: () => undefined,
    _handlePasteSource: () => undefined,
    _handleSelect: () => undefined,
    _handleSourceEdit: () => undefined,
    _handleStartClassConnection: () => undefined,
    _handleStartC4Connection: () => undefined,
    _handleStartArchitectureConnection: () => undefined,
    _handleStartBlockDiagramConnection: () => undefined,
    _handleStartErConnection: () => undefined,
    _handleStartGanttConnection: () => undefined,
    _handleStartGitConnection: () => undefined,
    _handleStartRequirementConnection: () => undefined,
    _handleStartVisualConnection: () => undefined,
    _handleStartSequenceConnection: () => undefined,
    _handleStartStateConnection: () => undefined,
    _handleTemplateChange: () => undefined,
    _handleTitleChange: () => undefined,
    _handleVisualEdgeStyle: () => undefined,
    _handleVisualNodePointerDown: () => undefined,
    _handleVisualNodeResizePointerDown: () => undefined,
    _handleVisualShapeButton: () => undefined,
    _canExploreReadonly: () => false,
    _getDisplayMode: prototype._getDisplayMode,
    _getEditableEventTarget: prototype._getEditableEventTarget,
    _getPageSelectionProjection: () => null,
    _getVisualViewportHeight: prototype._getVisualViewportHeight,
    _getMermaidVisualModelForEditing() {
      return getMermaidVisualModelForEditing(
        {
          store: (this as { store: unknown }).store,
          workspace: { docs: new Map() },
        } as never,
        (this as { model: unknown }).model as never,
      );
    },
    _isConnectingClassNodes: false,
    _isConnectingC4Elements: false,
    _isConnectingArchitectureServices: false,
    _isConnectingBlockDiagramNodes: false,
    _isConnectingErEntities: false,
    _isConnectingGanttTasks: false,
    _isConnectingGitCommits: false,
    _isConnectingRequirementCards: false,
    _isConnectingSequenceParticipants: false,
    _isConnectingStateNodes: false,
    _isConnectingVisualNodes: false,
    _moveSelectedVisualNode: () => undefined,
    _pageSelectionEnabled: false,
    _pageSelectionState: createMermaidPageSelectionState(),
    _getPreviewNotice: prototype._getPreviewNotice,
    _renderViewBody: prototype._renderViewBody,
    _renderCapabilities: (
      capabilities: MermaidEditorCapabilities,
      displayOnly = false,
    ) =>
      capabilities.project(
        {
          commitSource: () => undefined,
          getSource: () => source,
          getActionTarget: () => null,
          getHeaderActionTarget: () => null,
          getPageViewport: () =>
            testPageViewportProjection(
              pageViewportState,
              displayOnly ? "view" : "visual",
            ),
          getSelectionAction: () => null,
          getReactHost: () =>
            ({
              renderFamilyEditor: renderTestFamilyEditor,
            }) as never,
          getReadonly: () => readonly,
          getSessionState: () => undefined,
          getTransientState: () => undefined,
          openSource: () => undefined,
          renderGfx: (model, options) => ({
            actions: null,
            body: renderFakeFlowchartGfxEditor(
              readonly || options.displayOnly,
              {
                ...options,
                diagramType: model.diagramType,
              },
            ),
          }),
          renderSourceFirst: () => html`<div role="status"></div>`,
          setSelectionAction: () => undefined,
          setSessionState: () => undefined,
          setTitlePresentationPreview: () => undefined,
          setTransientState: () => undefined,
        },
        displayOnly,
      ),
    _renderPreview: prototype._renderPreview,
    _renderVisualEditor: prototype._renderVisualEditor,
    _renderKanbanEditor: () =>
      html`<div
        class="myoxus-mermaid-kanban-editor"
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _renderTemporalEditor: () =>
      html`<div
        class="myoxus-mermaid-temporal-editor"
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _renderJourneyFacadeEditor: () =>
      html`<div
        class="myoxus-mermaid-journey-editor"
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _renderPacketFacadeEditor: () =>
      html`<div
        class="myoxus-mermaid-packet-editor"
        data-readonly=${readonly ? "true" : "false"}
      ></div>`,
    _renderVisualNode: prototype._renderVisualNode,
    _renderGfxEditor: (model: unknown, options?: { displayOnly?: boolean }) =>
      renderFakeFlowchartGfxEditor(readonly, {
        ...options,
        diagramType:
          (model as { diagramType?: string } | null)?.diagramType ??
          "flowchart",
      }),
    _scheduleRender: () => undefined,
    _setShellMode: () => undefined,
    _stopEditorEvent: (event: Event) => event.stopPropagation(),
    _stopTransientPointerInteractions: () => undefined,
    _updatePageSelectionAvailability:
      prototype._updatePageSelectionAvailability,
    _visualSelection: { items: [] },
    requestUpdate: () => undefined,
  } as unknown as {
    _mode: "source" | "visual";
    _renderState: string;
    _visualRedoStack: MermaidVisualHistoryEntry[];
    _visualUndoStack: MermaidVisualHistoryEntry[];
    _selectedVisualEdgeId: string;
    _selectedVisualNodeId: string;
    _svg: string;
    blockId: string;
    model: {
      props: {
        displayMode: "display" | "edit";
        source: string;
        viewportHeight: number | null;
      };
    };
    selected$: { value: boolean };
    store: {
      canRedo: boolean;
      canUndo: boolean;
      readonly: boolean;
      redo: () => void;
      undo: () => void;
    };
  };
  Object.assign(component, {
    _mode: mode,
    _pageViewportState: pageViewportState,
    _renderState: "empty",
    _selectedVisualEdgeId: "",
    _selectedVisualNodeId: "",
    _svg: "",
    _visualRedoStack: [],
    _visualUndoStack: [],
    blockId: "mermaid-test",
    model: {
      id: "mermaid-test",
      props: {
        displayMode,
        source,
        viewportHeight,
      },
      yBlock: yMapFromRecord({}),
    },
    selected$: { value: false },
    store: {
      canRedo: true,
      canUndo: true,
      getBlock: () => null,
      getParent: () => null,
      readonly,
      redo: () => undefined,
      undo: () => undefined,
    },
    std: {
      get: () => ({}),
      getOptional: () => ({
        renderBlockShell: (props: MermaidBlockShellReactHostProps) => html`
          <section
            data-display-mode=${displayMode}
            data-myoxus-ui-role="mermaid-block-shell"
          >
            <header data-myoxus-ui-role="mermaid-editor-shell-header">
              <input
                aria-label="Diagram title"
                data-myoxus-ui-role="mermaid-shell-title"
                ?disabled=${props.readonly}
              />
              <div data-myoxus-ui-role="mermaid-editor-mode-control">
                ${
                  props.showView
                    ? html`<button type="button">${props.labels.view}</button>`
                    : null
                }
                ${
                  props.sourceFirst
                    ? null
                    : html`<button type="button">
                        ${props.labels.visual}
                      </button>`
                }
                <button type="button">${props.labels.source}</button>
              </div>
            </header>
            ${props.actions} ${props.bodyNotice?.message ?? ""}
            ${
              props.mode === "source" || props.sourceFirst
                ? html`<div
                    data-editor-surface=${
                      props.sourceFirst ? "source-first" : "source"
                    }
                  >
                    ${props.sourceFirst ? props.body : null}
                    <textarea
                      class="myoxus-mermaid-source"
                      ?disabled=${props.readonly}
                      .value=${props.source}
                    ></textarea>
                    ${
                      props.sourceFirst
                        ? html`<div class="myoxus-mermaid-preview">
                            ${props.sourcePreview}
                          </div>`
                        : null
                    }
                  </div>`
                : props.body
            }
          </section>
        `,
        renderShellNotice: (props: {
          actions?: ReadonlyArray<{
            disabled?: boolean;
            id: string;
            label: string;
            onSelect: () => void;
          }>;
          message: string;
          title: string;
          tone: "error" | "warning";
        }) =>
          html`<div role=${props.tone === "error" ? "alert" : "status"}>
            <strong>${props.title}</strong>
            <span>${props.message}</span>
            ${props.actions?.map(
              (action) =>
                html`<button
                  ?disabled=${action.disabled}
                  type="button"
                  @click=${action.onSelect}
                >
                  ${action.label}
                </button>`,
            )}
          </div>`,
      }),
    },
  });
  Object.assign(component.model, { store: component.store });

  render(MermaidBlockComponent.prototype.renderBlock.call(component), host);
  return host;
}

export const MERMAID_11_DIAGRAM_FIXTURES: ReadonlyArray<{
  readonly diagramType: ReturnType<typeof detectMermaidDiagramType>;
  readonly source: string;
}> = [
  { diagramType: "c4", source: 'C4Context\n  Person(user, "User")\n' },
  {
    diagramType: "architecture",
    source:
      'architecture-beta\n  group api(cloud)[API]\n  service web(server)[Web] in api\n  service db(database)[DB] in api\n  web:R -["reads"]- L:db\n',
  },
  { diagramType: "block", source: "block-beta\n  A --> B\n" },
  { diagramType: "classDiagram", source: "classDiagram\n  class Foo\n" },
  { diagramType: "classDiagram-v2", source: "classDiagram-v2\n  class Foo\n" },
  {
    diagramType: "erDiagram",
    source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
  },
  { diagramType: "flowchart", source: "flowchart TD\n  A --> B\n" },
  { diagramType: "flowchart-elk", source: "flowchart-elk TD\n  A --> B\n" },
  { diagramType: "flowchart", source: "graph TD\n  A --> B\n" },
  {
    diagramType: "gantt",
    source:
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Task :a1, 2026-01-01, 1d\n",
  },
  { diagramType: "gitGraph", source: 'gitGraph\n  commit id:"A"\n' },
  {
    diagramType: "journey",
    source: "journey\n  section Use\n    Start: 5: User\n",
  },
  { diagramType: "kanban", source: "kanban\n  todo[To Do]\n    t1[Task]\n" },
  { diagramType: "mindmap", source: "mindmap\n  root((Root))\n    Child\n" },
  { diagramType: "packet", source: 'packet\n  0-3: "Version"\n' },
  { diagramType: "pie", source: 'pie\n  "A" : 1\n' },
  {
    diagramType: "quadrantChart",
    source:
      "quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  Item : [0.2, 0.8]\n",
  },
  {
    diagramType: "radar",
    source: "radar-beta\n  axis Speed, Quality\n  curve A {3,4}\n",
  },
  {
    diagramType: "requirementDiagram",
    source: "requirementDiagram\n  requirement req1 {\n    id: 1\n  }\n",
  },
  { diagramType: "sankey", source: "sankey\n  A, B, 1\n" },
  {
    diagramType: "sequenceDiagram",
    source: "sequenceDiagram\n  Alice->>Bob: Hi\n",
  },
  { diagramType: "stateDiagram", source: "stateDiagram\n  [*] --> A\n" },
  { diagramType: "stateDiagram-v2", source: "stateDiagram-v2\n  [*] --> A\n" },
  { diagramType: "timeline", source: "timeline\n  2026 : Launch\n" },
  { diagramType: "treemap", source: 'treemap-beta\n"Root"\n  "A": 1\n' },
  {
    diagramType: "xychart",
    source:
      'xychart-beta\ntitle "Sales"\nx-axis [jan, feb]\ny-axis "Revenue" 0 --> 10\nbar [1, 2]\n',
  },
];

export const MERMAID_CHART_FACADE_TYPES = new Set([
  "pie",
  "quadrantChart",
  "radar",
  "sankey",
  "treemap",
  "xychart",
]);

export function isMermaidChartFacadeType(diagramType: string) {
  return MERMAID_CHART_FACADE_TYPES.has(diagramType);
}

export {
  addErRelationship,
  editErRelationship,
  applyGanttCommand,
  parseMermaidGanttSource,
  Bound,
  ConnectorLabelOffsetAnchor,
  ConnectorMode,
  DEFAULT_MERMAID_FLOWCHART_SOURCE,
  DEFAULT_MERMAID_FONT_FAMILY,
  FeatureFlagService,
  getMermaidEdgelessToolbarTemplates,
  MERMAID_FLOWCHART_SUBGRAPH_ROLE,
  MERMAID_PRODUCT_DIAGRAM_SPECS,
  MERMAID_PRODUCT_DIAGRAM_TYPES,
  MERMAID_PRODUCT_TEMPLATES,
  MERMAID_GFX_DETAIL_ROLE,
  MermaidBlockComponent,
  MermaidBlockSchema,
  addMermaidArchitectureEdge,
  addMermaidBlockDiagramEdge,
  addMermaidC4Relationship,
  addMermaidGfxEdgeCommand,
  addMermaidRequirementRelation,
  addMermaidSequenceMessage,
  addStateTransition,
  addMermaidVisualNode,
  addMermaidVisualSubgraph,
  applyMermaidGfxEdgeCommand,
  applyMermaidGfxNodeCommand,
  applyMermaidGfxSubgraphCommand,
  applyMermaidVisualModelCommand,
  canShowMermaidSlashItem,
  codeBlockMarkdownAdapterMatcher,
  connectMermaidVisualNodes,
  createDefaultMermaidVisualModel,
  createMermaidBlockInsertProps,
  createMermaidBlockSnapshot,
  createMermaidElementIndexMaps,
  createMermaidVisualHash,
  createMermaidVisualModelFromGfxElements,
  deleteMermaidVisualSelection,
  describe,
  detectMermaidDiagramType,
  effects,
  ensureMermaidProjectionOwnerCommand,
  existsSync,
  expect,
  generateMermaidArchitectureSource,
  generateMermaidBlockDiagramSource,
  generateMermaidC4Source,
  generateMermaidClassSource,
  generateMermaidErSource,
  generateMermaidGitGraphSource,
  generateMermaidJourneySource,
  generateMermaidKanbanSource,
  applyKanbanCommand,
  generateMermaidMindmapSource,
  generateMermaidRequirementSource,
  generateMermaidSequenceSource,
  generateMermaidSourceFromGfxVisualModel,
  generateMermaidSourceFromVisualModel,
  getMermaidBlockSource,
  getMermaidBlockTitle,
  getMermaidGfxShapePalette,
  getMermaidVisualModelForEditing,
  getMermaidVisualFrameGeometry,
  getMermaidVisualElementOriginFromAnchor,
  getMermaidVisualNodeDetailElementEntries,
  getMermaidVisualHistoryStacks,
  hashMermaidSource,
  html,
  insertMermaidBlockCommand,
  insertMermaidEdgelessDiagramCommand,
  insertMermaidEdgelessToolbarTemplate,
  internalPrimitives,
  isMermaidFamilyVisualEditingDiagramType,
  isMermaidGraphGfxDiagramType,
  isMermaidMarkdownCodeNode,
  isMermaidProductDiagramType,
  mermaidBlockMarkdownAdapterMatcher,
  mermaidMessages,
  mermaidSlashMenuConfig,
  moveMermaidJourneyStepToSection,
  moveMermaidVisualNode,
  normalizeMermaidSourceInput,
  parseMermaidArchitectureSource,
  parseMermaidBlockDiagramSource,
  parseMermaidC4Source,
  parseMermaidClassSource,
  parseMermaidErSource,
  parseMermaidGitGraphSource,
  parseMermaidJourneySource,
  parseMermaidKanbanSource,
  parseMermaidMindmapSource,
  applyPacketCommand,
  parseMermaidPacketSource,
  parseMermaidPieSource,
  parseMermaidRequirementSource,
  parseMermaidSequenceSource,
  parseMermaidSourceToGfxVisualModel,
  parseMermaidSourceToVisualModel,
  parseMermaidStateSource,
  parseMermaidTimelineSource,
  readFileSync,
  reconnectMermaidGfxEdgeCommand,
  reconnectMermaidVisualEdge,
  renameMermaidArchitectureEdge,
  renameMermaidArchitectureService,
  renameMermaidBlockDiagramEdge,
  renameMermaidBlockDiagramNode,
  renameMermaidC4Element,
  renameMermaidC4Relationship,
  renameMermaidJourneySection,
  renameMermaidJourneyStep,
  renameMermaidMindmapNode,
  renameMermaidRequirementRelation,
  renameMermaidSequenceMessage,
  renameMermaidSequenceParticipant,
  setStateHeading,
  editStateTransition,
  renameMermaidVisualEdge,
  renameMermaidVisualSubgraph,
  render,
  resizeMermaidVisualNode,
  resizeMermaidVisualSubgraph,
  resolveMermaidConnectorLabelXYWH,
  resolveMermaidFamilyRuntime,
  resolveMermaidGfxEdgeEndpointPositions,
  setMermaidBlockText,
  setMermaidI18nTranslator,
  setMermaidJourneyStepActors,
  setMermaidJourneyStepScore,
  setMermaidMindmapNodeShape,
  setMermaidRequirementRisk,
  setMermaidVisualEdgeC4Relationship,
  setMermaidVisualEdgeLinkType,
  setMermaidVisualEdgeRequirementRelationKind,
  setMermaidVisualEdgeStyle,
  setMermaidVisualEdgeStyleStatement,
  setMermaidVisualNodeShape,
  setMermaidVisualNodeStyleClass,
  setMermaidVisualSubgraphDirection,
  syncMermaidVisualModelFromProjectionOwnerCommand,
  test,
  toMermaidConnectorElementProps,
  toMermaidNodeDetailElementProps,
  toMermaidShapeElementProps,
  toMermaidSubgraphElementProps,
  typeOwnedMermaidEdgeElementProjection,
  typeOwnedMermaidNodeDetailElementProjection,
  typeOwnedMermaidNodeElementProjection,
  typeOwnedMermaidSubgraphElementProjection,
};
export type {
  BlockStdScope,
  MermaidBlockModel,
  MermaidVisualModel,
  SlashMenuContext,
};
