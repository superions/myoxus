import { describe, expect, test } from "vitest";

import {
  isMermaidGfxButtonTarget,
  isMermaidGfxInterfaceControlEventPath,
  isMermaidGfxNativeControlEventPath,
  isMermaidGfxNativeControlTarget,
  resolveMermaidGfxViewportSelectionIntent,
  shouldIgnoreMermaidGfxViewportClick,
  shouldIgnoreMermaidGfxViewportContextMenu,
  shouldIgnoreMermaidGfxViewportDoubleClick,
  shouldIgnoreMermaidGfxViewportPointerDown,
} from "../mermaid-gfx-events.js";
import {
  MermaidGfxViewportInteractionController,
  type MermaidGfxViewportInteractionHost,
} from "../mermaid-gfx-viewport-interaction-controller.js";

function divWithClass(className: string) {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function viewportPointerEvent({
  button = 0,
  clientX = 120,
  clientY = 80,
  ctrlKey = false,
  detail = 1,
  metaKey = false,
  path,
  shiftKey = false,
  target = document.createElement("div"),
  timeStamp = 100,
}: {
  button?: number;
  clientX?: number;
  clientY?: number;
  ctrlKey?: boolean;
  detail?: number;
  metaKey?: boolean;
  path?: unknown[];
  shiftKey?: boolean;
  target?: HTMLElement;
  timeStamp?: number;
} = {}) {
  const calls = {
    preventDefault: 0,
    stopImmediatePropagation: 0,
    stopPropagation: 0,
  };
  const event = {
    button,
    clientX,
    clientY,
    ctrlKey,
    detail,
    metaKey,
    shiftKey,
    target,
    timeStamp,
    composedPath: () => path ?? [target],
    preventDefault: () => {
      calls.preventDefault += 1;
    },
    stopPropagation: () => {
      calls.stopPropagation += 1;
    },
    stopImmediatePropagation: () => {
      calls.stopImmediatePropagation += 1;
    },
  } as unknown as PointerEvent;
  return { calls, event };
}

function viewportInteractionHarness({
  consumeNodeDragStart,
  consumeObjectIntent,
  edgeId = "",
  headerSubgraphId = "",
  nodeModel = null,
  nodeId = "A",
  pendingShape = null,
  selectionHandled = false,
  subgraphId = "",
}: {
  consumeNodeDragStart?: MermaidGfxViewportInteractionHost["consumeNodeDragStart"];
  consumeObjectIntent?: MermaidGfxViewportInteractionHost["consumeObjectIntent"];
  edgeId?: string | ((x: number, y: number) => string);
  headerSubgraphId?: string;
  nodeModel?: unknown;
  nodeId?: string | ((clientX: number, clientY: number) => string);
  pendingShape?: MermaidGfxViewportInteractionHost["getPendingVisualInsertShape"] extends () => infer T
    ? T
    : never;
  selectionHandled?: boolean;
  subgraphId?: string;
} = {}) {
  const calls = {
    cleared: 0,
    focused: 0,
    inserted: [] as string[],
    inlineEdges: [] as string[],
    inlineNodeModels: [] as unknown[],
    inlineNodes: [] as string[],
    selectedEdges: [] as string[],
    selectedNodes: [] as Array<{ additive?: boolean; nodeId: string }>,
    selectedSubgraphs: [] as string[],
  };
  const viewport = document.createElement("div");
  viewport.focus = () => {
    calls.focused += 1;
  };
  viewport.getBoundingClientRect = () =>
    ({
      bottom: 1_000,
      height: 1_000,
      left: 0,
      right: 1_000,
      toJSON: () => ({}),
      top: 0,
      width: 1_000,
      x: 0,
      y: 0,
    }) as DOMRect;
  const host: MermaidGfxViewportInteractionHost = {
    consumeNodeDragStart,
    consumeObjectIntent,
    canConsumeViewportEvent: () => true,
    captureViewport: () => ({
      center: [0, 0],
      mode: "visual",
      position: { scrollLeft: 0, scrollTop: 0 },
      zoom: 1,
    }),
    clearVisualSelection: () => {
      calls.cleared += 1;
    },
    panViewportNearClientPoint: () => null,
    findVisualEdgeByModelPoint: (x, y) =>
      typeof edgeId === "function" ? edgeId(x, y) : edgeId,
    findVisualNodeByClientPoint: (clientX, clientY) =>
      typeof nodeId === "function" ? nodeId(clientX, clientY) : nodeId,
    findVisualNodeModelByClientPoint: () => nodeModel,
    findVisualSubgraphByModelPoint: () => subgraphId,
    findVisualSubgraphHeaderByModelPoint: () => headerSubgraphId,
    getExplicitVisualNodeOrder: () => [],
    getPendingVisualInsertShape: () => pendingShape,
    getPageSelectionTool: () => "pointer",
    getScopedGfxViewport: () => viewport,
    getScopedModelDeltaFromClient: (dx, dy) => ({ dx, dy }),
    getScopedModelPointFromClient: () => ({ x: 10, y: 20 }),
    getSelectedVisualEdgeId: () => calls.selectedEdges.at(-1) ?? "",
    getSelectedVisualNodeId: () => calls.selectedNodes.at(-1)?.nodeId ?? "",
    getSelectedVisualNodeOrder: () =>
      calls.selectedNodes.at(-1)?.nodeId
        ? [calls.selectedNodes.at(-1)!.nodeId]
        : [],
    insertPendingVisualNode: () => {
      calls.inserted.push("N1");
      return "N1";
    },
    isConnectingVisualNodes: () => false,
    isEditableEventTarget: () => false,
    isReadonly: () => false,
    moveVisualNode: () => {},
    onVisualNodeDragEnd: () => {},
    previewVisualNodeReparent: () => {},
    requestUpdate: () => {},
    restoreViewport: () => {},
    selectVisualEdge: (nextEdgeId) => {
      calls.selectedEdges.push(nextEdgeId);
    },
    selectVisualNode: (nextNodeId, additive) => {
      calls.selectedNodes.push({ additive, nodeId: nextNodeId });
      return selectionHandled;
    },
    selectVisualSubgraph: (nextSubgraphId) => {
      calls.selectedSubgraphs.push(nextSubgraphId);
    },
    setSelectedVisualNodeOrder: () => {},
    setVisualNodePointerSessionActive: () => {},
    setVisualInspectorSuppressed: () => {},
    setVisualContextMenu: () => {},
    startInlineEdgeTextEdit: (_event, nextEdgeId) => {
      calls.inlineEdges.push(nextEdgeId);
    },
    startInlineNodeTextEdit: (_event, nextNodeId, nextModel) => {
      calls.inlineNodes.push(nextNodeId);
      calls.inlineNodeModels.push(nextModel ?? null);
    },
    startInlineSubgraphTextEdit: () => {},
  };
  const controller = new MermaidGfxViewportInteractionController(host);
  return { calls, controller, viewport };
}

describe("Mermaid GFX viewport event gates", () => {
  test("keeps repeated pointer activation editable when a family owns structural dragging", () => {
    const intents: string[] = [];
    let dragStarts = 0;
    const { controller } = viewportInteractionHarness({
      consumeNodeDragStart: () => {
        dragStarts += 1;
        return true;
      },
      consumeObjectIntent: (_event, intent) => {
        intents.push(intent);
        return true;
      },
    });
    try {
      controller.handleViewportPointerDown(
        viewportPointerEvent({ timeStamp: 100 }).event,
      );
      controller.handleViewportPointerDown(
        viewportPointerEvent({ timeStamp: 200 }).event,
      );
      controller.handleViewportDoubleClick(
        viewportPointerEvent({ detail: 2, timeStamp: 210 }).event,
      );
      expect(dragStarts).toBe(1);
      expect(intents).toEqual(["edit"]);
    } finally {
      controller.stopTransientPointerInteractions();
    }
  });

  test("clears semantic selection when pointer mode clicks free workarea", () => {
    const { calls, controller } = viewportInteractionHarness({ nodeId: "" });
    const click = viewportPointerEvent();

    controller.handleViewportClick(click.event);

    expect(calls.cleared).toBe(1);
    expect(click.calls.preventDefault).toBe(0);
    expect(click.calls.stopPropagation).toBe(0);
    expect(click.calls.stopImmediatePropagation).toBe(0);
  });

  test("recognizes native GFX control targets and paths", () => {
    expect(
      isMermaidGfxNativeControlTarget(
        document.createElement("edgeless-connector-handle"),
      ),
    ).toBe(true);
    expect(isMermaidGfxNativeControlTarget(divWithClass("handle"))).toBe(true);
    expect(
      isMermaidGfxNativeControlTarget(
        divWithClass("myoxus-edgeless-selected-rect"),
      ),
    ).toBe(false);
    expect(isMermaidGfxNativeControlTarget(document.createElement("div"))).toBe(
      false,
    );
    expect(
      isMermaidGfxNativeControlEventPath([
        document.createElement("span"),
        divWithClass("line-controller"),
      ]),
    ).toBe(true);
    expect(isMermaidGfxNativeControlEventPath([{}])).toBe(false);
  });

  test("recognizes nested button targets for viewport event gating", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.append(path);
    button.append(svg);

    expect(isMermaidGfxButtonTarget(button)).toBe(true);
    expect(isMermaidGfxButtonTarget(icon)).toBe(true);
    expect(isMermaidGfxButtonTarget(svg)).toBe(true);
    expect(isMermaidGfxButtonTarget(path)).toBe(true);
    expect(isMermaidGfxButtonTarget(document.createElement("div"))).toBe(false);
    expect(isMermaidGfxButtonTarget({})).toBe(false);
  });

  test("recognizes portalled Facade controls outside the scoped viewport", () => {
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    const facadeRoot = document.createElement("div");
    facadeRoot.setAttribute("data-myoxus-ui-role", "settings-select-root");

    expect(isMermaidGfxInterfaceControlEventPath([option])).toBe(true);
    expect(isMermaidGfxInterfaceControlEventPath([facadeRoot])).toBe(true);
    expect(
      isMermaidGfxInterfaceControlEventPath([document.createElement("div")]),
    ).toBe(false);
  });

  test("click gate ignores native controls, editable targets and buttons only", () => {
    expect(
      shouldIgnoreMermaidGfxViewportClick({
        isButtonTarget: false,
        isEditableTarget: false,
        isNativeControl: false,
      }),
    ).toBe(false);
    expect(
      shouldIgnoreMermaidGfxViewportClick({
        isButtonTarget: true,
        isEditableTarget: false,
        isNativeControl: false,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreMermaidGfxViewportClick({
        isButtonTarget: false,
        isEditableTarget: true,
        isNativeControl: false,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreMermaidGfxViewportClick({
        isButtonTarget: false,
        isEditableTarget: false,
        isNativeControl: true,
      }),
    ).toBe(true);
  });

  test("context menu gate adds readonly but does not depend on native handles", () => {
    expect(
      shouldIgnoreMermaidGfxViewportContextMenu({
        isButtonTarget: false,
        isEditableTarget: false,
        isReadonly: false,
      }),
    ).toBe(false);
    expect(
      shouldIgnoreMermaidGfxViewportContextMenu({
        isButtonTarget: false,
        isEditableTarget: false,
        isReadonly: true,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreMermaidGfxViewportContextMenu({
        isButtonTarget: true,
        isEditableTarget: false,
        isReadonly: false,
      }),
    ).toBe(true);
  });

  test("pointer-down gate blocks readonly, active connect mode and nested controls", () => {
    const base = {
      isButtonTarget: false,
      isConnecting: false,
      isEditableTarget: false,
      isNativeControl: false,
      isReadonly: false,
    };

    expect(shouldIgnoreMermaidGfxViewportPointerDown(base)).toBe(false);
    expect(
      shouldIgnoreMermaidGfxViewportPointerDown({
        ...base,
        isConnecting: true,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreMermaidGfxViewportPointerDown({
        ...base,
        isNativeControl: true,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreMermaidGfxViewportPointerDown({
        ...base,
        isReadonly: true,
      }),
    ).toBe(true);
  });

  test("double-click gate mirrors editable GFX label entry blockers", () => {
    const base = {
      isButtonTarget: false,
      isEditableTarget: false,
      isNativeControl: false,
      isReadonly: false,
    };

    expect(shouldIgnoreMermaidGfxViewportDoubleClick(base)).toBe(false);
    expect(
      shouldIgnoreMermaidGfxViewportDoubleClick({
        ...base,
        isButtonTarget: true,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreMermaidGfxViewportDoubleClick({
        ...base,
        isEditableTarget: true,
      }),
    ).toBe(true);
  });

  test("resolves viewport selection priority once for click and pointer-down paths", () => {
    expect(
      resolveMermaidGfxViewportSelectionIntent({
        edgeId: "edge-A-B",
        headerSubgraphId: "cluster-header",
        nodeId: "A",
        subgraphId: "cluster-body",
      }),
    ).toEqual({ kind: "subgraph", subgraphId: "cluster-header" });
    expect(
      resolveMermaidGfxViewportSelectionIntent({
        edgeId: "edge-A-B",
        headerSubgraphId: "cluster-header",
        subgraphId: "cluster-body",
      }),
    ).toEqual({ kind: "subgraph", subgraphId: "cluster-header" });
    expect(
      resolveMermaidGfxViewportSelectionIntent({
        edgeId: "edge-A-B",
        nodeId: "A",
        subgraphId: "cluster-body",
      }),
    ).toEqual({ edgeId: "edge-A-B", kind: "edge" });
    expect(
      resolveMermaidGfxViewportSelectionIntent({
        edgeId: "edge-A-B",
        subgraphId: "cluster-body",
      }),
    ).toEqual({ edgeId: "edge-A-B", kind: "edge" });
    expect(
      resolveMermaidGfxViewportSelectionIntent({
        subgraphId: "cluster-body",
      }),
    ).toEqual({ kind: "subgraph", subgraphId: "cluster-body" });
    expect(resolveMermaidGfxViewportSelectionIntent({})).toEqual({
      kind: "clear",
    });
  });

  test("selects an unselected node through the click after pointer-down", () => {
    const { calls, controller } = viewportInteractionHarness({ nodeId: "A" });
    const pointerDown = viewportPointerEvent();
    controller.handleViewportPointerDown(pointerDown.event);

    const click = viewportPointerEvent();
    controller.handleViewportClick(click.event);
    controller.stopTransientPointerInteractions();

    // A new semantic selection can remount native chrome and cancel the same
    // pointer gesture. Pointer-down therefore starts the possible drag while
    // the normal click owns selection when no drag occurred.
    expect(calls.selectedNodes.map((call) => call.nodeId)).toEqual(["A"]);
    expect(calls.selectedNodes.map((call) => call.additive)).toEqual([false]);
    expect(calls.cleared).toBe(0);
    expect(click.calls.preventDefault).toBeGreaterThan(0);
    expect(click.calls.stopPropagation).toBeGreaterThan(0);
    expect(click.calls.stopImmediatePropagation).toBeGreaterThan(0);
  });

  test("moves keyboard ownership to the scoped workarea on pointer-down", () => {
    const { calls, controller } = viewportInteractionHarness({
      nodeId: "A",
      selectionHandled: true,
    });

    controller.handleViewportPointerDown(viewportPointerEvent().event);

    expect(calls.focused).toBe(1);
    expect(calls.selectedNodes).toEqual([]);
  });

  test("pins the click fallback to the pointer-down node when selection chrome shifts hit-testing", () => {
    let hits = 0;
    const { calls, controller } = viewportInteractionHarness({
      nodeId: () => (++hits <= 2 ? "A" : "B"),
    });

    controller.handleViewportPointerDown(viewportPointerEvent().event);
    controller.handleViewportClick(viewportPointerEvent().event);
    controller.stopTransientPointerInteractions();

    expect(calls.selectedNodes).toEqual([{ additive: false, nodeId: "A" }]);
  });

  test("ignores document-captured clicks outside the scoped GFX viewport", () => {
    const { calls, controller } = viewportInteractionHarness({ nodeId: "A" });

    controller.handleViewportClick(
      viewportPointerEvent({ clientX: 1_200, clientY: 80 }).event,
    );

    expect(calls.selectedNodes).toEqual([]);
    expect(calls.inlineNodes).toEqual([]);
    expect(calls.cleared).toBe(0);
  });

  test("leaves overlapping portalled Facade and Lit menu actions to their controls", () => {
    const { calls, controller } = viewportInteractionHarness({ nodeId: "A" });
    const option = document.createElement("div");
    option.setAttribute("role", "option");

    const menu = document.createElement("myoxus-menu");
    const row = document.createElement("div");
    menu.append(row);
    for (const path of [[option], [row, menu]]) {
      const pointer = viewportPointerEvent({ path, target: path[0] });
      controller.handleViewportPointerDown(pointer.event);
      controller.handleViewportClick(pointer.event);
      expect(pointer.calls.preventDefault).toBe(0);
      expect(pointer.calls.stopImmediatePropagation).toBe(0);
    }

    expect(calls.selectedNodes).toEqual([]);
    expect(calls.selectedEdges).toEqual([]);
    expect(calls.cleared).toBe(0);
  });

  test("keeps click fallback enabled after pointer-down edge selection", () => {
    const { calls, controller } = viewportInteractionHarness({
      edgeId: "edge-A-B-1",
      nodeId: "",
    });
    const pointerDown = viewportPointerEvent();
    controller.handleViewportPointerDown(pointerDown.event);

    const click = viewportPointerEvent();
    controller.handleViewportClick(click.event);

    expect(calls.selectedEdges).toEqual(["edge-A-B-1", "edge-A-B-1"]);
    expect(calls.cleared).toBe(0);
    expect(click.calls.preventDefault).toBeGreaterThan(0);
    expect(click.calls.stopPropagation).toBeGreaterThan(0);
    expect(click.calls.stopImmediatePropagation).toBeGreaterThan(0);
  });

  test("suppresses the click that follows an externally handled pointer drag", () => {
    const { calls, controller, viewport } = viewportInteractionHarness();

    controller.suppressNextClickSelection();
    // Inline overlays share the viewport's DOM path. A missing release click
    // must not swallow their first later activation or lose drag suppression.
    const marker = document.createElement("button");
    viewport.append(marker);
    const controlClick = viewportPointerEvent({
      path: [marker, viewport],
      target: marker,
    });
    controller.handleViewportClick(controlClick.event);
    expect(controlClick.calls.preventDefault).toBe(0);
    expect(controlClick.calls.stopImmediatePropagation).toBe(0);

    const click = viewportPointerEvent();
    controller.handleViewportClick(click.event);

    expect(calls.cleared).toBe(0);
    expect(calls.selectedNodes).toEqual([]);
    expect(calls.selectedEdges).toEqual([]);
    expect(calls.selectedSubgraphs).toEqual([]);
    expect(click.calls.preventDefault).toBeGreaterThan(0);
    expect(click.calls.stopPropagation).toBeGreaterThan(0);
    expect(click.calls.stopImmediatePropagation).toBeGreaterThan(0);
  });

  test("starts inline edge label editing on edge double-click", () => {
    const { calls, controller } = viewportInteractionHarness({
      edgeId: "edge-A-B-1",
      nodeId: "",
    });

    controller.handleViewportDoubleClick(viewportPointerEvent().event);

    expect(calls.inlineEdges).toEqual(["edge-A-B-1"]);
    expect(calls.inlineNodes).toEqual([]);
  });

  test("starts inline node editing from a second click when nested GFX suppresses dblclick", () => {
    const { calls, controller } = viewportInteractionHarness({ nodeId: "A" });

    controller.handleViewportClick(viewportPointerEvent({ detail: 2 }).event);

    expect(calls.inlineNodes).toEqual(["A"]);
    expect(calls.selectedNodes).toEqual([]);
  });

  test("passes the concrete node hit model into inline node editing", () => {
    const detailModel = { id: "detail-Document-title" };
    const { calls, controller } = viewportInteractionHarness({
      nodeId: "Document",
      nodeModel: detailModel,
    });

    controller.handleViewportDoubleClick(viewportPointerEvent().event);

    expect(calls.inlineNodes).toEqual(["Document"]);
    expect(calls.inlineNodeModels).toEqual([detailModel]);
  });

  test("derives the inline-edit id from the same hit-model snapshot", () => {
    const values = new Map([
      ["mermaidNodeId", "Memory"],
      ["mermaidRole", "mermaid-flowchart-node"],
    ]);
    const memoryModel = {
      type: "shape",
      yMap: { get: (key: string) => values.get(key) },
    };
    const { calls, controller } = viewportInteractionHarness({
      // Models can shift after the first click adds selection chrome. The
      // second lookup deliberately represents the overlapping start marker.
      nodeId: "Active::r1::__start__",
      nodeModel: memoryModel,
    });

    controller.handleViewportDoubleClick(viewportPointerEvent().event);

    expect(calls.inlineNodes).toEqual(["Memory"]);
    expect(calls.inlineNodeModels).toEqual([memoryModel]);
  });

  test("keeps repeated regular node clicks as selection, not label editing", () => {
    const { calls, controller } = viewportInteractionHarness({ nodeId: "A" });

    controller.handleViewportClick(
      viewportPointerEvent({ timeStamp: 100 }).event,
    );
    controller.handleViewportClick(
      viewportPointerEvent({ timeStamp: 220 }).event,
    );

    expect(calls.inlineNodes).toEqual([]);
    expect(calls.selectedNodes).toEqual([
      { additive: false, nodeId: "A" },
      { additive: false, nodeId: "A" },
    ]);
  });

  test("uses the recent pointer-down node hit when selection chrome shifts the double-click model point", () => {
    let nodeHit = "A";
    const { calls, controller } = viewportInteractionHarness({
      nodeId: () => nodeHit,
    });

    controller.handleViewportPointerDown(
      viewportPointerEvent({ timeStamp: 100 }).event,
    );
    expect(
      (
        controller as unknown as {
          _lastViewportPointerTarget?: { nodeId?: string };
        }
      )._lastViewportPointerTarget?.nodeId,
    ).toBe("A");
    nodeHit = "";
    controller.handleViewportPointerDown(
      viewportPointerEvent({ timeStamp: 170 }).event,
    );
    expect(
      (
        controller as unknown as {
          _lastViewportPointerTarget?: { nodeId?: string };
        }
      )._lastViewportPointerTarget?.nodeId,
    ).toBe("A");
    controller.handleViewportDoubleClick(
      viewportPointerEvent({ detail: 2, timeStamp: 180 }).event,
    );

    expect(calls.inlineNodes).toEqual(["A"]);
  });

  test("keeps the first selected node when double-click chrome exposes an overlapping helper", () => {
    let nodeHit = "Memory";
    const values = new Map([
      ["mermaidNodeId", "Memory"],
      ["mermaidRole", "mermaid-flowchart-node"],
    ]);
    const memoryModel = {
      type: "shape",
      yMap: { get: (key: string) => values.get(key) },
    };
    const { calls, controller } = viewportInteractionHarness({
      nodeId: () => nodeHit,
      nodeModel: memoryModel,
    });

    controller.handleViewportPointerDown(
      viewportPointerEvent({ timeStamp: 100 }).event,
    );
    controller.handleViewportClick(
      viewportPointerEvent({ timeStamp: 120 }).event,
    );
    nodeHit = "Active::r1::__start__";
    controller.handleViewportPointerDown(
      viewportPointerEvent({ timeStamp: 170 }).event,
    );
    controller.handleViewportDoubleClick(
      viewportPointerEvent({ detail: 2, timeStamp: 180 }).event,
    );

    expect(calls.selectedNodes.at(0)?.nodeId).toBe("Memory");
    expect(calls.inlineNodes).toEqual(["Memory"]);
    expect(calls.inlineNodeModels).toEqual([memoryModel]);
  });

  test("starts inline edge label editing from a second click when nested GFX suppresses dblclick", () => {
    const { calls, controller } = viewportInteractionHarness({
      edgeId: "edge-A-B-1",
      nodeId: "",
    });

    controller.handleViewportClick(viewportPointerEvent({ detail: 2 }).event);

    expect(calls.inlineEdges).toEqual(["edge-A-B-1"]);
    expect(calls.selectedEdges).toEqual([]);
  });

  test("keeps repeated regular edge clicks as selection, not label editing", () => {
    const { calls, controller } = viewportInteractionHarness({
      edgeId: "edge-A-B-1",
      nodeId: "",
    });

    controller.handleViewportClick(
      viewportPointerEvent({ timeStamp: 100 }).event,
    );
    controller.handleViewportClick(
      viewportPointerEvent({ timeStamp: 220 }).event,
    );

    expect(calls.inlineEdges).toEqual([]);
    expect(calls.selectedEdges).toEqual(["edge-A-B-1", "edge-A-B-1"]);
  });

  test("uses the recent pointer-down edge hit when selection chrome shifts the double-click model point", () => {
    let edgeHit = "edge-A-B-1";
    const { calls, controller } = viewportInteractionHarness({
      edgeId: () => edgeHit,
      nodeId: "",
    });

    controller.handleViewportPointerDown(
      viewportPointerEvent({ timeStamp: 100 }).event,
    );
    expect(
      (
        controller as unknown as {
          _lastViewportPointerTarget?: { edgeId?: string };
        }
      )._lastViewportPointerTarget?.edgeId,
    ).toBe("edge-A-B-1");
    edgeHit = "";
    controller.handleViewportPointerDown(
      viewportPointerEvent({ timeStamp: 170 }).event,
    );
    expect(
      (
        controller as unknown as {
          _lastViewportPointerTarget?: { edgeId?: string };
        }
      )._lastViewportPointerTarget?.edgeId,
    ).toBe("edge-A-B-1");
    controller.handleViewportDoubleClick(
      viewportPointerEvent({ detail: 2, timeStamp: 180 }).event,
    );

    expect(calls.inlineEdges).toEqual(["edge-A-B-1"]);
  });

  test("keeps connector text editing when edge and node text hit tests overlap", () => {
    const { calls, controller } = viewportInteractionHarness({
      edgeId: "edge-A-B-1",
      nodeId: "A",
    });

    controller.handleViewportPointerDown(
      viewportPointerEvent({ timeStamp: 100 }).event,
    );
    controller.handleViewportDoubleClick(
      viewportPointerEvent({ detail: 2, timeStamp: 160 }).event,
    );

    expect(calls.inlineEdges).toEqual(["edge-A-B-1"]);
    expect(calls.inlineNodes).toEqual([]);
  });

  test("uses the selected edge when connector hit testing is displaced by selection chrome", () => {
    const { calls, controller } = viewportInteractionHarness({
      edgeId: "edge-A-B-1",
      nodeId: "",
    });

    controller.handleViewportClick(
      viewportPointerEvent({ timeStamp: 100 }).event,
    );
    const displaced = viewportInteractionHarness({
      edgeId: "",
      nodeId: "",
    });
    displaced.calls.selectedEdges.push("edge-A-B-1");
    displaced.controller.handleViewportDoubleClick(
      viewportPointerEvent({ detail: 2, timeStamp: 180 }).event,
    );

    expect(displaced.calls.inlineEdges).toEqual(["edge-A-B-1"]);
    expect(calls.selectedEdges).toEqual(["edge-A-B-1"]);
  });

  test("suppresses the follow-up click after inserting a pending node", () => {
    const { calls, controller } = viewportInteractionHarness({
      nodeId: "",
      pendingShape: "rect",
    });
    const pointerDown = viewportPointerEvent();
    controller.handleViewportPointerDown(pointerDown.event);

    const click = viewportPointerEvent();
    controller.handleViewportClick(click.event);

    expect(calls.inserted).toEqual(["N1"]);
    expect(calls.selectedNodes.map((call) => call.nodeId)).toEqual(["N1"]);
    expect(calls.cleared).toBe(0);
    expect(click.calls.preventDefault).toBeGreaterThan(0);
    expect(click.calls.stopPropagation).toBeGreaterThan(0);
    expect(click.calls.stopImmediatePropagation).toBeGreaterThan(0);
  });

  test("lets pending node placement win over empty subgraph header hits", () => {
    const { calls, controller } = viewportInteractionHarness({
      headerSubgraphId: "section-new",
      nodeId: "",
      pendingShape: "rect",
      subgraphId: "section-new",
    });

    controller.handleViewportPointerDown(viewportPointerEvent().event);

    expect(calls.inserted).toEqual(["N1"]);
    expect(calls.selectedSubgraphs).toEqual([]);
    expect(calls.selectedNodes.map((call) => call.nodeId)).toEqual(["N1"]);
  });
});
