import { StoreExtensionManager } from "@virgultum/core/extensions";

import { getInternalStoreExtensions } from "../../extensions/store";

const manager = new StoreExtensionManager(getInternalStoreExtensions());

export const testStoreExtensions = manager.get("store");
