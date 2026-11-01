import { ServerDeploymentType } from "@myoxus/graphql";

import type { ServerConfig, ServerMetadata } from "./types";

/** Browser Web owns its serving origin. Native clients only use the persisted
 * server list; a release channel is never a network destination. Keep the Web
 * ID stable because existing workspace flavours refer to it. */
export const BUILD_IN_SERVERS: (ServerMetadata & { config: ServerConfig })[] =
  BUILD_CONFIG.isNative || typeof location === "undefined"
    ? []
    : [
        {
          id: "myoxus-cloud",
          baseUrl: location.origin,
          config: {
            serverName: environment.isSelfHosted
              ? "Myoxus Standalone"
              : "Myoxus Server",
            features: [],
            oauthProviders: [],
            type: environment.isSelfHosted
              ? ServerDeploymentType.Standalone
              : ServerDeploymentType.Cloud,
            credentialsRequirement: {
              password: { minLength: 8, maxLength: 128 },
            },
          },
        },
      ];

export { normalizeServerBaseUrl } from "@myoxus/desktop-api-contract";
