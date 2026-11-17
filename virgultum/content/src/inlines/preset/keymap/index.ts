import type { BlockStdScope, UIEventHandler } from "@virgultum/core/runtime";

import { textCommonKeymap } from "./basic";
import { bracketKeymap } from "./bracket";
import { textFormatKeymap } from "./format";

export const textKeymap = (
  std: BlockStdScope,
): Record<string, UIEventHandler> => {
  return {
    ...textCommonKeymap(std),
    ...bracketKeymap(std),
    ...textFormatKeymap(std),
  };
};
