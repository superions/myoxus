import { generateUrl } from "@myoxus/core/components/hooks/myoxus/use-share-url";
import { resolveLinkToDoc } from "@myoxus/core/modules/navigation/utils";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { FrameworkProvider } from "@myoxus/infra";
import { type ReferenceParams } from "@virgultum/editor/model";
import {
  GenerateDocUrlExtension,
  ParseDocUrlExtension,
} from "@virgultum/editor/shared/services";

function patchParseDocUrlExtension(framework: FrameworkProvider) {
  const workspaceServerService = framework.get(WorkspaceServerService);
  const baseUrl = workspaceServerService.server?.baseUrl ?? location.origin;
  const ParseDocUrl = ParseDocUrlExtension({
    parseDocUrl(url) {
      const info = resolveLinkToDoc(url, baseUrl);
      if (!info) return;

      delete info.refreshKey;

      return info;
    },
  });

  return ParseDocUrl;
}

function patchGenerateDocUrlExtension(framework: FrameworkProvider) {
  const workspaceService = framework.get(WorkspaceService);
  const workspaceServerService = framework.get(WorkspaceServerService);
  const baseUrl = workspaceServerService.server?.baseUrl ?? location.origin;
  const GenerateDocUrl = GenerateDocUrlExtension({
    generateDocUrl(
      pageId: string,
      params?: ReferenceParams,
      workspaceId?: string,
    ) {
      return generateUrl({
        ...params,
        pageId,
        workspaceId: workspaceId ?? workspaceService.workspace.id,
        baseUrl,
      });
    },
  });

  return GenerateDocUrl;
}

export function patchDocUrlExtensions(framework: FrameworkProvider) {
  return [
    patchParseDocUrlExtension(framework),
    patchGenerateDocUrlExtension(framework),
  ];
}
