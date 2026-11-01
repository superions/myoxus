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
import * as RF from "@xyflow/react";
import { DiagramActionContext } from "../diagram/DiagramActionContext";
import {
  Group,
  IconButton,
  Popover,
  PopoverTarget,
  PopoverContent,
} from "@myoxus/ui-facade";
import { MoreHorizontalIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import "./OutgoingStuffNodePanel.css";
import { useXyFlowReactKieDiagramStore } from "../store/Store";

const edgeSvgViewboxSize = 25;

const nodeSvgProps = { width: 100, height: 70, x: 0, y: 15, strokeWidth: 8 };
const nodeSvgViewboxSize = nodeSvgProps.width;

export const handleStyle: React.CSSProperties = {
  // The native Facade button owns chrome and size. This wrapper only positions
  // XYFlow's measured hit target; it must not add another visible handle skin.
  display: "flex",
  position: "unset",
  transform: "unset",
  width: "auto",
  height: "auto",
  border: 0,
  background: "none",
};

export type OutgoingStuffNodePanelNodeMapping<N extends string> = Record<
  N,
  {
    actionTitle: string;
    icon: React.ComponentType<typeof nodeSvgProps>;
  }
>;

export type OutgoingStuffNodePanelEdgeMapping<E extends string> = Record<
  E,
  {
    actionTitle: string;
    icon: React.ComponentType<{ viewboxSize: number }>;
  }
>;

export function OutgoingStuffNodePanel<
  N extends string,
  E extends string,
>(props: {
  isVisible: boolean;
  nodeTypes: N[];
  edgeTypes: E[];
  nodeHref: string;
  nodeMapping: OutgoingStuffNodePanelNodeMapping<N>;
  edgeMapping: OutgoingStuffNodePanelEdgeMapping<E>;
}) {
  const t = useI18n();
  const requestAction = React.useContext(DiagramActionContext);
  const [open, setOpen] = React.useState(false);
  const dragging = useXyFlowReactKieDiagramStore(
    (s) => !!s.xyFlowReactKieDiagram.ongoingConnection,
  );
  const connectable = RF.useStore((state) => state.nodesConnectable);
  const node = RF.useInternalNode(props.nodeHref);
  const viewport = RF.useViewport();
  const updateNodeInternals = RF.useUpdateNodeInternals();
  const measureHandles = React.useCallback(
    (element: HTMLDivElement | null) => {
      // The dropdown mounts after its opening effect (Mantine Transition).
      // Measure on actual mount as well, not only on the requested open state.
      if (element) updateNodeInternals(props.nodeHref);
    },
    [updateNodeInternals, props.nodeHref],
  );
  // Selection keeps the launcher reachable for keyboard/focus return, even
  // after leaving the shape. Hover still discovers controls on unselected nodes.
  const visible = (props.isVisible || node?.selected) && !dragging;
  React.useEffect(() => {
    if (!visible || !connectable || !node?.selected) setOpen(false);
  }, [visible, connectable, node?.selected]);
  React.useLayoutEffect(() => {
    // Floating positions the real RF handles inside this node's DOM owner.
    // Refresh native hit geometry after opening or a node/viewport transform;
    // do not replace them with portalled proxy handles or responsive offsets.
    if (open && visible) updateNodeInternals(props.nodeHref);
  }, [
    open,
    visible,
    props.nodeHref,
    updateNodeInternals,
    node?.internals.positionAbsolute.x,
    node?.internals.positionAbsolute.y,
    node?.measured?.width,
    node?.measured?.height,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);
  const style: React.CSSProperties = React.useMemo(
    () => ({
      visibility: visible ? undefined : "hidden",
    }),
    [visible],
  );

  return (
    <>
      {/* Every node keeps a source handle while its transient controls unmount.
          XYFlow otherwise suppresses existing edges before our DI renderer runs. */}
      <RF.Handle
        key={"unique-source-handle"} // Arbitrary string. Shouldn't be referenced.
        id={"unique-source-handle"} // Arbitrary string. Shouldn't be referenced.
        isConnectableEnd={false}
        isConnectableStart={false}
        type={"source"}
        style={{ ...handleStyle, opacity: 0 }} // Invisible on purpose, as this shouldn't be interacted with.
        position={RF.Position.Top} // Doesn't really impact anything.
        title={""}
      />
      {props.edgeTypes.length + props.nodeTypes.length > 0 && (
        <Group
          className={
            "xyflow-react-kie-diagram--outgoing-stuff-node-panel nodrag nopan"
          }
          style={style}
          onKeyDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Popover
            open={open && visible}
            onOpenChange={setOpen}
            position="top"
            returnFocus
            withinPortal={false}
            fitViewport
            floatingStrategy="fixed"
          >
            <PopoverTarget>
              <IconButton
                tooltip={t["com.myoxus.actions"]()}
                tooltipShortcut={["Shift", "F10"]}
                aria-keyshortcuts="Shift+F10"
                data-mantine-stop-propagation={open ? "true" : undefined}
                disabled={!connectable}
                onClick={() => setOpen((value) => !value)}
                onKeyDown={(event) => {
                  // Opening retains focus on the launcher. Escape belongs to this
                  // local popup before it can reach the enclosing session dialog.
                  if (open && event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                  }
                }}
              >
                <MoreHorizontalIcon />
              </IconButton>
            </PopoverTarget>
            <PopoverContent
              className="nodrag nopan"
              aria-label={t["com.myoxus.actions"]()}
            >
              <Group wrap="nowrap" ref={measureHandles}>
                {props.edgeTypes.length > 0 && (
                  <Group wrap="nowrap">
                    {props.edgeTypes.map((edgeType) => {
                      const Icon = props.edgeMapping[edgeType].icon;
                      return (
                        <RF.Handle
                          key={edgeType}
                          id={edgeType}
                          isConnectableEnd={false}
                          isConnectableStart={connectable}
                          type={"source"}
                          style={handleStyle}
                          position={RF.Position.Top}
                          title={props.edgeMapping[edgeType].actionTitle}
                          data-testid={`${props.nodeHref}-add-${edgeType}`}
                        >
                          <IconButton
                            tooltip={props.edgeMapping[edgeType].actionTitle}
                            data-mantine-stop-propagation="true"
                            disabled={!connectable}
                            onClick={(event) => {
                              if (event.detail === 0 && requestAction) {
                                event.preventDefault();
                                event.stopPropagation();
                                setOpen(false);
                                requestAction({
                                  nodeId: props.nodeHref,
                                  action: { kind: "edge", type: edgeType },
                                });
                              }
                            }}
                          >
                            <svg
                              viewBox={`0 0 ${edgeSvgViewboxSize} ${edgeSvgViewboxSize}`}
                            >
                              <Icon viewboxSize={edgeSvgViewboxSize} />
                            </svg>
                          </IconButton>
                        </RF.Handle>
                      );
                    })}
                  </Group>
                )}

                {props.nodeTypes.length > 0 && (
                  <Group wrap="nowrap">
                    {props.nodeTypes.map((nodeType) => {
                      const Icon = props.nodeMapping[nodeType].icon;
                      return (
                        <RF.Handle
                          key={nodeType}
                          id={nodeType}
                          isConnectableEnd={false}
                          isConnectableStart={connectable}
                          type={"source"}
                          style={handleStyle}
                          position={RF.Position.Top}
                          title={props.nodeMapping[nodeType].actionTitle}
                          data-testid={`${props.nodeHref}-add-${nodeType}`}
                        >
                          <IconButton
                            tooltip={props.nodeMapping[nodeType].actionTitle}
                            data-mantine-stop-propagation="true"
                            disabled={!connectable}
                            onClick={(event) => {
                              if (event.detail === 0 && requestAction) {
                                event.preventDefault();
                                event.stopPropagation();
                                setOpen(false);
                                requestAction({
                                  nodeId: props.nodeHref,
                                  action: { kind: "node", type: nodeType },
                                });
                              }
                            }}
                          >
                            <svg
                              viewBox={`0 0 ${nodeSvgViewboxSize} ${nodeSvgViewboxSize}`}
                            >
                              <Icon {...nodeSvgProps} />
                            </svg>
                          </IconButton>
                        </RF.Handle>
                      );
                    })}
                  </Group>
                )}
              </Group>
            </PopoverContent>
          </Popover>
        </Group>
      )}
    </>
  );
}
