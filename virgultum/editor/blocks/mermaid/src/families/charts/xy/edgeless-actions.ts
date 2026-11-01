// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../../contracts.js";

/** XY contributes only local actions inside the existing embedded Note owner. */
export const mermaidXyEmbeddedActions: ReadonlyArray<MermaidFamilyToolbarAction> =
  [
    {
      commandId: "xy.plot.add",
      id: "xy.add-plot",
      label: mermaidMessages.xyAddPlot(),
    },
    {
      commandId: "xy.category.add",
      id: "xy.add-category",
      label: mermaidMessages.chartAddCategory(),
    },
    {
      commandId: "xy.data.toggle",
      id: "xy.data",
      label: mermaidMessages.pieData(),
    },
    {
      commandId: "xy.axes.open",
      id: "xy.axes",
      label: mermaidMessages.xyAxes(),
    },
    {
      commandId: "xy.comments.open",
      id: "xy.comments",
      label: mermaidMessages.visualComments(),
    },
    {
      commandId: "xy.appearance.open",
      id: "xy.appearance",
      label: mermaidMessages.visualAppearance(),
    },
    {
      commandId: "xy.more.open",
      id: "xy.more",
      label: mermaidMessages.visualMoreActions(),
    },
  ];
