/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus: React 19/XYFlow 12 and direct Facade integration; see provenance.json.

import * as React from "react";
import { useLayoutEffect, useMemo } from "react";
import * as RF from "@xyflow/react";
import { ContainmentMode } from "../graph/graphStructure";
import { type DC__Shape } from "../maths/model";
import { useXyFlowReactKieDiagramStore } from "../store/Store";
import { type NodeSizes } from "./NodeSizes";

// CSS always last
import "./Hooks.css";

export const NODE_LAYERS = {
  GROUP_NODES: 0,
  CONTAINER_NODES: 1000,
  NODES: 2000, // We need a difference > 1000 here, since ReactFlow will add 1000 to the z-index when a node is selected.
  PARENT_NODES: 3000, // We need a difference > 1000 here, since ReactFlow will add 1000 to the z-index when a node is selected.
  NESTED_NODES: 5000,
  ATTACHED_NODES: 10000,
};

/** Selected edge controls must clear even hovered/attached-node captions. This
 * is a transient renderer interaction band, never document geometry or theme. */
export const SELECTED_EDGE_LAYER = 20_000;
// The elevated path needs a narrow pointer corridor so its old 40px selection
// stroke cannot steal clicks from endpoint shapes/captions. Updaters and
// waypoints retain their own independent hit targets.
export const SELECTED_EDGE_INTERACTION_WIDTH = 10;

export const resizerControlStyle = {
  background: "transparent",
  border: "none",
};

export type NodeResizeHandleProps<N extends string> = {
  nodeId: string;
  nodeShapeIndex: number;
  nodeType: N;
  MIN_NODE_SIZES: NodeSizes<N>;
};

export function NodeResizerHandle<N extends string>(
  props: NodeResizeHandleProps<N>,
) {
  const snapGrid = useXyFlowReactKieDiagramStore(
    (s) => s.xyFlowReactKieDiagram.snapGrid,
  );

  const minSize = props.MIN_NODE_SIZES[props.nodeType]({ snapGrid });
  return (
    <RF.NodeResizeControl
      style={resizerControlStyle}
      minWidth={minSize["@_width"]}
      minHeight={minSize["@_height"]}
    >
      <div
        data-testid={`kie-tools--xyflow-react-kie-diagram--${props.nodeId}-resize-handle`}
        style={{
          position: "absolute",
          top: "-10px",
          left: "-10px",
          width: "12px",
          height: "12px",
          backgroundColor: "var(--mantine-color-text)",
          clipPath: "polygon(0 100%, 100% 100%, 100% 0)",
        }}
      />
    </RF.NodeResizeControl>
  );
}

export function useNodeResizing(id: string): boolean {
  return RF.useStore((s) => s.nodeLookup.get(id)?.resizing ?? false);
}

/** Render the same canonical geometry as XYFlow; import is never an implicit resize. */
export function useNodeDimensions({
  shape,
}: {
  shape: DC__Shape;
}): RF.Dimensions {
  return {
    width: shape["dc:Bounds"]["@_width"],
    height: shape["dc:Bounds"]["@_height"],
  };
}

export function useHoveredNodeAlwaysOnTop(
  ref: React.RefObject<HTMLDivElement | SVGElement | null>,
  zIndex: number,
  shouldActLikeHovered: boolean,
  dragging: boolean,
  selected: boolean,
  isEditing: boolean,
) {
  useLayoutEffect(() => {
    // Selection enters the node's keyboard owner; later hover/layer changes
    // must not steal focus from its open popup or the properties inspector.
    if (selected && !isEditing) ref.current?.focus();
  }, [selected, isEditing, ref]);
  useLayoutEffect(() => {
    const r = ref.current;

    if (r) {
      r.parentElement!.style.zIndex = `${
        shouldActLikeHovered || dragging
          ? zIndex + NODE_LAYERS.NESTED_NODES + 1
          : zIndex
      }`;
    }
  }, [dragging, shouldActLikeHovered, ref, zIndex, selected, isEditing]);
}

/** Projects XYFlow's live handle gesture into KIE's semantic source/target direction. */
export function useConnection(nodeId: string) {
  const connectionNodeId = RF.useStore((s) => s.connection.fromHandle?.nodeId);
  const connectionHandleType = RF.useStore(
    (s) => s.connection.fromHandle?.type,
  );

  const source = connectionNodeId;
  const target = nodeId;

  const edgeIdBeingUpdated = useXyFlowReactKieDiagramStore(
    (s) => s.xyFlowReactKieDiagram.edgeIdBeingUpdated,
  );
  const sourceHandle = RF.useStore(
    (s) =>
      s.connection.fromHandle?.id ??
      s.edges.find((e) => e.id === edgeIdBeingUpdated)?.type ??
      null,
  );

  const connection = useMemo(
    () => ({
      source: connectionHandleType === "source" ? (source ?? "") : target,
      target: connectionHandleType === "source" ? target : (source ?? ""),
      sourceHandle,
      targetHandle: null, // We don't use targetHandles, as target handles are only different in position, not in semantic.
    }),
    [connectionHandleType, source, sourceHandle, target],
  );

  return connection;
}

export function useConnectionTargetStatus(
  nodeId: string,
  shouldActLikeHovered: boolean,
) {
  const isTargeted = RF.useStore(
    (s) =>
      !!s.connection.fromHandle?.nodeId &&
      s.connection.fromHandle.nodeId !== nodeId &&
      shouldActLikeHovered,
  );
  const connection = useConnection(nodeId);
  const isValidConnectionTarget = RF.useStore(
    (s) => s.isValidConnection?.(connection) ?? false,
  );

  return useMemo(
    () => ({
      isTargeted,
      isValidConnectionTarget,
    }),
    [isTargeted, isValidConnectionTarget],
  );
}

export function useNodeClassName<N extends string, E extends string>(
  isValidConnectionTarget: boolean,
  nodeId: string,
  NODE_TYPES: Record<string, N>,
  EDGE_TYPES: Record<string, E>,
  ignoreContainment: boolean = false,
) {
  const isDropTarget = useXyFlowReactKieDiagramStore(
    (s) => s.xyFlowReactKieDiagram.dropTarget?.node.id === nodeId,
  );
  const dropTargetContainmentMode = useXyFlowReactKieDiagramStore(
    (s) => s.xyFlowReactKieDiagram.dropTarget?.containmentMode,
  );

  const isConnectionNodeId = RF.useStore(
    (s) => s.connection.fromHandle?.nodeId === nodeId,
  );
  const connection = useConnection(nodeId);
  const isEdgeConnection = !!Object.values(EDGE_TYPES).some(
    (s) => s === connection.sourceHandle,
  );
  const isNodeConnection = !!Object.values(NODE_TYPES).some(
    (s) => s === connection.sourceHandle,
  );

  if (isNodeConnection && !isConnectionNodeId) {
    return "dimmed";
  }

  if (isEdgeConnection && (!isValidConnectionTarget || isConnectionNodeId)) {
    return "dimmed";
  }

  if (
    !ignoreContainment &&
    isDropTarget &&
    dropTargetContainmentMode !== undefined
  ) {
    if (dropTargetContainmentMode === ContainmentMode.IGNORE) {
      return "drop-target-ignore";
    } else if (dropTargetContainmentMode === ContainmentMode.INSIDE) {
      return "drop-target-inside";
    } else if (dropTargetContainmentMode === ContainmentMode.BORDER) {
      return "drop-target-border";
    } else if (dropTargetContainmentMode === ContainmentMode.INVALID_BORDER) {
      return "drop-target-border-invalid";
    } else if (dropTargetContainmentMode === ContainmentMode.INVALID_INSIDE) {
      return "drop-target-inside-invalid";
    } else if (
      dropTargetContainmentMode === ContainmentMode.INVALID_NON_INSIDE_CONTAINER
    ) {
      return "drop-target-invalid-non-container";
    } else if (dropTargetContainmentMode === ContainmentMode.INVALID_IGNORE) {
      return "drop-target-invalid-ignore";
    } else {
      throw new Error("Unknown containment mode");
    }
  }

  return "normal";
}
