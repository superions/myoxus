import { ViewExtensionManager } from "@virgultum/editor/ext-loader";
import { getInternalViewExtensions } from "@virgultum/editor/extensions/view";
import { BlockViewIdentifier } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import { literal } from "lit/static-html.js";

const manager = new ViewExtensionManager([...getInternalViewExtensions()]);
const customPageEditorBlockSpecs: ExtensionType[] = [
  ...manager.get("page"),
  {
    setup: (di) => {
      di.override(
        BlockViewIdentifier("myoxus:page"),
        () => literal`myoxus-page-root`,
      );
    },
  },
];

export const getCustomPageEditorBlockSpecs = () => {
  return customPageEditorBlockSpecs;
};
