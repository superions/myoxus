import { html, render } from "lit";
import { describe, expect, test } from "vitest";

import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import {
  filterVisibleMermaidGfxShapes,
  resolveMermaidGfxEditorState,
} from "../../runtime/gfx-editor-state.js";
import {
  renderMermaidGfxEdgeReconnectHandles,
  renderMermaidGfxNodeConnectHandles,
  renderMermaidGfxNodeResizeHandle,
  renderMermaidGfxViewportResizeHandle,
} from "../../runtime/gfx-editor-overlays.js";
import { resolveFlowchartGfxShapeLabel } from "../editor-ui.js";
import { FLOWCHART_NODE_CONNECTION_PORTS } from "../connection-ports.js";

const model: MermaidVisualModel = {
  diagramType: "flowchart",
  direction: "TD",
  edges: [
    {
      id: "edge-A-B",
      label: "approve",
      linkType: "arrow",
      source: "A",
      style: "solid",
      target: "B",
    },
  ],
  nodes: [
    {
      height: 80,
      id: "A",
      label: "Start",
      shape: "stadium",
      width: 140,
      x: 0,
      y: 0,
    },
    {
      height: 88,
      id: "B",
      label: "Decision",
      shape: "diamond",
      width: 150,
      x: 180,
      y: 0,
    },
  ],
  styleStatements: [
    "class B success;",
    "linkStyle 0 stroke:#4f46e5,stroke-width:2px;",
  ],
  subgraphs: [
    {
      height: 180,
      id: "cluster_1",
      nodeIds: ["A", "B"],
      title: "Lane",
      width: 360,
      x: -20,
      y: -30,
    },
  ],
  version: 1,
};

function renderTemplate(template: unknown) {
  const host = document.createElement("div");
  render(template as never, host);
  return host;
}

describe("Flowchart GFX editor helpers", () => {
  test("resolves selected inspector state from visual model and selection ids", () => {
    const state = resolveMermaidGfxEditorState({
      allowExpandedShapePalette: true,
      pendingShape: null,
      selectedEdgeId: "edge-A-B",
      selectedNodeId: "B",
      selectedSubgraphId: "cluster_1",
      showAllShapes: false,
      visualModel: model,
    });

    expect(state.selectedNode?.label).toBe("Decision");
    expect(state.selectedEdge?.label).toBe("approve");
    expect(state.selectedSubgraph?.title).toBe("Lane");
    expect(state.selectedNodeStyleClass).toBe("success");
    expect(state.selectedEdgeStyleStatement).toBe("");
    expect(state.visibleShapes).toContain("diamond");
    expect(state.shapePalette.core).toContain("rect");
  });

  test("preserves pending insert shape in collapsed visible palette", () => {
    expect(
      filterVisibleMermaidGfxShapes(
        ["rect", "cloud"],
        ["rect"],
        false,
        undefined,
        "cloud",
      ),
    ).toEqual(["rect", "cloud"]);
    expect(
      resolveMermaidGfxEditorState({
        allowExpandedShapePalette: true,
        pendingShape: "cloud",
        selectedEdgeId: "",
        selectedNodeId: "",
        selectedSubgraphId: "",
        showAllShapes: false,
        visualModel: model,
      }).visibleShapes,
    ).toContain("cloud");
  });

  test("keeps graph shape labels in the family UI boundary", () => {
    expect(resolveFlowchartGfxShapeLabel("stadium")).toBe("Start or end");
  });

  test("routes each visible Flowchart port and reconnect endpoint to its owning action", () => {
    const noop = () => undefined;
    const actions: string[] = [];
    const host = renderTemplate(html`
      ${renderMermaidGfxNodeConnectHandles({
        disabled: false,
        displayOnly: false,
        handles: FLOWCHART_NODE_CONNECTION_PORTS.map((port, index) => ({
          ...port,
          left: 24 + index * 8,
          top: 32 + index * 8,
        })),
        hasSelectedNode: true,
        onKeydown: noop,
        onPointerDown: (_event, portId) => actions.push(`port:${portId}`),
      })}
      ${renderMermaidGfxNodeResizeHandle({
        disabled: false,
        displayOnly: false,
        handle: { left: 42, top: 52 },
        hasSelectedNode: true,
        onKeydown: noop,
        onPointerDown: noop,
      })}
      ${renderMermaidGfxEdgeReconnectHandles({
        disabled: false,
        displayOnly: false,
        handles: {
          source: { left: 60, top: 70 },
          target: { left: 160, top: 170 },
        },
        hasSelectedEdge: true,
        onKeydown: noop,
        onPointerDown: (_event, endpoint) =>
          actions.push(`endpoint:${endpoint}`),
      })}
      ${renderMermaidGfxViewportResizeHandle({
        disabled: false,
        displayOnly: false,
        onKeydown: noop,
        onPointerDown: noop,
      })}
    `);
    const handles = [
      ...host.querySelectorAll<HTMLButtonElement>(
        ".myoxus-mermaid-gfx-connect-handle, .myoxus-mermaid-gfx-resize-handle, .myoxus-mermaid-gfx-edge-handle, .myoxus-mermaid-viewport-resize-handle",
      ),
    ];

    expect(handles).toHaveLength(8);
    expect(
      handles.every(
        (handle) =>
          handle.type === "button" &&
          !handle.disabled &&
          Boolean(handle.getAttribute("aria-label")) &&
          handle.getAttribute("aria-label") === handle.getAttribute("title"),
      ),
    ).toBe(true);
    const ports = [
      ...host.querySelectorAll<HTMLButtonElement>(
        ".myoxus-mermaid-gfx-connect-handle",
      ),
    ];
    expect(
      ports.map((handle) => ({
        id: handle.dataset.portId,
        position: [handle.dataset.portX, handle.dataset.portY],
      })),
    ).toEqual([
      { id: "north", position: ["0.5", "0"] },
      { id: "east", position: ["1", "0.5"] },
      { id: "south", position: ["0.5", "1"] },
      { id: "west", position: ["0", "0.5"] },
    ]);
    ports[1]?.dispatchEvent(new Event("pointerdown"));
    host
      .querySelector<HTMLButtonElement>(
        ".myoxus-mermaid-gfx-edge-handle[data-endpoint='source']",
      )
      ?.dispatchEvent(new Event("pointerdown"));
    host
      .querySelector<HTMLButtonElement>(
        ".myoxus-mermaid-gfx-edge-handle[data-endpoint='target']",
      )
      ?.dispatchEvent(new Event("pointerdown"));
    expect(actions).toEqual([
      "port:east",
      "endpoint:source",
      "endpoint:target",
    ]);
  });

  test("omits transient edit handles in display-only mode", () => {
    const noop = () => undefined;
    const host = renderTemplate(html`
      ${renderMermaidGfxNodeConnectHandles({
        disabled: false,
        displayOnly: true,
        handles: FLOWCHART_NODE_CONNECTION_PORTS.map((port) => ({
          ...port,
          left: 24,
          top: 32,
        })),
        hasSelectedNode: true,
        onKeydown: noop,
        onPointerDown: noop,
      })}
      ${renderMermaidGfxEdgeReconnectHandles({
        disabled: false,
        displayOnly: true,
        handles: {
          source: { left: 60, top: 70 },
          target: { left: 160, top: 170 },
        },
        hasSelectedEdge: true,
        onKeydown: noop,
        onPointerDown: noop,
      })}
      ${renderMermaidGfxViewportResizeHandle({
        disabled: false,
        displayOnly: true,
        onKeydown: noop,
        onPointerDown: noop,
      })}
    `);

    expect(host.querySelector("button")).toBeNull();
  });
});
