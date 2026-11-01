import type { FrameworkProvider } from "@myoxus/infra";
import { DEFAULT_LINK_PREVIEW_ENDPOINT } from "@virgultum/editor/shared/consts";
import {
  LinkPreviewCacheIdentifier,
  type LinkPreviewCacheProvider,
  LinkPreviewService,
  LinkPreviewServiceIdentifier,
} from "@virgultum/editor/shared/services";
import { type ExtensionType } from "@virgultum/editor/store";
import type { Container } from "@virgultum/global/di";

import { ServerService } from "../../../modules/server/services/server";

class MyoxusLinkPreviewService extends LinkPreviewService {
  constructor(endpoint: string, cache: LinkPreviewCacheProvider) {
    super(cache);
    this.setEndpoint(endpoint);
  }
}

/**
 * Patch the link preview service, set the endpoint and cache
 * @param framework
 * @returns
 */
export function patchLinkPreviewService(
  framework: FrameworkProvider,
): ExtensionType {
  // get link preview service endpoint from server and BUILD_CONFIG
  let linkPreviewUrl: string;
  try {
    const server = framework.get(ServerService).server;
    linkPreviewUrl = new URL(
      BUILD_CONFIG.linkPreviewUrl || "/",
      server.baseUrl,
    ).toString();
  } catch (err) {
    console.error(
      "Invalid BUILD_CONFIG.linkPreviewUrl, falling back to default",
      err,
    );
    linkPreviewUrl = DEFAULT_LINK_PREVIEW_ENDPOINT;
  }

  return {
    setup: (di: Container) => {
      di.override(LinkPreviewServiceIdentifier, (provider) => {
        return new MyoxusLinkPreviewService(
          linkPreviewUrl,
          provider.get(LinkPreviewCacheIdentifier),
        );
      });
    },
  };
}
