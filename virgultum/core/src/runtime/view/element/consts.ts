import { createContext } from "@lit/context";
import type { BlockModel } from "../../../store/index";

import type { BlockService } from "../../extension/index.js";

export const modelContext = createContext<BlockModel>("model");
export const serviceContext = createContext<BlockService>("service");
export const blockComponentSymbol = Symbol("blockComponent");
export const WIDGET_ID_ATTR = "data-widget-id";
export const BLOCK_ID_ATTR = "data-block-id";

// Data-only consumers import view registrations in Node without mounting them.
export const NativeViewElement =
  globalThis.HTMLElement ?? (class {} as typeof HTMLElement);
