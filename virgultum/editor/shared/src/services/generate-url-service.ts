import { createIdentifier } from "@virgultum/global/di";
import type { ReferenceParams } from "@virgultum/model";
import type { ExtensionType } from "@virgultum/store";

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
