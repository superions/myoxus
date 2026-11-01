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
import type { BPMNDI__BPMNEdge } from "../../../schemas/bpmn-2_0/ts-gen/types";
import type { DC__Bounds } from "../../../xyflow/maths/model";

/** Explicit BPMNDI label bounds are renderer geometry, not UI spacing. New
 * labels without DI borrow a centered box above the first segment; painting it does
 * not persist invented label DI. Canvas and standalone SVG share this layout. */
export function edgeLabelBounds(
  edge: BPMNDI__BPMNEdge | undefined,
): DC__Bounds {
  const bounds = edge?.["bpmndi:BPMNLabel"]?.["dc:Bounds"];
  if (bounds) return bounds;
  const start = edge?.["di:waypoint"]?.[0];
  const end = edge?.["di:waypoint"]?.[1] ?? start;
  return {
    "@_x": ((start?.["@_x"] ?? 0) + (end?.["@_x"] ?? 0)) / 2 - 80,
    "@_y": ((start?.["@_y"] ?? 0) + (end?.["@_y"] ?? 0)) / 2 - 24,
    "@_width": 160,
    "@_height": 24,
  };
}
export const SequenceFlowPath = React.memo(
  (
    _props: React.SVGProps<SVGPathElement> & {
      svgRef?: React.RefObject<SVGPathElement | null>;
      flowKind?: "normal" | "default" | "conditional";
    },
  ) => {
    const { svgRef, flowKind, ...props } = _props;
    return (
      <path
        ref={svgRef}
        style={{
          strokeWidth: 1,
          stroke: "var(--mantine-color-text)",
        }}
        markerEnd={"url(#closed-arrow)"}
        markerStart={
          flowKind === "default"
            ? "url(#bpmn-default-flow)"
            : flowKind === "conditional"
              ? "url(#bpmn-conditional-flow)"
              : undefined
        }
        fill="none"
        {...props}
      />
    );
  },
);
export const AssociationPath = React.memo(
  (
    __props: React.SVGProps<SVGPathElement> & {
      svgRef?: React.RefObject<SVGPathElement | null>;
      associationDirection?: "None" | "One" | "Both";
    },
  ) => {
    const strokeWidth = __props.strokeWidth ?? 1.5;
    const { svgRef, associationDirection, ...props } = __props;
    return (
      <path
        ref={svgRef}
        strokeWidth={strokeWidth}
        strokeLinecap="butt"
        strokeLinejoin="round"
        markerStart={
          associationDirection === "Both" ? "url(#open-arrow)" : undefined
        }
        markerEnd={
          associationDirection === "One" || associationDirection === "Both"
            ? "url(#open-arrow)"
            : undefined
        }
        fill="none"
        style={{
          stroke: "var(--mantine-color-text)",
          strokeDasharray: `${strokeWidth},10`,
        }}
        {...props}
      />
    );
  },
);
export function DataAssociationPath(props: React.SVGProps<SVGPathElement>) {
  return <AssociationPath {...props} associationDirection="One" />;
}
