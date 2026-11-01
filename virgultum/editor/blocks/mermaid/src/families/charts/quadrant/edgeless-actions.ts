// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../../contracts.js";

/** Quadrant contributes only to the existing embedded chart action slot. */
export const mermaidQuadrantEmbeddedActions: ReadonlyArray<MermaidFamilyToolbarAction> =
  [
    {
      commandId: "quadrant.point.add",
      id: "quadrant.add",
      label: mermaidMessages.chartAddPoint(),
    },
    {
      commandId: "quadrant.data.toggle",
      id: "quadrant.data",
      label: mermaidMessages.pieData(),
    },
    {
      commandId: "quadrant.comments.open",
      id: "quadrant.comments",
      label: mermaidMessages.visualComments(),
    },
    {
      commandId: "quadrant.appearance.open",
      id: "quadrant.appearance",
      label: mermaidMessages.visualAppearance(),
    },
    {
      commandId: "quadrant.more.open",
      id: "quadrant.more",
      label: mermaidMessages.visualMoreActions(),
    },
  ];
