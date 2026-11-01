// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../../contracts.js";

/** Treemap domain actions render inside the embedded owner, never beside it. */
export const mermaidTreemapEmbeddedActions: readonly MermaidFamilyToolbarAction[] =
  [
    {
      commandId: "treemap.section.add",
      id: "treemap.add-section",
      label: mermaidMessages.treemapAddSection(),
    },
    {
      commandId: "treemap.leaf.add",
      id: "treemap.add-leaf",
      label: mermaidMessages.treemapAddLeaf(),
    },
    {
      commandId: "treemap.data.toggle",
      id: "treemap.data",
      label: mermaidMessages.treemapData(),
    },
    {
      commandId: "treemap.classes.open",
      id: "treemap.classes",
      label: mermaidMessages.treemapClasses(),
    },
    {
      commandId: "treemap.comments.open",
      id: "treemap.comments",
      label: mermaidMessages.visualComments(),
    },
    {
      commandId: "treemap.appearance.open",
      id: "treemap.appearance",
      label: mermaidMessages.visualAppearance(),
    },
    {
      commandId: "treemap.more.open",
      id: "treemap.more",
      label: mermaidMessages.visualMoreActions(),
    },
  ];
