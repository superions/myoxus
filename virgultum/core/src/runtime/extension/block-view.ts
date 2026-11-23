import type { ExtensionType } from "../../store/index";

import { BlockViewIdentifier } from "../identifier.js";
import type { BlockViewType } from "../spec/type.js";

/** Register the trusted custom-element name for a block. Older registrations may supply a Lit literal. */
export function BlockViewExtension(
  flavour: string,
  view: BlockViewType,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(BlockViewIdentifier(flavour), () => view);
    },
  };
}
