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
// Modified by Myoxus; see provenance.json for retained source and patches.

import * as React from "react";
import * as RF from "@xyflow/react";
import { DiagramActionContext } from "../diagram/DiagramActionContext";
import {
  Button,
  Group,
  Stack,
  IconButton,
  Popover,
  PopoverTarget,
  PopoverContent,
} from "@myoxus/ui-facade";
import { MoreHorizontalIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { useXyFlowReactKieDiagramStore } from "../store/Store";

const nodeSvgProps = { width: 100, height: 70, x: 0, y: 15, strokeWidth: 8 };

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
  const connectable = RF.useStore((s) => s.nodesConnectable);
  const selected = RF.useInternalNode(props.nodeHref)?.selected;
  const singleSelection = RF.useStore(
    (s) => s.nodes.filter((node) => node.selected).length === 1,
  );
  const visible = !!selected && singleSelection && !dragging;
  React.useEffect(() => {
    if (!visible || !connectable) setOpen(false);
  }, [visible, connectable]);
  return (
    <>
      {/* Native edge rendering still needs a source independently of UI controls. */}
      <RF.Handle
        id="unique-source-handle"
        type="source"
        position={RF.Position.Top}
        isConnectableStart={false}
        isConnectableEnd={false}
        style={{ opacity: 0, pointerEvents: "none" }}
      />
      {!!(props.nodeTypes.length + props.edgeTypes.length) && (
        <RF.NodeToolbar
          nodeId={props.nodeHref}
          position={RF.Position.Top}
          isVisible={visible}
        >
          <Group
            className="nodrag nopan"
            wrap="nowrap"
            onKeyDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {!!props.nodeTypes.length && (
              <Popover
                open={open && visible}
                onOpenChange={setOpen}
                position="top"
                returnFocus
                fitViewport
              >
                <PopoverTarget>
                  <Button
                    disabled={!connectable}
                    aria-label={t["com.myoxus.editor.bpmn.next-element"]()}
                    aria-expanded={open}
                    data-mantine-stop-propagation={open ? "true" : undefined}
                    onKeyDown={(event) => {
                      if (open && event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setOpen(false);
                      }
                    }}
                    onClick={() => setOpen((value) => !value)}
                  >
                    {t["com.myoxus.editor.bpmn.next-element"]()}
                  </Button>
                </PopoverTarget>
                <PopoverContent
                  aria-label={t["com.myoxus.editor.bpmn.next-element"]()}
                >
                  <Stack>
                    {props.nodeTypes.map((type) => {
                      const { icon: Icon, actionTitle } =
                        props.nodeMapping[type];
                      return (
                        <Button
                          key={type}
                          disabled={!connectable}
                          data-testid={`${props.nodeHref}-add-${type}`}
                          prefix={
                            <svg viewBox="0 0 100 100">
                              <Icon {...nodeSvgProps} />
                            </svg>
                          }
                          onClick={() => {
                            setOpen(false);
                            requestAction?.({
                              nodeId: props.nodeHref,
                              action: { kind: "node", type },
                              placement: "next",
                            });
                          }}
                        >
                          {actionTitle}
                        </Button>
                      );
                    })}
                  </Stack>
                </PopoverContent>
              </Popover>
            )}
            <IconButton
              tooltip={t["com.myoxus.actions"]()}
              tooltipShortcut={["Shift", "F10"]}
              aria-keyshortcuts="Shift+F10"
              disabled={!connectable}
              onClick={() => {
                setOpen(false);
                requestAction?.({ nodeId: props.nodeHref });
              }}
            >
              <MoreHorizontalIcon />
            </IconButton>
          </Group>
        </RF.NodeToolbar>
      )}
    </>
  );
}
