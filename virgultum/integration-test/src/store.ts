import { StoreExtensionManager } from "@virgultum/editor/ext-loader";
import { getInternalStoreExtensions } from "@virgultum/editor/extensions/store";

const manager = new StoreExtensionManager(getInternalStoreExtensions());

export function getTestStoreManager() {
  return manager;
}
