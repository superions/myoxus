import type { ServiceIdentifier } from "../../primitives/di/index";

import { LifeCycleWatcherIdentifier } from "../identifier.js";
import type { GfxController } from "./controller.js";

export const gfxControllerKey = "GfxController";

export const GfxControllerIdentifier = LifeCycleWatcherIdentifier(
  gfxControllerKey,
) as ServiceIdentifier<GfxController>;
