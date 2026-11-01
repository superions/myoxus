// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../../contracts.js";

/**
 * Pie contributes structured actions to the existing embedded Facade slot.
 * It deliberately does not register a native Surface/Edgeless toolbar.
 */
export const mermaidPieEmbeddedActions: ReadonlyArray<MermaidFamilyToolbarAction> =
  [
    {
      commandId: "pie.slice.add",
      id: "pie.add",
      label: mermaidMessages.structuredAddEntry(),
    },
    {
      commandId: "pie.data.toggle",
      id: "pie.data",
      label: mermaidMessages.pieData(),
    },
    {
      commandId: "pie.appearance.open",
      id: "pie.appearance",
      label: mermaidMessages.visualAppearance(),
    },
    {
      commandId: "pie.comments.open",
      id: "pie.comments",
      label: mermaidMessages.visualComments(),
    },
    {
      commandId: "pie.more.open",
      id: "pie.more",
      label: mermaidMessages.visualMoreActions(),
    },
  ];
