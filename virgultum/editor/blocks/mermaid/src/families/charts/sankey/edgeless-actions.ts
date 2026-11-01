// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../../contracts.js";

/** Domain actions belong to the embedded block, never a second outer toolbar. */
export const mermaidSankeyEmbeddedActions: readonly MermaidFamilyToolbarAction[] =
  [
    {
      commandId: "sankey.link.add",
      id: "sankey.add-link",
      label: mermaidMessages.chartAddLink(),
    },
    {
      commandId: "sankey.data.toggle",
      id: "sankey.data",
      label: mermaidMessages.pieData(),
    },
    {
      commandId: "sankey.comments.open",
      id: "sankey.comments",
      label: mermaidMessages.visualComments(),
    },
    {
      commandId: "sankey.appearance.open",
      id: "sankey.appearance",
      label: mermaidMessages.visualAppearance(),
    },
    {
      commandId: "sankey.more.open",
      id: "sankey.more",
      label: mermaidMessages.visualMoreActions(),
    },
  ];
