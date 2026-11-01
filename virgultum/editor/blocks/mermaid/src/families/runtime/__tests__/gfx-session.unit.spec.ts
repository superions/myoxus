// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";

import {
  MermaidGfxSessionController,
  type MermaidGfxSessionHost,
} from "../gfx-session.js";

function createSessionHost({
  hoveredNodeId = "B",
  selectedEdgeId = "",
  visualModel = null,
}: {
  hoveredNodeId?: string;
  selectedEdgeId?: string;
  visualModel?: ReturnType<
    MermaidGfxSessionHost["getMermaidVisualModelForEditing"]
  >;
} = {}) {
  const commandExec = vi.fn(() => [true, { edgeId: "edge-A-B" }]);
  const requestUpdate = vi.fn();
  const selectVisualEdge = vi.fn();
  const findVisualNodeByClientPoint = vi.fn(() => hoveredNodeId);
  const getSelectedVisualNodeHandles = vi.fn(() => [
    { id: "north", left: 15, position: [0.5, 0] as const, top: 20 },
  ]);
  const getVisualNodeConnectionHandles = vi.fn((nodeId: string) =>
    nodeId === "A"
      ? [{ id: "north", left: 15, position: [0.5, 0] as const, top: 20 }]
      : [{ id: "west", left: 90, position: [0, 0.5] as const, top: 100 }],
  );
  const host = {
    applyGfxMutation: (run: () => boolean) => run(),
    getMermaidVisualModelForEditing: () => visualModel,
    getModel: () => ({}),
    getSelectedVisualEdgeId: () => selectedEdgeId,
    getSelectedVisualEdgeHandles: () => ({
      source: { left: 15, top: 20 },
      target: { left: 50, top: 60 },
    }),
    getSelectedVisualNodeId: () => "A",
    getSelectedVisualSubgraphId: () => "",
    getStd: () => ({ command: { exec: commandExec } }),
    getScopedViewPointFromClient: (clientX: number, clientY: number) => ({
      left: clientX,
      top: clientY,
    }),
    getSelectedVisualNodeHandles,
    getVisualNodeConnectionHandles,
    findVisualNodeByClientPoint,
    isReadonly: () => false,
    requestUpdate,
    selectVisualEdge,
  } as unknown as MermaidGfxSessionHost;

  return {
    commandExec,
    findVisualNodeByClientPoint,
    getSelectedVisualNodeHandles,
    getVisualNodeConnectionHandles,
    requestUpdate,
    selectVisualEdge,
    session: new MermaidGfxSessionController(host),
  };
}

describe("Mermaid GFX session", () => {
  test("connects the selected source to one chosen target in one command", () => {
    const { commandExec, selectVisualEdge, session } = createSessionHost();
    const addEventListener = vi.spyOn(window, "addEventListener");

    expect(session.startVisualNodeConnection()).toBe(true);
    expect(session.isConnectingVisualNodes).toBe(true);
    expect(addEventListener).toHaveBeenCalledWith(
      "pointermove",
      expect.any(Function),
    );
    expect(session.handleProjectionOwnerNodeSelection("B", "A")).toBe(true);

    expect(commandExec).toHaveBeenCalledTimes(1);
    expect(commandExec).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceNodeId: "A", targetNodeId: "B" }),
    );
    expect(selectVisualEdge).toHaveBeenCalledExactlyOnceWith("edge-A-B");
    expect(session.isConnectingVisualNodes).toBe(false);
  });

  test("previews a toolbar connection from the selected node to the hovered target", () => {
    const {
      findVisualNodeByClientPoint,
      getVisualNodeConnectionHandles,
      requestUpdate,
      session,
    } = createSessionHost();

    expect(session.startVisualNodeConnection()).toBe(true);
    expect(Reflect.get(session, "connectVisualNodeSourceId")).toBe("A");
    Reflect.get(session, "updateVisualNodeConnectionPreview").call(
      session,
      45,
      55,
    );

    expect(findVisualNodeByClientPoint).toHaveBeenCalledExactlyOnceWith(45, 55);
    expect(getVisualNodeConnectionHandles).toHaveBeenCalledWith("A");
    expect(getVisualNodeConnectionHandles).toHaveBeenCalledWith("B");

    expect(session.connectionPreview).toEqual({
      source: { id: "north", left: 15, position: [0.5, 0], top: 20 },
      sourcePortId: "north",
      sourcePosition: [0.5, 0],
      target: { id: "west", left: 90, position: [0, 0.5], top: 100 },
      targetNodeId: "B",
      targetPortId: "west",
      targetPosition: [0, 0.5],
      validTarget: true,
    });
    expect(requestUpdate).toHaveBeenCalled();
    session.stopVisualNodeConnection();
  });

  test("previews reconnecting an edge endpoint to the hovered node", () => {
    const { requestUpdate, session } = createSessionHost({
      hoveredNodeId: "C",
      selectedEdgeId: "edge-A-B",
      visualModel: {
        diagramType: "flowchart",
        edges: [{ id: "edge-A-B", source: "A", target: "B" }],
        nodes: [],
      } as never,
    });

    session.handleVisualEdgeReconnectPointerDown(
      new PointerEvent("pointerdown", { clientX: 50, clientY: 60 }),
      "target",
    );
    Reflect.get(session, "updateVisualEdgeReconnectPreview").call(
      session,
      85,
      95,
    );

    expect(session.connectionPreview).toEqual({
      source: { left: 15, top: 20 },
      target: { id: "west", left: 90, position: [0, 0.5], top: 100 },
      targetNodeId: "C",
      targetPortId: "west",
      targetPosition: [0, 0.5],
      validTarget: true,
    });
    expect(requestUpdate).toHaveBeenCalled();
    Reflect.get(session, "stopVisualEdgeReconnect").call(session);
  });

  test("keeps connection mode active when the selected source is chosen again", () => {
    const { commandExec, session } = createSessionHost();

    expect(session.startVisualNodeConnection()).toBe(true);
    expect(session.handleProjectionOwnerNodeSelection("A", "A")).toBe(false);

    expect(commandExec).not.toHaveBeenCalled();
    expect(session.isConnectingVisualNodes).toBe(true);
  });
});
