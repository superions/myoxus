// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../contracts.js";
/** One action catalog drives Page and the local embedded block action projection. */
export const mermaidPacketActions = [
  {
    commandId: "packet.add",
    placement: "primary",
    id: "packet.add-field",
    get label() {
      return messages.packetAddField();
    },
  },
  {
    commandId: "packet.split",
    placement: "primary",
    id: "packet.split-field",
    get label() {
      return messages.packetSplit();
    },
  },
  {
    commandId: "packet.merge",
    placement: "primary",
    id: "packet.merge-fields",
    get label() {
      return messages.packetMerge();
    },
  },
  {
    commandId: "packet.comments",
    placement: "primary",
    id: "packet.comments",
    get label() {
      return messages.visualComments();
    },
  },
  {
    commandId: "packet.appearance",
    placement: "overflow",
    id: "packet.appearance",
    get label() {
      return messages.visualAppearance();
    },
  },
  {
    commandId: "packet.accessibility",
    placement: "overflow",
    id: "packet.accessibility",
    get label() {
      return messages.visualAccessibility();
    },
  },
  {
    commandId: "packet.data",
    placement: "overflow",
    id: "packet.data",
    get label() {
      return messages.treemapData();
    },
  },
  {
    commandId: "packet.more",
    placement: "menu",
    id: "packet.more",
    get label() {
      return messages.visualMoreActions();
    },
  },
  {
    commandId: "packet.rename",
    id: "packet.rename",
    placement: "overflow",
    get label() {
      return messages.timelineLabel();
    },
  },
  {
    commandId: "packet.delete",
    id: "packet.delete",
    placement: "overflow",
    get label() {
      return messages.visualDelete();
    },
  },
  {
    commandId: "packet.export",
    id: "packet.export",
    placement: "overflow",
    get label() {
      return messages.mmdExport();
    },
  },
] as const satisfies readonly (MermaidFamilyToolbarAction & {
  readonly placement: "primary" | "overflow" | "menu";
})[];
