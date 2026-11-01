import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";

import type { MyoxusUserInfo } from "./types";

export interface WriterInfoService {
  getWriterInfo(): MyoxusUserInfo | null;
}

export const WriterInfoProvider = createIdentifier<WriterInfoService>(
  "myoxus-writer-info-service",
);

export function WriterInfoServiceExtension(
  service: WriterInfoService,
): ExtensionType {
  return {
    setup(di) {
      di.addImpl(WriterInfoProvider, () => service);
    },
  };
}
