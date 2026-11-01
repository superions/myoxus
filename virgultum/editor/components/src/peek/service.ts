import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";

import type { PeekViewService } from "./type.js";

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
