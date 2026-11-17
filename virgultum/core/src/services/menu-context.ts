import type { BlockStdScope, EditorHost } from "@virgultum/core/runtime";
import type { GfxModel } from "@virgultum/core/runtime/gfx";
import type { BlockModel, Store } from "@virgultum/core/store";

export abstract class MenuContext {
  abstract get doc(): Store;

  get firstElement(): GfxModel | null {
    return null;
  }

  abstract get host(): EditorHost;

  abstract get selectedBlockModels(): BlockModel[];

  abstract get std(): BlockStdScope;

  // Sometimes we need to close the menu.
  close() {}

  isElement() {
    return false;
  }

  abstract isEmpty(): boolean;

  abstract isMultiple(): boolean;

  abstract isSingle(): boolean;
}
