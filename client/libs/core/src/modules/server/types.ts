import type {
  CredentialsRequirementType,
  OAuthProviderType,
  ServerDeploymentType,
  ServerFeature,
} from "@myoxus/graphql";

export interface ServerMetadata {
  id: string;

  baseUrl: string;
}

export interface ServerConfig {
  serverName: string;
  features: ServerFeature[];
  oauthProviders: OAuthProviderType[];
  type: ServerDeploymentType;
  initialized?: boolean;
  version?: string;
  credentialsRequirement: CredentialsRequirementType;
  /** When true, the editor uses execCommand clipboard fallback (no HTTPS required). */
  clipboardHttpFallback?: boolean;
  /** Admin-configured list of allowed locale codes for the web frontend language selector. */
  availableLocales?: string[];
  preview?: {
    maxConcurrentRequests: number;
    requestTimeoutMs: number;
    retryCount: number;
  };
}
