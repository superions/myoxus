// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../i18n.js";
import type { MermaidFamilyActionContribution } from "../runtime/shell-contract.js";
import type { MermaidArchitectureEditorReactHostProps } from "./react-host-contract.js";

export const MERMAID_ARCHITECTURE_PAGE_ACTION_IDS = {
  addGroup: "architecture.add-group",
  addJunction: "architecture.add-junction",
  addService: "architecture.add-service",
  alignColumn: "architecture.align.column",
  alignRow: "architecture.align.row",
  comments: "architecture.add-comment",
  connect: "architecture.add-relationship",
  layout: "architecture.auto-layout",
  more: "architecture.more",
  settings: "architecture.diagram-settings",
} as const;

export function architecturePageActionContribution(
  props: MermaidArchitectureEditorReactHostProps,
  {
    displayOnly,
    embedded,
  }: { readonly displayOnly: boolean; readonly embedded: boolean },
): MermaidFamilyActionContribution {
  if (displayOnly || embedded) return { actions: [], portal: false };
  const readonlyActions = [
    ...(props.comments.some((comment) => comment.anchorKind === "diagram")
      ? [
          {
            disabled: false,
            id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.comments,
            label: mermaidMessages.architectureComments(),
          },
        ]
      : []),
    {
      disabled: false,
      id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.settings,
      label: mermaidMessages.architectureDiagramSettings(),
    },
    {
      disabled: false,
      id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.more,
      label: mermaidMessages.visualMoreActions(),
    },
  ];
  if (props.readonly) return { actions: readonlyActions, portal: true };
  return {
    actions: [
      {
        disabled: false,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.addService,
        label: props.labels.addService,
        onSelect: props.onAddService,
      },
      {
        disabled: false,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.addJunction,
        label: props.labels.addJunction,
        onSelect: props.onAddJunction,
      },
      {
        disabled: !props.canAddGroup,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.addGroup,
        label: props.labels.addGroup,
        onSelect: props.onAddGroup,
      },
      {
        disabled: !props.canConnect && !props.connecting,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.connect,
        label: props.labels.connect,
        onSelect: props.onConnect,
      },
      {
        disabled: !props.canAlign,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.alignRow,
        label: props.labels.alignRow,
        onSelect: () => props.onAlign("row"),
      },
      {
        disabled: !props.canAlign,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.alignColumn,
        label: props.labels.alignColumn,
        onSelect: () => props.onAlign("column"),
      },
      {
        disabled: false,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.comments,
        label: mermaidMessages.architectureComments(),
      },
      {
        disabled: false,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.settings,
        label: props.labels.diagramSettings,
      },
      {
        disabled: false,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.layout,
        label: props.labels.layout,
      },
      {
        disabled: false,
        id: MERMAID_ARCHITECTURE_PAGE_ACTION_IDS.more,
        label: mermaidMessages.visualMoreActions(),
      },
    ],
    portal: true,
  };
}
