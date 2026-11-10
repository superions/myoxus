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

import * as RF from "@xyflow/react";
import * as React from "react";
import { useMemo } from "react";
import "./PositionalNodeHandles.css";
import { sourceHandleId } from "../store/State";

export enum PositionalNodeHandleId {
  Left = "positional-handle-left",
  Top = "positional-handle-top",
  Right = "positional-handle-right",
  Bottom = "positional-handle-bottom",
  Center = "positional-handle-center",
}

export function PositionalNodeHandles(props: {
  isTargeted: boolean;
  nodeId: string;
  sourceEdgeType?: string;
}) {
  const connectable = RF.useStore((s) => s.nodesConnectable);
  const updateNodeInternals = RF.useUpdateNodeInternals();
  React.useLayoutEffect(() => {
    updateNodeInternals(props.nodeId);
  }, [props.nodeId, props.sourceEdgeType, updateNodeInternals]);
  const connecting = RF.useConnection().inProgress;
  // A selected target must not expose source hit regions above its target
  // handles during an ordinary drag. Reverse source reconnection is separate.
  const activeSource = RF.useStore(
    (s) => s.connection.fromHandle?.nodeId === props.nodeId,
  );
  const reconnectingSource = RF.useStore(
    (s) => s.connection.fromHandle?.type === "target",
  );
  const targetsStyle: React.CSSProperties = useMemo(
    () =>
      props.isTargeted && !reconnectingSource
        ? {}
        : { opacity: 0, pointerEvents: "none" },
    [props.isTargeted, reconnectingSource],
  );

  const type: RF.HandleType = "target"; // Has to be target, because those are the only target handles present on nodes. Without them, edges cannot be rendered.

  return (
    <>
      {Object.entries({
        Left: RF.Position.Left,
        Top: RF.Position.Top,
        Right: RF.Position.Right,
        Bottom: RF.Position.Bottom,
      }).map(([side, position]) => (
        <RF.Handle
          key={side}
          id={sourceHandleId(
            props.sourceEdgeType ?? "",
            PositionalNodeHandleId[side as keyof typeof PositionalNodeHandleId],
          )}
          type="source"
          position={position}
          className={`xyflow-react-kie-diagram--source-handle ${position}`}
          data-active-source={activeSource}
          data-discoverable={
            connectable &&
            !!props.sourceEdgeType &&
            (!connecting || activeSource || reconnectingSource)
          }
          isConnectableStart={connectable && !!props.sourceEdgeType}
          isConnectableEnd={
            connectable && reconnectingSource && !!props.sourceEdgeType
          }
        />
      ))}
      <RF.Handle
        id={PositionalNodeHandleId.Left}
        className={"xyflow-react-kie-diagram--node-handle left"}
        style={{ ...targetsStyle }}
        type={type}
        position={RF.Position.Left}
      />
      <RF.Handle
        id={PositionalNodeHandleId.Top}
        className={"xyflow-react-kie-diagram--node-handle top"}
        style={{ ...targetsStyle }}
        type={type}
        position={RF.Position.Top}
      />
      <RF.Handle
        id={PositionalNodeHandleId.Right}
        className={"xyflow-react-kie-diagram--node-handle right"}
        style={{ ...targetsStyle }}
        type={type}
        position={RF.Position.Right}
      />
      <RF.Handle
        id={PositionalNodeHandleId.Bottom}
        className={"xyflow-react-kie-diagram--node-handle bottom"}
        style={{ ...targetsStyle }}
        type={type}
        position={RF.Position.Bottom}
      />
      <RF.Handle
        id={PositionalNodeHandleId.Center}
        isConnectableEnd={false}
        className={"xyflow-react-kie-diagram--node-handle center"}
        style={{ ...targetsStyle }}
        type={type}
        position={RF.Position.Top}
      />
    </>
  );
}
