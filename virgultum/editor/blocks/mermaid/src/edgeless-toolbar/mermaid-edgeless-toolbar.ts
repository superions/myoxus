import { createMermaidMindmapImportMenuItem } from "./mindmap-file-actions.js";
import type { BlockComponent } from "@virgultum/core/runtime";
import { Bound } from "@virgultum/core/primitives/gfx";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  type SeniorTool,
  SeniorToolExtension,
  type EdgelessToolbarWidget,
  EDGELESS_TOOLBAR_WIDGET,
  type ToolBuilder,
} from "@virgultum/canvas/widgets";

import { insertMermaidEdgelessDiagramCommand } from "../commands.js";
import { prepareMermaidFamilySource } from "../families/runtime/registry.js";
import {
  MERMAID_PRODUCT_DIAGRAM_SPECS,
  MERMAID_PRODUCT_CATEGORY_IDS,
} from "../engine/product-types.js";
import { getMermaidFamilyDiagramCapability } from "../families/registry.js";
import { mermaidMessages } from "../i18n.js";
import { createMermaidMmdImportMenuItem } from "./mmd-file-actions.js";
import {
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
  type SelectionAction,
} from "@virgultum/core/services";
import { mermaidToolbarSymbol } from "./mermaid-toolbar-symbol.js";

const titleMessage = editorMessage(
  "com.myoxus.editor.toolbar.diagram-templates",
  "Diagram templates",
);
const categoryMessages = {
  processes: editorMessage(
    "com.myoxus.diagrams.catalog.category.processes",
    "Processes",
  ),
  software: editorMessage(
    "com.myoxus.diagrams.catalog.category.software",
    "Software",
  ),
  planning: editorMessage(
    "com.myoxus.diagrams.catalog.category.planning",
    "Planning",
  ),
  data: editorMessage("com.myoxus.diagrams.catalog.category.data", "Data"),
} as const;

/** Read capabilities when the menu opens. Family runtimes themselves import
 * command consumers, so consulting their registry at module load is cyclic. */
export function getMermaidEdgelessToolbarTemplates() {
  const families = new Set<string>();
  return MERMAID_PRODUCT_DIAGRAM_SPECS.filter(({ diagramType }) => {
    const capability = getMermaidFamilyDiagramCapability(diagramType);
    if (
      !capability.visualEditing ||
      !capability.familyId ||
      families.has(capability.familyId)
    )
      return false;
    families.add(capability.familyId);
    return true;
  }).map(
    ({
      diagramType,
      category,
      label,
      templateId: id,
      templateSource: source,
    }) => ({
      diagramType,
      category,
      id,
      label,
      source,
    }),
  );
}

export type MermaidEdgelessToolbarTemplate = ReturnType<
  typeof getMermaidEdgelessToolbarTemplates
>[number];

export async function insertMermaidEdgelessToolbarTemplate(
  edgeless: BlockComponent,
  template: MermaidEdgelessToolbarTemplate,
) {
  await prepareMermaidFamilySource(template.source);
  if (edgeless.store.readonly) return;
  const result = edgeless.std.command.exec(
    insertMermaidEdgelessDiagramCommand,
    {
      source: template.source,
      title: template.label,
    },
  );
  const insertedId = result[1].insertedMermaidBlockId;
  if (result[0] && insertedId) {
    const gfx = edgeless.std.get(GfxControllerIdentifier);
    const owner = gfx.getElementById(insertedId);
    // Collision placement can put a toolbar-created owner offscreen. Reveal
    // this explicit creation without changing positioned paste/import commands.
    if (owner && "xywh" in owner && typeof owner.xywh === "string")
      gfx.fitToScreen({ bounds: [Bound.deserialize(owner.xywh)] });
  }
  return result;
}

export function buildMermaidEdgelessToolbarMenuItems(
  edgeless: BlockComponent,
  query = "",
): SelectionAction[] {
  const i18n = edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
  const collator = new Intl.Collator(i18n?.locale$.value, {
    sensitivity: "base",
    numeric: true,
  });
  const templates = getMermaidEdgelessToolbarTemplates().sort((a, b) =>
    collator.compare(a.label, b.label),
  );
  const actions = (
    items: readonly MermaidEdgelessToolbarTemplate[],
  ): SelectionAction[] =>
    items.map((template) => ({
      id: `myoxus-mermaid-edgeless-template-${template.id}`,
      label: template.label,
      disabled: edgeless.store.readonly,
      run: () => void insertMermaidEdgelessToolbarTemplate(edgeless, template),
    }));
  const imports = [
    createMermaidMmdImportMenuItem(edgeless),
    createMermaidMindmapImportMenuItem(edgeless),
  ];
  if (query) {
    const needle = query.toLocaleLowerCase(i18n?.locale$.value);
    return [...actions(templates), ...imports].filter((action) =>
      action.label.toLocaleLowerCase(i18n?.locale$.value).includes(needle),
    );
  }
  return [
    ...MERMAID_PRODUCT_CATEGORY_IDS.map((category): SelectionAction => ({
      id: `mermaid-template-category-${category}`,
      label: resolveEditorMessage(categoryMessages[category], i18n),
      disabled: edgeless.store.readonly,
      control: {
        type: "menu",
        items: actions(
          templates.filter((template) => template.category === category),
        ),
      },
    })),
    {
      id: "mermaid-template-imports",
      label: "",
      disabled: edgeless.store.readonly,
      actions: imports,
    },
  ];
}

export const buildMermaidSeniorTool: ToolBuilder<SeniorTool> = ({
  block,
  toolbarContainer,
}) => ({
  name: titleMessage,
  enable: !block.store.readonly,
  content: {
    type: "control",
    controls: {
      action: {
        id: "myoxus-mermaid-edgeless-toolbar-button",
        label: resolveEditorMessage(
          titleMessage,
          block.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        disabled: block.store.readonly,
      },
      menu: {
        searchPlaceholder: mermaidMessages.toolbarSearchPlaceholder(),
        onOpen: () => {
          const toolbar = toolbarContainer.closest<EdgelessToolbarWidget>(
            EDGELESS_TOOLBAR_WIDGET,
          );
          toolbar?.activePopper?.dispose();
          if (toolbar) toolbar.activePopper = null;
        },
        actions: (query) => buildMermaidEdgelessToolbarMenuItems(block, query),
      },
      nativeArtwork: mermaidToolbarSymbol(),
      artworkBounds: { width: 64, height: 64 },
    },
  },
});

export const mermaidSeniorTool = SeniorToolExtension(
  "mermaid",
  buildMermaidSeniorTool,
);
