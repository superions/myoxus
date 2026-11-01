import type { ExtensionType } from "@virgultum/editor/store";
import { createIdentifier, type ServiceIdentifier } from "@virgultum/global/di";
import type { MarkdownAST } from "@virgultum/shared/adapters";

import type { ElementModelMatcher } from "../../type.js";

export type ElementToMarkdownAdapterMatcher = ElementModelMatcher<MarkdownAST>;

export const ElementToMarkdownAdapterMatcherIdentifier =
  createIdentifier<ElementToMarkdownAdapterMatcher>(
    "elementToMarkdownAdapterMatcher",
  );

export function ElementToMarkdownAdapterExtension(
  matcher: ElementToMarkdownAdapterMatcher,
): ExtensionType & {
  identifier: ServiceIdentifier<ElementToMarkdownAdapterMatcher>;
} {
  const identifier = ElementToMarkdownAdapterMatcherIdentifier(matcher.name);
  return {
    setup: (di) => {
      di.addImpl(identifier, () => matcher);
    },
    identifier,
  };
}
