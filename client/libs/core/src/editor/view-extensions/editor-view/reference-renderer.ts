import type { ReactToLit } from "@myoxus/lit-react";
import {
  type MyoxusReference,
  ReferenceNodeConfigExtension,
} from "@virgultum/editor/inlines/reference";
import type { ExtensionType } from "@virgultum/editor/store";

export type ReferenceReactRenderer = (
  reference: MyoxusReference,
) => React.ReactElement;

export function patchReferenceRenderer(
  reactToLit: ReactToLit,
  reactRenderer: ReferenceReactRenderer,
): ExtensionType {
  const customContent = (reference: MyoxusReference) => {
    const node = reactRenderer(reference);
    return reactToLit(node, true);
  };

  return ReferenceNodeConfigExtension({
    customContent,
    hidePopup: BUILD_CONFIG.isMobileEdition,
  });
}
