import {
  createIdentifier,
  type ServiceIdentifier,
} from "@virgultum/core/primitives/di";
import type { TextBuffer } from "@virgultum/core/adapters";
import type { ExtensionType } from "@virgultum/core/store";

import type { ElementModelMatcher } from "../../type.js";

export type ElementToPlainTextAdapterMatcher = ElementModelMatcher<TextBuffer>;

export const ElementToPlainTextAdapterMatcherIdentifier =
  createIdentifier<ElementToPlainTextAdapterMatcher>(
    "elementToPlainTextAdapterMatcher",
  );

export function ElementToPlainTextAdapterExtension(
  matcher: ElementToPlainTextAdapterMatcher,
): ExtensionType & {
  identifier: ServiceIdentifier<ElementToPlainTextAdapterMatcher>;
} {
  const identifier = ElementToPlainTextAdapterMatcherIdentifier(matcher.name);
  return {
    setup: (di) => {
      di.addImpl(identifier, () => matcher);
    },
    identifier,
  };
}
