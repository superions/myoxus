import { MermaidBlockSchema } from "@virgultum/model";
import { FeatureFlagService, editorMessage } from "@virgultum/shared/services";
import type {
  SlashMenuConfig,
  SlashMenuContext,
} from "@virgultum/widget-slash-menu";

import { insertMermaidBlockCommand } from "./commands.js";
import { MERMAID_PRODUCT_TEMPLATES } from "./engine/product-types.js";

const flavour = MermaidBlockSchema.model.flavour;

export function canShowMermaidSlashItem({ model, std }: SlashMenuContext) {
  return (
    model.store.schema.flavourSchemaMap.has(flavour) &&
    !!std.get(FeatureFlagService).getFlag("enable_mermaid_block")
  );
}

export const mermaidSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "mermaid",
      label: editorMessage(
        "com.myoxus.editor.mermaid.slash-name",
        "Mermaid diagram",
      ),
      description: editorMessage(
        "com.myoxus.editor.mermaid.toolbar-search-placeholder",
        "Diagram type",
      ),
      icon: "WorkflowIcon",
      group: {
        id: "diagrams",
        label: editorMessage(
          "com.myoxus.workspaceSubPath.diagrams",
          "Diagrams",
        ),
        order: 5,
        itemOrder: 3,
      },
      searchAlias: [
        "mermaid",
        "diagram",
        "diagramm",
        "flowchart",
        "sequence",
        "gantt",
        "gitgraph",
      ],
      when: canShowMermaidSlashItem,
      subMenu: MERMAID_PRODUCT_TEMPLATES.map((template) => ({
        id: `mermaid-${template.id}`,
        name: `Mermaid: ${template.label}`,
        description: editorMessage(
          "com.myoxus.editor.mermaid.slash-description",
          "Create a Mermaid diagram",
        ),
        icon: "WorkflowIcon",
        searchAlias: ["mermaid", "diagram", "diagramm", template.label],
        when: canShowMermaidSlashItem,
        action: ({ model, std }) => {
          const options = {
            place: "after" as const,
            removeEmptyLine: true,
            selectedModels: [model],
            source: template.source,
            title: template.label,
          };
          std.command.exec(insertMermaidBlockCommand, options);
        },
      })),
    },
  ],
};
