import { ViewExtensionManager } from "@virgultum/editor/ext-loader";
import { getInternalViewExtensions } from "@virgultum/editor/extensions/view";

const manager = new ViewExtensionManager(getInternalViewExtensions());

export function getTestViewManager() {
  return manager;
}
