import { createIdentifier } from "../primitives/di/index";
import type { ReferenceParams } from "../models/index";
import type { ExtensionType } from "../store/index";

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
