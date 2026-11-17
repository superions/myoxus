import { createIdentifier } from "@virgultum/core/primitives/di";
import type { ExtensionType } from "@virgultum/core/store";

import type { PeekViewService } from "./type";

export const PeekViewProvider = createIdentifier<PeekViewService>(
  "MyoxusPeekViewProvider",
);

export function PeekViewExtension(service: PeekViewService): ExtensionType {
  return {
    setup: (di) => {
      di.override(PeekViewProvider, () => service);
    },
  };
}
