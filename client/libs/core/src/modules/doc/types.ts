import type { DocProps } from "@myoxus/core/editor/initialization";
import type { DocMode } from "@virgultum/editor/model";

export interface DocCreateOptions {
  id?: string;
  title?: string;
  primaryMode?: DocMode;
  skipInit?: boolean;
  docProps?: DocProps;
  isTemplate?: boolean;
}
