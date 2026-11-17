import { createIdentifier } from "../primitives/di/index";
import type { ReferenceParams } from "../models/index";
import type { ExtensionType } from "../store/index";

export interface GenerateDocUrlService {
  generateDocUrl: (
    docId: string,
    params?: ReferenceParams,
    workspaceId?: string,
  ) => string | void;
}

export const GenerateDocUrlProvider = createIdentifier<GenerateDocUrlService>(
  "GenerateDocUrlService",
);

export function GenerateDocUrlExtension(
  generateDocUrlProvider: GenerateDocUrlService,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(GenerateDocUrlProvider, generateDocUrlProvider);
    },
  };
}
