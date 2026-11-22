import {
  type Container,
  createIdentifier,
} from "@virgultum/core/primitives/di";
import type { SurfaceElementModelMap } from "@virgultum/core/models";
import { EditPropsStore } from "@virgultum/core/services";
import { type BlockStdScope, StdIdentifier } from "@virgultum/core/runtime";
import {
  GfxBlockElementModel,
  GfxControllerIdentifier,
  type GfxModel,
  isGfxGroupCompatibleModel,
} from "@virgultum/core/runtime/gfx";
import { type BlockModel, type Store } from "@virgultum/core/store";

import type { SurfaceBlockModel } from "../surface-model";
import { getLastPropsKey } from "../utils/get-last-props-key";
import { isConnectable, isNoteBlock } from "./query";

export const EdgelessCRUDIdentifier = createIdentifier<CanvasDocumentCommands>(
  "MyoxusEdgelessCrudService",
);

/** Commands borrow the current document and layer order. History boundaries
 * belong to the initiating tool; neither camera state nor view elements are
 * required to edit a surface. */
export class CanvasDocumentCommands {
  constructor(
    private readonly store: Store,
    private readonly surface: () => SurfaceBlockModel | null,
    private readonly nextIndex: () => string,
    private readonly settings: () => Pick<
      EditPropsStore,
      "applyLastProps" | "recordLastProps"
    >,
  ) {}

  private get _surface() {
    return this.surface();
  }

  deleteElements = (elements: GfxModel[]) => {
    if (
      this.store.readonly ||
      elements.some((element) => this.store.hasFixedText(element.id))
    )
      return;
    const surface = this._surface;
    if (!surface) {
      console.error("surface is not initialized");
      return;
    }

    const set = new Set(elements);
    elements.forEach((element) => {
      if (isConnectable(element)) {
        const connectors = surface.getConnectors(element.id);
        connectors.forEach((connector) => set.add(connector));
      }
    });

    set.forEach((element) => {
      if (isNoteBlock(element)) {
        const children = this.store.root?.children ?? [];
        if (children.length > 1) {
          this.store.deleteBlock(element);
        }
      } else if (surface.hasElementById(element.id))
        surface.deleteElement(element.id);
      else {
        const block = this.store.getModelById(element.id);
        if (block) this.store.deleteBlock(block);
      }
    });
  };

  addBlock = (
    flavour: string,
    props: Record<string, unknown>,
    parentId?: string | BlockModel,
    parentIndex?: number,
  ) => {
    const key = getLastPropsKey(flavour, props);
    if (key) {
      props = this.settings().applyLastProps(key, props);
    }

    const nProps = {
      ...props,
      index: this.nextIndex(),
    };

    return this.store.addBlock(flavour as never, nProps, parentId, parentIndex);
  };

  addElement = <T extends Record<string, unknown>>(type: string, props: T) => {
    const surface = this._surface;
    if (!surface) {
      console.error("surface is not initialized");
      return;
    }

    const key = getLastPropsKey(type, props);
    if (key) {
      props = this.settings().applyLastProps(key, props) as T;
    }

    const nProps = {
      ...props,
      type,
      index: props.index ?? this.nextIndex(),
    };

    return surface.addElement(nProps);
  };

  updateElement = (id: string, props: Record<string, unknown>) => {
    const surface = this._surface;
    if (!surface) {
      console.error("surface is not initialized");
      return;
    }

    const element = surface.getElementById(id);
    if (element) {
      const key = getLastPropsKey(element.type, {
        ...element.yMap.toJSON(),
        ...props,
      });
      key && this.settings().recordLastProps(key, props);
      surface.updateElement(id, props);
      return;
    }

    const block = this.store.getModelById(id);
    if (block) {
      const key = getLastPropsKey(block.flavour, {
        ...block.yBlock.toJSON(),
        ...props,
      });
      key && this.settings().recordLastProps(key, props);
      this.store.updateBlock(block, props);
    }
  };

  getElementById(id: string): GfxModel | null {
    const surface = this._surface;
    if (!surface) {
      return null;
    }
    const el = surface.getElementById(id) ?? this.store.getModelById(id);
    return el as GfxModel | null;
  }

  getElementsByType<K extends keyof SurfaceElementModelMap>(
    type: K,
  ): SurfaceElementModelMap[K][] {
    if (!this._surface) {
      return [];
    }
    return this._surface.getElementsByType(type);
  }

  removeElement(id: string | GfxModel) {
    id = typeof id === "string" ? id : id.id;

    const el = this.getElementById(id);
    if (isGfxGroupCompatibleModel(el)) {
      el.childIds.forEach((childId) => {
        this.removeElement(childId);
      });
    }

    if (el instanceof GfxBlockElementModel) {
      this.store.deleteBlock(el);
      return;
    }

    if (this._surface?.hasElementById(id)) {
      this._surface.deleteElement(id);
      return;
    }
  }
}

export class EdgelessCRUDExtension extends CanvasDocumentCommands {
  constructor(std: BlockStdScope) {
    super(
      std.store,
      () =>
        std.get(GfxControllerIdentifier).surface as SurfaceBlockModel | null,
      () => std.get(GfxControllerIdentifier).layer.generateIndex(),
      () => std.get(EditPropsStore),
    );
  }
  static setup(di: Container) {
    di.add(this, [StdIdentifier]);
    di.addImpl(EdgelessCRUDIdentifier, (p) => p.get(this));
  }
}
