import { createIdentifier } from "@virgultum/global/di";
import type { ReferenceParams } from "@virgultum/model";
import type { ExtensionType } from "@virgultum/store";

export interface ParseDocUrlService {
  parseDocUrl: (
    url: string,
  ) => ({ docId: string; workspaceId?: string } & ReferenceParams) | undefined;
}

export const ParseDocUrlProvider =
  createIdentifier<ParseDocUrlService>("ParseDocUrlService");

export function ParseDocUrlExtension(
  parseDocUrlService: ParseDocUrlService,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(ParseDocUrlProvider, parseDocUrlService);
    },
  };
}
