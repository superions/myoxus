import { UserFriendlyError } from "@myoxus/error";
import {
  gqlFetcherFactory,
  type OauthProvidersQuery,
  oauthProvidersQuery,
  type ServerConfigQuery,
  serverConfigQuery,
  ServerFeature,
} from "@myoxus/graphql";
import { Store } from "@myoxus/infra";
import { desktopServerRequestUrl } from "@myoxus/desktop-api-contract";
import type { ServerListStore } from "./server-list";

export type ServerConfigType = ServerConfigQuery["serverConfig"] &
  OauthProvidersQuery["serverConfig"];

const NETWORK_ERROR_PATTERNS = [
  /failed to fetch/i,
  /network request failed/i,
  /fetch failed/i,
  /load failed/i,
  /networkerror/i,
  /cors/i,
  /certificate/i,
  /ssl/i,
  /err_[a-z_]+/i,
];

function mapServerConfigError(error: unknown) {
  const userFriendlyError = UserFriendlyError.fromAny(error);
  if (
    userFriendlyError.is("NETWORK_ERROR") ||
    userFriendlyError.is("REQUEST_ABORTED") ||
    userFriendlyError.is("TOO_MANY_REQUEST")
  ) {
    return userFriendlyError;
  }

  if (error instanceof Error) {
    const detail = `${error.name}: ${error.message}`;
    if (NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
      return new UserFriendlyError({
        status: 504,
        code: "NETWORK_ERROR",
        type: "NETWORK_ERROR",
        name: "NETWORK_ERROR",
        message: detail,
        stacktrace: error.stack,
      });
    }
  }

  return userFriendlyError;
}

export class ServerConfigStore extends Store {
  constructor(private readonly serverListStore: ServerListStore) {
    super();
  }

  async fetchServerConfig(
    serverBaseUrl: string,
    abortSignal?: AbortSignal,
  ): Promise<ServerConfigType> {
    try {
      const registered = BUILD_CONFIG.isElectron
        ? this.serverListStore
            .getServerList()
            .find((server) => server.baseUrl === serverBaseUrl)
        : undefined;
      const gql = gqlFetcherFactory(
        registered
          ? desktopServerRequestUrl(registered.id, "/graphql")
          : `${serverBaseUrl}/graphql`,
        // Registration is the one explicit, public handshake before a server
        // ID exists. It carries no cookies; all later reads use the ID route.
        (input, init) =>
          globalThis.fetch(
            input,
            BUILD_CONFIG.isElectron && !registered
              ? { ...init, credentials: "omit", redirect: "error" }
              : init,
          ),
      );
      const serverConfigData = await gql({
        query: serverConfigQuery,
        context: {
          signal: abortSignal,
          headers: {
            "x-myoxus-version": BUILD_CONFIG.appVersion,
          },
        },
      });
      if (
        serverConfigData.serverConfig.features.includes(ServerFeature.OAuth)
      ) {
        const oauthProvidersData = await gql({
          query: oauthProvidersQuery,
          context: {
            signal: abortSignal,
            headers: {
              "x-myoxus-version": BUILD_CONFIG.appVersion,
            },
          },
        });
        return {
          ...serverConfigData.serverConfig,
          ...oauthProvidersData.serverConfig,
        };
      }
      return { ...serverConfigData.serverConfig, oauthProviders: [] };
    } catch (error) {
      throw mapServerConfigError(error);
    }
  }
}
