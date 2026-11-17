import {
  createIdentifier,
  type ServiceIdentifier,
} from "../../primitives/di/index";
import type { ExtensionType } from "../../store/index";

import type { BlockAdapterMatcher } from "../types/adapter.js";
import type { MarkdownDeltaConverter } from "./delta-converter.js";
import type { MarkdownAST } from "./type.js";

export type BlockMarkdownAdapterMatcher = BlockAdapterMatcher<
  MarkdownAST,
  MarkdownDeltaConverter
>;

export const BlockMarkdownAdapterMatcherIdentifier =
  createIdentifier<BlockMarkdownAdapterMatcher>("BlockMarkdownAdapterMatcher");

export function BlockMarkdownAdapterExtension(
  matcher: BlockMarkdownAdapterMatcher,
): ExtensionType & {
  identifier: ServiceIdentifier<BlockMarkdownAdapterMatcher>;
} {
  const identifier = BlockMarkdownAdapterMatcherIdentifier(matcher.flavour);
  return {
    setup: (di) => {
      di.addImpl(identifier, () => matcher);
    },
    identifier,
  };
}
