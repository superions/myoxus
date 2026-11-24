import type { MountReactPortal } from "@myoxus/lit-react";
import {
  type MyoxusReference,
  ReferenceNodeConfigExtension,
} from "@virgultum/editor/inlines/reference";
import type { ExtensionType } from "@virgultum/editor/store";

export type ReferenceReactRenderer = (
  reference: MyoxusReference,
) => React.ReactElement;

export function patchReferenceRenderer(
  mount: MountReactPortal,
  reactRenderer: ReferenceReactRenderer,
): ExtensionType {
  const customContent = (target: HTMLElement, reference: MyoxusReference) =>
    mount(target, reactRenderer(reference));

  return ReferenceNodeConfigExtension({
    customContent,
    hidePopup: BUILD_CONFIG.isMobileEdition,
  });
}
