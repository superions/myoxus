import {
  GfxCompatible,
  type GfxCompatibleProps,
  type GfxElementGeometry,
  type GfxModel,
} from "@virgultum/std/gfx";
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text,
} from "@virgultum/store";

import {
  type BlockMeta,
  type GfxGroupChildProps,
  GfxGroupCompatibleBlockModel,
} from "../../utils/index.js";

export const DEFAULT_MERMAID_BLOCK_TITLE = "Mermaid diagram";
export const MERMAID_BLOCK_DIAGRAM_VERSION = 1;

export type MermaidBlockProps = {
  comments?: Record<string, boolean>;
  diagramVersion: number;
  diagramType: string | null;
  /** Family identity bindings only; Source remains authoritative. */
  familyData: string;
  displayMode: "display" | "edit";
  lastValidSource?: string;
  renderEngine: string | null;
  renderHash: string | null;
  source: Text;
  sourceHash: string;
  templateId?: string;
  title: Text;
  viewportHeight: number | null;
} & BlockMeta &
  GfxCompatibleProps &
  GfxGroupChildProps;

export const MermaidBlockSchema = defineBlockSchema({
  flavour: "myoxus:mermaid",
  props: (internal): MermaidBlockProps => ({
    comments: undefined,
    childElementIds: Object.create(null),
    diagramVersion: MERMAID_BLOCK_DIAGRAM_VERSION,
    diagramType: null,
    familyData: "",
    displayMode: "edit",
    lastValidSource: "",
    index: "a0",
    lockedBySelf: false,
    renderEngine: null,
    renderHash: null,
    source: internal.Text(),
    sourceHash: "",
    templateId: undefined,
    title: internal.Text(),
    viewportHeight: null,
    xywh: "[0,0,100,100]",
    "meta:createdAt": undefined,
    "meta:createdBy": undefined,
    "meta:updatedAt": undefined,
    "meta:updatedBy": undefined,
  }),
  metadata: {
    version: 2,
    role: "content",
    parent: [
      "myoxus:footnote-definition",
      "myoxus:note",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:edgeless-text",
      "myoxus:surface",
    ],
    children: [],
  },
  toModel: () => new MermaidBlockModel(),
});

export const MermaidBlockSchemaExtension =
  BlockSchemaExtension(MermaidBlockSchema);

export class MermaidBlockModel
  extends GfxGroupCompatibleBlockModel<MermaidBlockProps>(
    GfxCompatible<MermaidBlockProps>(BlockModel),
  )
  implements GfxElementGeometry
{
  readonly managesChildMembership = true;

  private _ownsMermaidChild(element: GfxModel) {
    const role = (
      element as { yMap?: { get?: (key: string) => unknown } }
    ).yMap?.get?.("mermaidRole");
    const hasOwnedRole =
      role === "mermaid-flowchart-node" ||
      role === "mermaid-flowchart-edge" ||
      role === "mermaid-flowchart-subgraph" ||
      role === "mermaid-relationship-detail" ||
      role === "mermaid-diagram-title";
    return (
      hasOwnedRole &&
      !element.groups.some(
        (group) =>
          group !== this &&
          "flavour" in group &&
          group.flavour === "myoxus:mermaid",
      )
    );
  }

  override addChild(element: GfxModel) {
    if (this._ownsMermaidChild(element)) super.addChild(element);
  }

  override addChildren(elements: GfxModel[]) {
    const additions = elements.filter(
      (element) => !this.hasChild(element) && this._ownsMermaidChild(element),
    );
    // Reconciliation frequently rediscovers the current child set. An empty
    // group update would replace its Y.Map and create a spurious undo step.
    if (additions.length > 0) super.addChildren(additions);
  }
}
