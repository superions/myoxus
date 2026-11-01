import { createMermaidMindmapImportMenuItem } from "./mindmap-file-actions.js";
import {
  menu,
  type MenuConfig,
  type MenuHandler,
  popMenu,
  popupTargetFromElement,
} from "@virgultum/components/context-menu";
import type { BlockComponent } from "@virgultum/std";
import { Bound } from "@virgultum/global/gfx";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import type { ToolType } from "@virgultum/std/gfx";
import {
  type SeniorTool,
  SeniorToolExtension,
  EdgelessToolbarToolMixin,
  type ToolBuilder,
} from "@virgultum/widget-edgeless-toolbar";
import { css, html, LitElement } from "lit";

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
} from "@virgultum/shared/services";
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
): MenuConfig[] {
  const i18n = edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
  const collator = new Intl.Collator(i18n?.locale$.value, {
    sensitivity: "base",
    numeric: true,
  });
  const templates = getMermaidEdgelessToolbarTemplates().sort((a, b) =>
    collator.compare(a.label, b.label),
  );
  const actions = (items: readonly MermaidEdgelessToolbarTemplate[]) =>
    items.map((template) =>
      menu.action({
        name: template.label,
        select: () =>
          void insertMermaidEdgelessToolbarTemplate(edgeless, template),
        testId: `myoxus-mermaid-edgeless-template-${template.id}`,
      }),
    );
  const grouped = MERMAID_PRODUCT_CATEGORY_IDS.map((category) =>
    menu.subMenu({
      name: resolveEditorMessage(categoryMessages[category], i18n),
      label: categoryMessages[category],
      openOnHover: false,
      options: {
        items: actions(
          templates.filter((template) => template.category === category),
        ),
        title: { text: resolveEditorMessage(categoryMessages[category], i18n) },
      },
    }),
  );
  return [
    // Search exposes matching types directly, without requiring a category hop.
    (current) =>
      html`${current.renderItems(current.searchName$.value ? actions(templates) : grouped)}`,
    menu.group({
      items: [
        createMermaidMmdImportMenuItem(edgeless),
        createMermaidMindmapImportMenuItem(edgeless),
      ],
    }),
  ];
}

export class EdgelessMermaidToolButton extends EdgelessToolbarToolMixin(
  LitElement,
) {
  static override styles = css`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }
  `;

  // Mermaid opens an insertion menu; it does not register a persistent GFX tool.
  override type: ToolType[] = [];

  private _menu: MenuHandler | null = null;

  private _toggleMenu(event: Event) {
    if (this._menu) {
      this._menu.close();
      this._menu = null;
      this.requestUpdate();
      return;
    }

    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;

    this.toolbar.activePopper?.dispose();
    this.toolbar.activePopper = null;
    this._menu = popMenu(popupTargetFromElement(target), {
      options: {
        i18n: this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
        items: buildMermaidEdgelessToolbarMenuItems(this.edgeless),
        onClose: () => {
          this._menu = null;
          this.requestUpdate();
        },
        search: {
          placeholder: mermaidMessages.toolbarSearchPlaceholder(),
        },
        title: {
          text: resolveEditorMessage(
            titleMessage,
            this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
          ),
        },
      },
      placement: "top-start",
    });
    this.requestUpdate();
  }

  override disconnectedCallback() {
    this._menu?.close();
    this._menu = null;
    super.disconnectedCallback();
  }

  override render() {
    return html`<edgeless-toolbar-button
      class="edgeless-mermaid-button"
      data-testid="myoxus-mermaid-edgeless-toolbar-button"
      .tooltip=${this._menu ? "" : resolveEditorMessage(titleMessage, this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined)}
      .tooltipOffset=${5}
      .iconSize=${"64px"}
      .active=${Boolean(this._menu)}
      .activeMode=${"background"}
      @click=${this._toggleMenu}
    >
      ${mermaidToolbarSymbol()}
    </edgeless-toolbar-button>`;
  }
}

export const buildMermaidSeniorTool: ToolBuilder<SeniorTool> = ({ block }) => {
  return {
    name: titleMessage,
    content: html`<edgeless-mermaid-tool-button
      .edgeless=${block}
    ></edgeless-mermaid-tool-button>`,
    enable: !block.store.readonly,
  };
};

export const mermaidSeniorTool = SeniorToolExtension(
  "mermaid",
  buildMermaidSeniorTool,
);
