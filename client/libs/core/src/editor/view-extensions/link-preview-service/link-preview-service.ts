import type { FrameworkProvider } from "@myoxus/infra";
import { DEFAULT_LINK_PREVIEW_ENDPOINT } from "@virgultum/editor/shared/consts";
import {
  LinkPreviewCacheIdentifier,
  type LinkPreviewCacheProvider,
  LinkPreviewService,
  LinkPreviewServiceIdentifier,
} from "@virgultum/editor/shared/services";
import { type ExtensionType } from "@virgultum/editor/store";
import type { Container } from "@virgultum/core/primitives/di";

import { ServerService } from "../../../modules/server/services/server";

export function workspaceLinkPreview(
  baseUrl: string,
  cache: LinkPreviewCacheProvider,
) {
  let linkPreviewUrl: string;
  try {
    linkPreviewUrl = new URL(
      BUILD_CONFIG.linkPreviewUrl || "/",
      baseUrl,
    ).toString();
  } catch (err) {
    console.error(
      "Invalid BUILD_CONFIG.linkPreviewUrl, falling back to default",
      err,
    );
    linkPreviewUrl = DEFAULT_LINK_PREVIEW_ENDPOINT;
  }

  const service = new LinkPreviewService(cache);
  service.setEndpoint(linkPreviewUrl);
  return service;
}

export function patchLinkPreviewService(
  framework: FrameworkProvider,
): ExtensionType {
  const baseUrl = framework.get(ServerService).server.baseUrl;
  return {
    setup: (di: Container) => {
      di.override(LinkPreviewServiceIdentifier, (provider) => {
        return workspaceLinkPreview(
          baseUrl,
          provider.get(LinkPreviewCacheIdentifier),
        );
      });
    },
  };
}
