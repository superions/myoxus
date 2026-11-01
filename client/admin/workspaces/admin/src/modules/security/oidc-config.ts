// SPDX-License-Identifier: AGPL-3.0-or-later

export interface SimpleProviderConfig {
  clientId: string;
  clientSecret: string;
}

/** Display-only ancestry from all OUs, including inactive units. Missing
 * ancestors and cycles stop traversal; UUIDs remain the rule identity.
 */
export function oidcUnitLabels(
  units: readonly {
    id: string;
    name: string;
    slug: string;
    parentUnitId: string | null;
  }[],
): Map<string, string> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const labels = new Map(
    units.map((unit) => {
      const names: string[] = [];
      const seen = new Set<string>();
      let current: typeof unit | undefined = unit;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        names.unshift(current.name);
        current = current.parentUnitId
          ? byId.get(current.parentUnitId)
          : undefined;
      }
      return [unit.id, names.join(" / ")];
    }),
  );
  const counts = new Map<string, number>();
  for (const label of labels.values())
    counts.set(label, (counts.get(label) ?? 0) + 1);
  // Same-name siblings are valid too; ancestry alone cannot distinguish them.
  for (const unit of units) {
    const label = labels.get(unit.id)!;
    if (counts.get(label)! > 1) labels.set(unit.id, `${label} · ${unit.slug}`);
  }
  return labels;
}

/** Catalog read access only. Credentials returned by Admin may be mask values. */
export type OidcGroupDirectoryConfig =
  | { type: "authentik"; baseUrl: string; token: string }
  | {
      type: "keycloak";
      baseUrl: string;
      realm: string;
      clientId: string;
      clientSecret: string;
      claimValueMode: "name" | "path";
    };

/** Mutation and query projections may order identical JSON keys differently. */
export function equalOidcGroupDirectory(
  left: OidcGroupDirectoryConfig | null | undefined,
  right: OidcGroupDirectoryConfig | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  if (left.baseUrl !== right.baseUrl) return false;
  if (left.type === "authentik" && right.type === "authentik")
    return left.token === right.token;
  if (left.type === "keycloak" && right.type === "keycloak") {
    return (
      left.realm === right.realm &&
      left.clientId === right.clientId &&
      left.clientSecret === right.clientSecret &&
      left.claimValueMode === right.claimValueMode
    );
  }
  return false;
}

export interface OidcProviderConfig {
  clientId: string;
  clientSecret: string;
  issuerUrl?: string;
  discoveryUrl?: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  jwksUrl?: string;
  scopes: string[];
  claims: OidcClaimsConfig;
  groupMapping: OidcGroupMappingConfig;
  /** Omission leaves old providers unchanged; null explicitly removes access. */
  groupDirectory?: OidcGroupDirectoryConfig | null;
}

export type OAuthProviderConfig =
  | SimpleProviderConfig
  | (Partial<OidcProviderConfig> & {
      scopes?: string | string[];
      userIdField?: string;
      userEmailField?: string;
      userNameField?: string;
      userAvatarField?: string;
    })
  | null
  | undefined;

export type OidcGroupsSource = "userinfo" | "id_token" | "both";
export type OidcRole = "reader" | "member" | "manager";
export type OidcMissingGroupsPolicy =
  "deny_login" | "allow_without_memberships";
export type OidcUnknownGroupsPolicy = "ignore" | "deny_login";
export type OidcProviderPresetId = "custom" | "authentik" | "keycloak";

export interface OidcClaimsConfig {
  subject: string;
  email: string;
  emailVerified: string;
  name: string;
  avatar: string;
  groups: string;
  groupsSource: OidcGroupsSource;
}

export interface OidcGroupMappingRuleConfig {
  providerGroup: string;
  targetUnitId: string;
  role?: OidcRole;
}

/** Form completeness only; provider lookup and server authorization stay separate. */
export function oidcMappingRuleError(
  rule: OidcGroupMappingRuleConfig,
):
  | "admin.security.oauth.mapping-group-required"
  | "admin.security.oauth.mapping-unit-required"
  | "admin.security.oauth.mapping-role-invalid"
  | undefined {
  if (!rule.providerGroup.trim())
    return "admin.security.oauth.mapping-group-required";
  if (!rule.targetUnitId.trim())
    return "admin.security.oauth.mapping-unit-required";
  if (
    rule.role !== undefined &&
    !ROLE_OPTIONS.some((option) => option.value === rule.role)
  )
    return "admin.security.oauth.mapping-role-invalid";
  return undefined;
}

export interface OidcGroupMappingConfig {
  enabled: boolean;
  defaultRole: OidcRole;
  removeMissingOidcMemberships: boolean;
  missingGroupsPolicy: OidcMissingGroupsPolicy;
  unknownGroups: OidcUnknownGroupsPolicy;
  mappings: OidcGroupMappingRuleConfig[];
}

export const OIDC_DEFAULTS: Omit<
  OidcProviderConfig,
  "clientId" | "clientSecret"
> = {
  issuerUrl: "",
  discoveryUrl: "",
  authUrl: "",
  tokenUrl: "",
  userinfoUrl: "",
  jwksUrl: "",
  scopes: ["openid", "profile", "email"],
  claims: {
    subject: "sub",
    email: "email",
    emailVerified: "email_verified",
    name: "name",
    avatar: "picture",
    groups: "groups",
    groupsSource: "userinfo",
  },
  groupMapping: {
    enabled: false,
    defaultRole: "member",
    removeMissingOidcMemberships: true,
    missingGroupsPolicy: "deny_login",
    unknownGroups: "ignore",
    mappings: [],
  },
};

export const ROLE_OPTIONS: Array<{ value: OidcRole; labelKey: string }> = [
  { value: "reader", labelKey: "admin.security.oauth.role-reader" },
  { value: "member", labelKey: "admin.security.oauth.role-member" },
  { value: "manager", labelKey: "admin.security.oauth.role-manager" },
];

export const GROUPS_SOURCE_OPTIONS: Array<{
  value: OidcGroupsSource;
  labelKey: string;
}> = [
  {
    value: "userinfo",
    labelKey: "admin.security.oauth.groups-source-userinfo",
  },
  {
    value: "id_token",
    labelKey: "admin.security.oauth.groups-source-id-token",
  },
  { value: "both", labelKey: "admin.security.oauth.groups-source-both" },
];

export const OIDC_PROVIDER_PRESETS: Array<{
  value: OidcProviderPresetId;
  labelKey: string;
}> = [
  { value: "custom", labelKey: "admin.security.oauth.preset-custom" },
  { value: "authentik", labelKey: "admin.security.oauth.preset-authentik" },
  { value: "keycloak", labelKey: "admin.security.oauth.preset-keycloak" },
];

export function normalizeScopes(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : OIDC_DEFAULTS.scopes;
  const scopes = raw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return Array.from(new Set(scopes.length > 0 ? scopes : OIDC_DEFAULTS.scopes));
}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function issuerFromConfig(form: OidcProviderConfig): string {
  const issuer = form.issuerUrl?.trim();
  if (issuer) return stripTrailingSlash(issuer);
  const discovery = form.discoveryUrl?.trim();
  if (!discovery) return "";
  return stripTrailingSlash(
    discovery.replace(/\/\.well-known\/openid-configuration\/?$/, ""),
  );
}

function joinEndpoint(base: string, path: string, trailingSlash = false) {
  const endpoint = `${stripTrailingSlash(base)}/${path.replace(/^\/+/, "")}`;
  return trailingSlash ? `${stripTrailingSlash(endpoint)}/` : endpoint;
}

/**
 * Apply an operator-selected provider preset without creating a second config
 * shape. The returned object is still the server OIDC contract; presets only
 * derive conventional endpoints and safe claim defaults from the issuer URL.
 */
export function applyOidcProviderPreset(
  form: OidcProviderConfig,
  preset: OidcProviderPresetId,
): OidcProviderConfig {
  const base = issuerFromConfig(form);
  const common: OidcProviderConfig = {
    ...form,
    scopes: normalizeScopes(["openid", "profile", "email"]),
    claims: {
      ...form.claims,
      groups: form.claims.groups || OIDC_DEFAULTS.claims.groups,
      groupsSource: "both",
    },
    groupMapping: {
      ...form.groupMapping,
      defaultRole: form.groupMapping.defaultRole || "member",
      missingGroupsPolicy:
        form.groupMapping.missingGroupsPolicy || "deny_login",
      unknownGroups: form.groupMapping.unknownGroups || "ignore",
      removeMissingOidcMemberships:
        form.groupMapping.removeMissingOidcMemberships ?? true,
    },
  };

  if (preset === "custom") {
    return {
      ...form,
      scopes: normalizeScopes(form.scopes),
      groupMapping: {
        ...form.groupMapping,
        defaultRole: form.groupMapping.defaultRole || "member",
        missingGroupsPolicy:
          form.groupMapping.missingGroupsPolicy || "deny_login",
        unknownGroups: form.groupMapping.unknownGroups || "ignore",
        removeMissingOidcMemberships:
          form.groupMapping.removeMissingOidcMemberships ?? true,
      },
    };
  }

  if (!base) return common;

  if (preset === "authentik") {
    const issuerUrl = `${stripTrailingSlash(base)}/`;
    return {
      ...common,
      issuerUrl,
      discoveryUrl: `${issuerUrl}.well-known/openid-configuration`,
      authUrl: joinEndpoint(issuerUrl, "authorize", true),
      tokenUrl: joinEndpoint(issuerUrl, "token", true),
      userinfoUrl: joinEndpoint(issuerUrl, "userinfo", true),
      jwksUrl: joinEndpoint(issuerUrl, "jwks", true),
    };
  }

  return {
    ...common,
    issuerUrl: base,
    discoveryUrl: joinEndpoint(base, ".well-known/openid-configuration"),
    authUrl: joinEndpoint(base, "protocol/openid-connect/auth"),
    tokenUrl: joinEndpoint(base, "protocol/openid-connect/token"),
    userinfoUrl: joinEndpoint(base, "protocol/openid-connect/userinfo"),
    jwksUrl: joinEndpoint(base, "protocol/openid-connect/certs"),
  };
}

export function normalizeOidcProviderConfig(
  config: OAuthProviderConfig,
): OidcProviderConfig {
  const raw = (config ?? {}) as Partial<OidcProviderConfig> & {
    scopes?: string | string[];
    userIdField?: string;
    userEmailField?: string;
    userNameField?: string;
    userAvatarField?: string;
  };
  const claims = (raw.claims ?? {}) as Partial<OidcClaimsConfig>;
  const groupMapping = (raw.groupMapping ??
    {}) as Partial<OidcGroupMappingConfig>;

  return {
    clientId: raw.clientId ?? "",
    clientSecret: raw.clientSecret ?? "",
    issuerUrl: raw.issuerUrl ?? "",
    discoveryUrl: raw.discoveryUrl ?? "",
    authUrl: raw.authUrl ?? "",
    tokenUrl: raw.tokenUrl ?? "",
    userinfoUrl: raw.userinfoUrl ?? "",
    jwksUrl: raw.jwksUrl ?? "",
    ...(raw.groupDirectory === undefined
      ? {}
      : {
          groupDirectory:
            raw.groupDirectory === null ? null : { ...raw.groupDirectory },
        }),
    scopes: normalizeScopes(raw.scopes),
    claims: {
      subject:
        claims.subject ?? raw.userIdField ?? OIDC_DEFAULTS.claims.subject,
      email: claims.email ?? raw.userEmailField ?? OIDC_DEFAULTS.claims.email,
      emailVerified: claims.emailVerified ?? OIDC_DEFAULTS.claims.emailVerified,
      name: claims.name ?? raw.userNameField ?? OIDC_DEFAULTS.claims.name,
      avatar:
        claims.avatar ?? raw.userAvatarField ?? OIDC_DEFAULTS.claims.avatar,
      groups: claims.groups ?? OIDC_DEFAULTS.claims.groups,
      groupsSource: claims.groupsSource ?? OIDC_DEFAULTS.claims.groupsSource,
    },
    groupMapping: {
      enabled: groupMapping.enabled ?? OIDC_DEFAULTS.groupMapping.enabled,
      defaultRole:
        groupMapping.defaultRole ?? OIDC_DEFAULTS.groupMapping.defaultRole,
      removeMissingOidcMemberships:
        groupMapping.removeMissingOidcMemberships ??
        OIDC_DEFAULTS.groupMapping.removeMissingOidcMemberships,
      missingGroupsPolicy:
        groupMapping.missingGroupsPolicy ??
        OIDC_DEFAULTS.groupMapping.missingGroupsPolicy,
      unknownGroups:
        groupMapping.unknownGroups ?? OIDC_DEFAULTS.groupMapping.unknownGroups,
      mappings: groupMapping.mappings ?? [],
    },
  };
}

/**
 * Build the persisted Admin config object. Legacy field aliases are normalized
 * away here so Admin UI and first-run wizard always write the server-validated
 * OIDC contract: scopes are arrays, claims are nested, and OIDC-owned OU sync
 * is explicitly bounded to `source=oidc` memberships.
 */
export function serializeOidcProviderConfig(
  form: OidcProviderConfig,
): OidcProviderConfig {
  return {
    ...form,
    clientId: form.clientId.trim(),
    clientSecret: form.clientSecret.trim(),
    issuerUrl: form.issuerUrl?.trim() || undefined,
    discoveryUrl: form.discoveryUrl?.trim() || undefined,
    authUrl: form.authUrl.trim(),
    tokenUrl: form.tokenUrl.trim(),
    userinfoUrl: form.userinfoUrl.trim(),
    jwksUrl: form.jwksUrl?.trim() || undefined,
    scopes: normalizeScopes(form.scopes),
    claims: {
      subject: form.claims.subject.trim(),
      email: form.claims.email.trim(),
      emailVerified: form.claims.emailVerified.trim(),
      name: form.claims.name.trim(),
      avatar: form.claims.avatar.trim(),
      groups: form.claims.groups.trim(),
      groupsSource: form.claims.groupsSource,
    },
    groupMapping: {
      ...form.groupMapping,
      // Never discard a rule during serialization. Save callers must show its
      // validation failure and retain the complete draft for correction.
      mappings: form.groupMapping.mappings.map((mapping) => ({
        providerGroup: mapping.providerGroup.trim(),
        targetUnitId: mapping.targetUnitId.trim(),
        role: mapping.role,
      })),
    },
  };
}
