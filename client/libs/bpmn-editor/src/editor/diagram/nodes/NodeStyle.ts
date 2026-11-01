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

import React, { useMemo } from "react";
import { type BpmnNodeType } from "../BpmnDiagramDomain";
import { NODE_TYPES } from "../BpmnDiagramDomain";
import { type Normalized } from "../../normalization/normalize";
import {
  type DC__Font,
  type DC__Bounds,
  type BPMNDI__BPMNShape,
} from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type NodeLabelPosition } from "../../../xyflow/nodes/NodeSvgs";
import { assertUnreachable } from "../../ts-ext/assertUnreachable";

/** BPMNDI label bounds are absolute notation coordinates. HTML labels are
 * shape-local; do not infer them from node dimensions or write defaults to DI. */
export function getNodeLabelBounds(
  shape: Pick<BPMNDI__BPMNShape, "dc:Bounds" | "bpmndi:BPMNLabel">,
) {
  const label = shape["bpmndi:BPMNLabel"]?.["dc:Bounds"];
  if (!label) return undefined;
  return {
    x: label["@_x"] - shape["dc:Bounds"]["@_x"],
    y: label["@_y"] - shape["dc:Bounds"]["@_y"],
    width: label["@_width"],
    height: label["@_height"],
  };
}
export interface NodeStyle {
  fontCssProperties: React.CSSProperties;
}
export interface BpmnFontStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeThrough: boolean;
  family?: string;
  size?: number;
}
export const DEFAULT_NODE_FILL = "var(--mantine-color-body)";
export const DEFAULT_NODE_STROKE_COLOR = "var(--mantine-color-text)";
export const DEFAULT_FONT_COLOR = "var(--mantine-color-text)";
export function useNodeStyle(args: {
  nodeType?: BpmnNodeType;
  isEnabled?: boolean;
}): NodeStyle {
  const bpmnFontStyle = useMemo(
    () =>
      getBpmnFontStyle({
        isEnabled: args.isEnabled,
      }),
    [args.isEnabled],
  );
  return useMemo(
    () =>
      getNodeStyle({
        bpmnFontStyle,
      }),
    [bpmnFontStyle],
  );
}
export function getNodeStyle({
  bpmnFontStyle,
}: {
  bpmnFontStyle: BpmnFontStyle;
}): NodeStyle {
  return {
    fontCssProperties: getFontCssProperties(bpmnFontStyle),
  };
}
export function getBpmnFontStyle(args: {
  dcFont?: Normalized<DC__Font> | undefined;
  isEnabled?: boolean | undefined;
}): BpmnFontStyle {
  return {
    bold: args.isEnabled ? (args.dcFont?.["@_isBold"] ?? false) : false,
    italic: args.isEnabled ? (args.dcFont?.["@_isItalic"] ?? false) : false,
    underline: args.isEnabled
      ? (args.dcFont?.["@_isUnderline"] ?? false)
      : false,
    strikeThrough: args.isEnabled
      ? (args.dcFont?.["@_isStrikeThrough"] ?? false)
      : false,
    family: args.isEnabled ? args.dcFont?.["@_name"] : undefined,
    size: args.isEnabled ? args.dcFont?.["@_size"] : undefined,
  };
}
export function getFontCssProperties(
  bpmnFontStyle?: BpmnFontStyle,
): React.CSSProperties {
  let textDecoration = "";
  if (bpmnFontStyle?.underline) {
    textDecoration += "underline ";
  }
  if (bpmnFontStyle?.strikeThrough) {
    textDecoration += "line-through";
  }

  // Notation labels share the projected UI font unless BPMNDI explicitly owns it.
  return {
    fontWeight: bpmnFontStyle?.bold ? "bold" : "",
    fontStyle: bpmnFontStyle?.italic ? "italic" : "",
    fontFamily: bpmnFontStyle?.family ?? "var(--mantine-font-family)",
    textDecoration,
    fontSize: bpmnFontStyle?.size ?? "var(--mantine-font-size-md)",
    lineHeight: "var(--mantine-line-height)",
  };
}
export function getNodeLabelPosition({
  nodeType,
  isHorizontal,
  isExpanded,
  boundary,
}: {
  nodeType: BpmnNodeType;
  isHorizontal?: boolean;
  isExpanded?: boolean;
  /** Unauthored Boundary captions sit outside their actual host side. Stored
   * label geometry is handled by the consuming renderer before this fallback. */
  boundary?: { event: DC__Bounds; host: DC__Bounds };
}): NodeLabelPosition {
  if (nodeType === NODE_TYPES.intermediateCatchEvent && boundary) {
    const { event, host } = boundary,
      cx = event["@_x"] + event["@_width"] / 2,
      cy = event["@_y"] + event["@_height"] / 2;
    return (
      [
        [Math.abs(cy - host["@_y"]), "outside-top"],
        [Math.abs(cy - host["@_y"] - host["@_height"]), "center-bottom"],
        [Math.abs(cx - host["@_x"]), "outside-left"],
        [Math.abs(cx - host["@_x"] - host["@_width"]), "outside-right"],
      ] as const
    ).reduce((a, b) => (b[0] < a[0] ? b : a))[1];
  }
  switch (nodeType) {
    case NODE_TYPES.subProcess:
      return isExpanded === false ? "center-center" : "top-center";
    case NODE_TYPES.startEvent:
    case NODE_TYPES.intermediateCatchEvent:
    case NODE_TYPES.intermediateThrowEvent:
    case NODE_TYPES.endEvent:
    case NODE_TYPES.gateway:
    case NODE_TYPES.dataObject:
      return "center-bottom";
    case NODE_TYPES.group:
    case NODE_TYPES.textAnnotation:
      return "top-left";
    case NODE_TYPES.lane:
      return isHorizontal === false ? "top-center" : "center-left-vertical";
    case NODE_TYPES.task:
    case NODE_TYPES.unknown:
      // case NODE_TYPES.custom:
      return "center-center";
    default:
      assertUnreachable(nodeType);
  }
}
