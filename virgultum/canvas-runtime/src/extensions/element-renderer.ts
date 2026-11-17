import {
  createIdentifier,
  type ServiceIdentifier,
} from "@virgultum/core/primitives/di";
import type {
  GfxLocalElementModel,
  GfxPrimitiveElementModel,
} from "@virgultum/core/runtime/gfx";
import type { ExtensionType } from "@virgultum/core/store";

import type { ElementRenderer } from "../renderer/elements";

export const ElementRendererIdentifier =
  createIdentifier<unknown>("element-renderer");

export const ElementRendererExtension = <
  T extends GfxPrimitiveElementModel | GfxLocalElementModel,
>(
  id: string,
  renderer: ElementRenderer<T>,
): ExtensionType & {
  identifier: ServiceIdentifier<ElementRenderer<T>>;
} => {
  const identifier = ElementRendererIdentifier<ElementRenderer<T>>(id);
  return {
    setup: (di) => {
      di.addImpl(identifier, () => renderer);
    },
    identifier,
  };
};
