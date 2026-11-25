import type { Constructor } from "@virgultum/core/primitives/utils";

import {
  // oxlint-disable-next-line no-unused-vars
  type EdgelessToolbarToolClass,
  EdgelessToolbarToolMixin,
} from "./tool.mixin.js";

export declare abstract class ToolbarButtonWithMenuClass extends EdgelessToolbarToolClass {}

export const ToolbarButtonWithMenuMixin = <
  T extends Constructor<HTMLElement> = Constructor<HTMLElement>,
>(
  SuperClass: T,
) => {
  abstract class DerivedClass extends EdgelessToolbarToolMixin(SuperClass) {}

  return DerivedClass as unknown as T & Constructor<ToolbarButtonWithMenuClass>;
};
