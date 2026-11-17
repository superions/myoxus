import { createIdentifier } from "../primitives/di/index";
import type { ExtensionType } from "../store/index";
import { Subject } from "rxjs";

import type { Viewport } from "../types";

export const PageViewportService = createIdentifier<Subject<Viewport>>(
  "PageViewportService",
);

export const PageViewportServiceExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(PageViewportService, () => new Subject<Viewport>());
  },
};
