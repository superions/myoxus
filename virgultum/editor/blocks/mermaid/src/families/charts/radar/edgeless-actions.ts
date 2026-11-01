// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../../contracts.js";

/** Radar contributes domain actions inside the active embedded block only. */
export const mermaidRadarEmbeddedActions: ReadonlyArray<MermaidFamilyToolbarAction> =
  [
    {
      commandId: "radar.axis.add",
      id: "radar.add-axis",
      label: mermaidMessages.chartAddAxis(),
    },
    {
      commandId: "radar.curve.add",
      id: "radar.add-curve",
      label: mermaidMessages.chartAddCurve(),
    },
    {
      commandId: "radar.data.toggle",
      id: "radar.data",
      label: mermaidMessages.pieData(),
    },
    {
      commandId: "radar.comments.open",
      id: "radar.comments",
      label: mermaidMessages.visualComments(),
    },
    {
      commandId: "radar.appearance.open",
      id: "radar.appearance",
      label: mermaidMessages.visualAppearance(),
    },
    {
      commandId: "radar.more.open",
      id: "radar.more",
      label: mermaidMessages.visualMoreActions(),
    },
  ];
