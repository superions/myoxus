import { createIdentifier } from "../../../primitives/di/index";

import type { Store } from "./store";

export const StoreIdentifier = createIdentifier<Store>("Store");
