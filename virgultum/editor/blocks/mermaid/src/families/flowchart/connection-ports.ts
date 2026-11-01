// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidGfxNodeConnectionPort } from "../runtime/gfx-family-hooks-contract.js";

export type MermaidFlowchartConnectionPortId =
  "north" | "east" | "south" | "west";

export const FLOWCHART_NODE_CONNECTION_PORTS = [
  { id: "north", position: [0.5, 0] },
  { id: "east", position: [1, 0.5] },
  { id: "south", position: [0.5, 1] },
  { id: "west", position: [0, 0.5] },
] as const satisfies readonly MermaidGfxNodeConnectionPort[];

export function flowchartNodeConnectionPorts() {
  // Cardinal points lie on both rectangular bounds and the actual contour of
  // the supported symmetric/non-rectangular Flowchart shapes. Keeping the
  // relative positions type-owned also gives later edge commands stable port
  // identities without leaking Flowchart semantics into the shared GFX model.
  return FLOWCHART_NODE_CONNECTION_PORTS;
}
