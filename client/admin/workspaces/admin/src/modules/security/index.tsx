// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security administration page.
 *
 * Owns every operator-facing authentication and request-protection setting:
 * local sign-up rules, OAuth providers, CORS allow-lists and CAPTCHA tuning.
 * This module intentionally mirrors the existing config API structure instead
 * of inventing a second settings root; each tab writes the original server
 * module (`auth`, `oauth`, `cors`, `captcha`) via `useAppConfig` or the shared
 * `adminUpdateConfig` mutation.
 */
import { CaBundleManagement } from "./ca-bundle-management";
import { OidcGroupPicker } from "./oidc-group-picker";
import { useOidcGroupDirectory } from "./oidc-group-directory";
import { adminToast as toast } from "@myoxus/admin/notifications";
import { UserFriendlyError } from "@myoxus/error";
import {
  adminConfigValuesQuery,
  type AdminTestOidcProviderMutation,
  type AdminUpdateConfigMutation,
  adminTestOidcProviderMutation,
  adminUpdateConfigMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ExternalLinkIcon, Trash2Icon } from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Checkbox,
  ConfirmModal,
  ErrorMessage,
  Group,
  InlineLink,
  Input,
  MetricStack,
  MyoxusSegmentedControl,
  notify,
  PasswordInput,
  ResponsiveGrid,
  Select,
  SimpleGrid,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsField,
  SettingsNotice,
  SettingsSection,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  Textarea,
  Text,
} from "@myoxus/ui-facade";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR from "swr";

import { fetchCaptchaChallenge } from "../../api/captcha-health-api";
import { fetchGlobalTlsSnapshot } from "../../api/runtime-status-api";
import { OuPicker } from "../../components/domain-pickers/ou-picker";
import { useMutation } from "../../use-mutation";
import { gqlFetcher, useQuery } from "../../use-query";
import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { useRevalidateServerConfig } from "../common";
import { OperationalReadinessNotice } from "../operational-readiness-notice";
import { ALL_CONFIG_DESCRIPTORS, type AppConfig } from "../settings/config";
import {
  ConfigArrayField,
  ConfigBooleanField,
  type ConfigControlType,
  ConfigNumberField,
  ConfigTextField,
  YamlOnlyBanner,
} from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import {
  type AdminConfigSchemaField,
  buildSchemaFieldMap,
} from "../settings/schema-utils";
import { adminConfigSnapshotToAppConfig } from "../settings/use-admin-config-contract";
import { useOrganizationUnitsQuery } from "../organization/api";
import { useAppConfig } from "../settings/use-app-config";
import { useFieldErrors } from "../settings/use-field-errors";
import { getByPath } from "../settings/utils";
import {
  applyOidcProviderPreset,
  equalOidcGroupDirectory,
  GROUPS_SOURCE_OPTIONS,
  normalizeOidcProviderConfig,
  normalizeScopes,
  oidcMappingRuleError,
  oidcUnitLabels,
  type OAuthProviderConfig,
  OIDC_PROVIDER_PRESETS,
  type OidcClaimsConfig,
  type OidcGroupMappingConfig,
  type OidcGroupDirectoryConfig,
  type OidcGroupMappingRuleConfig,
  type OidcGroupsSource,
  type OidcMissingGroupsPolicy,
  type OidcProviderConfig,
  type OidcProviderPresetId,
  type OidcRole,
  type OidcUnknownGroupsPolicy,
  ROLE_OPTIONS,
  serializeOidcProviderConfig,
  type SimpleProviderConfig,
} from "./oidc-config";

type ConfigFieldDef = {
  key: string;
  sub?: string;
  type?: ConfigControlType;
  desc?: string;
  suffix?: string;
  options?: string[];
  min?: number;
  max?: number;
};

type ConfigTabProps = {
  module: "auth" | "cors" | "captcha";
  titleKey: string;
  descriptionKey: string;
  fields: ConfigFieldDef[];
  appConfig: AppConfig;
  patchedAppConfig: AppConfig;
  schema: unknown;
  update: (path: string, value: unknown) => void;
  saveGroup: (module: string) => Promise<void>;
  resetGroup: (module: string) => void;
  isGroupDirty: (module: string) => boolean;
  isGroupSaving: (module: string) => boolean;
  getGroupVersion: (module: string) => number;
  fieldErrorsByPath: Record<string, { message: string }>;
  extra?: ReactNode;
};

function SecurityConfigField({
  module,
  field,
  sourceConfig,
  schemaField,
  showYamlBanner,
  error,
  onErrorChange,
  update,
}: {
  module: ConfigTabProps["module"];
  field: ConfigFieldDef;
  sourceConfig: Record<string, unknown> | undefined;
  schemaField?: AdminConfigSchemaField | null;
  showYamlBanner: boolean;
  error?: string;
  onErrorChange: (field: string, error?: string) => void;
  update: (path: string, value: unknown) => void;
}) {
  const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[field.key];
  const uiPath = fieldUiPath(module, field);
  const valuePath = fieldValuePath(field);
  const type = (field.type ??
    schemaField?.valueType ??
    "String") as ConfigControlType;
  const commonProps = {
    field: uiPath,
    desc: field.desc ?? descriptor?.desc ?? "",
    defaultValue: getByPath(sourceConfig, valuePath),
    onChange: update,
    databaseWritable: schemaField?.databaseWritable,
    restartRequired: Boolean(schemaField?.restart_required),
    suppressYamlBanner: showYamlBanner,
    error,
    onErrorChange,
  };
  const sensitive = Boolean(schemaField?.sensitive);

  if (type === "Boolean") return <ConfigBooleanField {...commonProps} />;
  if (type === "Number") {
    return (
      <ConfigNumberField
        {...commonProps}
        suffix={field.suffix ?? descriptor?.suffix}
        min={field.min ?? schemaField?.min ?? undefined}
        max={field.max ?? schemaField?.max ?? undefined}
      />
    );
  }
  if (type === "Array") return <ConfigArrayField {...commonProps} />;
  return <ConfigTextField {...commonProps} sensitive={sensitive} />;
}

const AUTH_FIELDS: ConfigFieldDef[] = [
  { key: "allow_signup", type: "Boolean" },
  { key: "allow_signup_for_oauth", type: "Boolean" },
  { key: "require_email_domain_verification", type: "Boolean" },
  { key: "require_email_verification", type: "Boolean" },
  {
    key: "password_requirements",
    sub: "min",
    type: "Number",
    desc: "admin.security.auth.password-min.desc",
  },
  {
    key: "password_requirements",
    sub: "max",
    type: "Number",
    desc: "admin.security.auth.password-max.desc",
  },
  { key: "reject_plus_aliases", type: "Boolean" },
  { key: "allowed_email_domains", type: "Array" },
  {
    key: "dns_timeout_seconds",
    type: "Number",
    desc: "admin.security.auth.dns-timeout.desc",
  },
  {
    key: "password_reset_ttl_seconds",
    type: "Number",
    suffix: "s",
    min: 300,
    max: 86400,
    desc: "admin.config.auth.passwordResetTtlSeconds.desc",
  },
];

const CORS_FIELDS: ConfigFieldDef[] = [
  { key: "allowed_origins", type: "Array" },
  { key: "app_origins", type: "Array" },
  { key: "allowed_custom_headers", type: "Array" },
  { key: "max_age_seconds", type: "Number", suffix: "s", min: 0, max: 86400 },
];

const CAPTCHA_FIELDS: ConfigFieldDef[] = [
  { key: "enabled", type: "Boolean" },
  {
    key: "algorithm",
    type: "Enum",
    options: ["SHA-256", "SHA-384", "SHA-512", "Argon2id", "Scrypt"],
    desc: "admin.system.field.captcha.algorithm.desc",
  },
  {
    key: "hmac_key",
    type: "String",
    desc: "admin.system.field.captcha.hmac-key.desc",
  },
  {
    key: "challenge_expires_seconds",
    type: "Number",
    suffix: "s",
    min: 60,
    max: 86400,
    desc: "admin.system.field.captcha.challenge-expires-seconds.desc",
  },
  {
    key: "max_number",
    type: "Number",
    min: 1000,
    max: 10000000,
    desc: "admin.system.field.captcha.max-number.desc",
  },
  {
    key: "rate_limit_per_ip_per_min",
    type: "Number",
    suffix: "/min",
    min: 1,
    max: 10000,
    desc: "admin.system.field.captcha.rate-limit-ip.desc",
  },
  {
    key: "rate_limit_per_account_per_hour",
    type: "Number",
    suffix: "/h",
    min: 1,
    max: 10000,
    desc: "admin.system.field.captcha.rate-limit-account.desc",
  },
  {
    key: "honeypot_field_name",
    type: "String",
    desc: "admin.system.field.captcha.honeypot-field-name.desc",
  },
];

function fieldUiPath(module: string, field: ConfigFieldDef) {
  return field.sub
    ? `${module}/${field.key}/${field.sub}`
    : `${module}/${field.key}`;
}

function fieldValuePath(field: ConfigFieldDef) {
  return field.sub ? `${field.key}.${field.sub}` : field.key;
}

const ConfigTab = memo(function ConfigTab({
  module,
  titleKey,
  descriptionKey,
  fields,
  appConfig,
  patchedAppConfig,
  schema,
  update,
  saveGroup,
  resetGroup,
  isGroupDirty,
  isGroupSaving,
  getGroupVersion,
  fieldErrorsByPath,
  extra,
}: ConfigTabProps) {
  const i18n = useI18n();
  const { hasFieldError, onFieldErrorChange } = useFieldErrors();
  const dirty = isGroupDirty(module);
  const saving = isGroupSaving(module);
  const sourceConfig = patchedAppConfig[module] ?? appConfig[module] ?? {};
  const schemaFieldMap = buildSchemaFieldMap(schema as never, module);
  const version = getGroupVersion(module);
  const yamlOnlyCount = fields.filter((field) => {
    const schemaKey = field.sub ? field.key : fieldValuePath(field);
    return schemaFieldMap[schemaKey]?.databaseWritable === false;
  }).length;
  const showYamlBanner = yamlOnlyCount >= 2;

  return (
    <Stack component="section" data-testid={`security-tab-${module}`}>
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t(titleKey)}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t(descriptionKey)}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <Stack key={`${module}-${version}`}>
        {showYamlBanner ? <YamlOnlyBanner /> : null}
        <SimpleGrid cols={2}>
          {fields.map((field) => {
            const schemaKey = field.sub ? field.key : fieldValuePath(field);
            const schemaField = schemaFieldMap[schemaKey];
            const uiPath = fieldUiPath(module, field);
            return (
              <SecurityConfigField
                key={uiPath}
                module={module}
                field={field}
                sourceConfig={sourceConfig}
                schemaField={schemaField}
                showYamlBanner={showYamlBanner}
                error={fieldErrorsByPath[uiPath]?.message}
                onErrorChange={onFieldErrorChange}
                update={update}
              />
            );
          })}
        </SimpleGrid>
        {extra}
        <ConfigPageSaveButtons
          dirty={dirty}
          hasFieldError={hasFieldError([module])}
          saving={saving}
          onReset={() => resetGroup(module)}
          onSave={() => {
            saveGroup(module).catch((err) => {
              toast.error(i18n.t("admin.common.save-failed"), {
                description: err?.message ?? String(err),
              });
            });
          }}
        />
      </Stack>
    </Stack>
  );
});

type ProviderType = "google" | "github" | "oidc" | "apple";

function isConfigured(config: OAuthProviderConfig): boolean {
  if (!config || typeof config !== "object") return false;
  return Boolean(config.clientId);
}

function SimpleProviderSection({
  provider,
  titleKey,
  helpText,
  helpUrl,
  currentConfig,
  onSave,
  onRemove,
  saving,
}: {
  provider: ProviderType;
  titleKey: string;
  helpText?: string;
  helpUrl?: string;
  currentConfig: OAuthProviderConfig;
  onSave: (
    provider: ProviderType,
    config: SimpleProviderConfig,
  ) => Promise<unknown>;
  onRemove: (provider: ProviderType) => Promise<void>;
  saving: boolean;
}) {
  const i18n = useI18n();
  const [removeOpen, setRemoveOpen] = useState(false);
  const configured = isConfigured(currentConfig);
  const [clientId, setClientId] = useState(currentConfig?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(
    currentConfig?.clientSecret ?? "",
  );
  const [touched, setTouched] = useState(false);

  const lastReadback = useRef({
    clientId: currentConfig?.clientId ?? "",
    clientSecret: currentConfig?.clientSecret ?? "",
  });

  useEffect(() => {
    const next = {
      clientId: currentConfig?.clientId ?? "",
      clientSecret: currentConfig?.clientSecret ?? "",
    };
    const previous = lastReadback.current;
    if (
      next.clientId === previous.clientId &&
      next.clientSecret === previous.clientSecret
    )
      return;
    lastReadback.current = next;
    // Native tab/accordion reactivation must not reinitialize an unsaved draft.
    const dirty =
      clientId !== previous.clientId || clientSecret !== previous.clientSecret;
    if (
      dirty &&
      (clientId !== next.clientId || clientSecret !== next.clientSecret)
    )
      return;
    setClientId(next.clientId);
    setClientSecret(next.clientSecret);
    setTouched(false);
  }, [currentConfig, clientId, clientSecret]);

  const errors = {
    clientId:
      touched && clientId.trim() === ""
        ? i18n.t("admin.security.oauth.client-id-required")
        : undefined,
    clientSecret:
      touched && clientSecret.trim() === ""
        ? i18n.t("admin.security.oauth.client-secret-required")
        : undefined,
  };
  const canSave = clientId.trim() !== "" && clientSecret.trim() !== "";

  return (
    <AccordionItem value={provider}>
      <AccordionControl data-testid={`security-oauth-provider-${provider}`}>
        <Group justify="space-between" wrap="nowrap">
          {i18n.t(titleKey)}
          <Badge tone={configured ? "success" : "neutral"}>
            {configured
              ? i18n.t("admin.security.oauth.configured")
              : i18n.t("admin.security.oauth.not-configured")}
          </Badge>
        </Group>
      </AccordionControl>
      <AccordionPanel>
        <Stack>
          <SettingsField
            labelFor={`${provider}-client-id`}
            label={i18n.t("admin.security.oauth.client-id")}
          >
            <Input
              id={`${provider}-client-id`}
              value={clientId}
              onChange={setClientId}
              placeholder={i18n.t("admin.security.oauth.client-id-placeholder")}
            />
            {errors.clientId ? (
              <ErrorMessage role="alert">{errors.clientId}</ErrorMessage>
            ) : null}
          </SettingsField>
          <SettingsField
            labelFor={`${provider}-client-secret`}
            label={i18n.t("admin.security.oauth.client-secret")}
          >
            <PasswordInput
              id={`${provider}-client-secret`}
              value={clientSecret}
              onChange={setClientSecret}
              placeholder={i18n.t(
                "admin.security.oauth.client-secret-placeholder",
              )}
              error={errors.clientSecret}
            />
            {errors.clientSecret ? (
              <ErrorMessage role="alert">{errors.clientSecret}</ErrorMessage>
            ) : null}
          </SettingsField>
          {helpText && helpUrl ? (
            <InlineLink
              href={helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              prefix={<ExternalLinkIcon aria-hidden />}
            >
              {helpText}
            </InlineLink>
          ) : null}
          <Group justify="flex-end">
            {configured ? (
              <Button
                type="button"
                variant="error"
                onClick={() => setRemoveOpen(true)}
                disabled={saving}
                prefix={<Trash2Icon aria-hidden />}
              >
                {i18n.t("admin.security.oauth.remove")}
              </Button>
            ) : null}
            <Button
              type="button"
              data-testid={`security-oauth-save-${provider}`}
              onClick={() => {
                setTouched(true);
                if (!canSave) return;
                void onSave(provider, {
                  clientId: clientId.trim(),
                  clientSecret: clientSecret.trim(),
                });
              }}
              disabled={!canSave || saving}
            >
              {saving
                ? i18n.t("admin.common.loading")
                : i18n.t("admin.common.save")}
            </Button>
          </Group>
        </Stack>
        <ConfirmModal
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title={i18n.t("admin.security.oauth.remove")}
          description={i18n.t("admin.security.oauth.remove-confirm")}
          cancelText={i18n.t("admin.common.cancel")}
          confirmText={i18n.t("admin.security.oauth.remove")}
          confirmButtonOptions={{ variant: "error" }}
          onConfirm={() => onRemove(provider)}
        />
      </AccordionPanel>
    </AccordionItem>
  );
}

const URL_PATTERN = /^https:\/\//;

function validateUrl(
  value: string,
  fieldName: string,
  msgs: { required: string; httpsRequired: string },
): string | undefined {
  if (value.trim() === "") return msgs.required.replace("{{field}}", fieldName);
  if (!URL_PATTERN.test(value.trim())) {
    return msgs.httpsRequired.replace("{{field}}", fieldName);
  }
  return undefined;
}

function OidcProviderSection({
  provider,
  titleKey,
  currentConfig,
  onSave,
  onRemove,
  saving,
}: {
  provider: ProviderType;
  titleKey: string;
  currentConfig: OAuthProviderConfig;
  onSave: (
    provider: ProviderType,
    config: OidcProviderConfig,
    onFailure?: (message: string) => void,
  ) => Promise<
    AdminUpdateConfigMutation["admin"]["adminUpdateConfig"] | undefined
  >;
  onRemove: (provider: ProviderType) => Promise<void>;
  saving: boolean;
}) {
  const i18n = useI18n();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [claimsExpanded, setClaimsExpanded] = useState(false);
  const [groupsExpanded, setGroupsExpanded] = useState(false);
  const [providerPreset, setProviderPreset] =
    useState<OidcProviderPresetId>("custom");
  const [touched, setTouched] = useState(false);
  const [sampleClaims, setSampleClaims] = useState("");
  const [diagnosticResult, setDiagnosticResult] = useState<
    AdminTestOidcProviderMutation["admin"]["testOidcProvider"] | null
  >(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const configured = isConfigured(currentConfig);
  const [form, setForm] = useState<OidcProviderConfig>(() =>
    normalizeOidcProviderConfig(currentConfig),
  );
  // null includes inactive persisted targets; the picker still owns live search.
  const {
    units,
    data: unitsData,
    error: unitsError,
  } = useOrganizationUnitsQuery(null);
  const unitLabels = useMemo(() => oidcUnitLabels(units), [units]);
  const lastReadback = useRef(
    JSON.stringify(normalizeOidcProviderConfig(currentConfig)),
  );
  const [directoryDraft, setDirectoryDraft] = useState<
    OidcGroupDirectoryConfig | null | undefined
  >(() => normalizeOidcProviderConfig(currentConfig).groupDirectory);
  const directoryReadback = useRef(directoryDraft);
  const [savingDirectory, setSavingDirectory] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const savedDirectory =
    normalizeOidcProviderConfig(currentConfig).groupDirectory;
  const directoryDirty = !equalOidcGroupDirectory(
    directoryDraft,
    savedDirectory,
  );
  const catalogBlockedMessage = directoryDirty
    ? i18n.t("admin.security.oauth.directory-unsaved")
    : savingDirectory || saving
      ? i18n.t("admin.common.loading")
      : !configured
        ? i18n.t("admin.security.oauth.directory-login-required")
        : !savedDirectory
          ? i18n.t("admin.security.oauth.directory-unconfigured")
          : undefined;
  const catalog = useOidcGroupDirectory(
    JSON.stringify(
      savedDirectory
        ? [
            savedDirectory.type,
            savedDirectory.baseUrl,
            ...(savedDirectory.type === "authentik"
              ? [savedDirectory.token]
              : [
                  savedDirectory.realm,
                  savedDirectory.clientId,
                  savedDirectory.clientSecret,
                  savedDirectory.claimValueMode,
                ]),
          ]
        : null,
    ),
    provider !== "oidc" || !!catalogBlockedMessage,
  );
  const { trigger: testOidcProvider, isMutating: testingOidcProvider } =
    useMutation({
      mutation: adminTestOidcProviderMutation,
    });

  useEffect(() => {
    const next = normalizeOidcProviderConfig(currentConfig);
    const signature = JSON.stringify(next);
    const previous = lastReadback.current;
    if (signature === previous) return;
    lastReadback.current = signature;
    const draft = JSON.stringify(form);
    if (draft !== previous && draft !== signature) {
      // A connection-only save must refresh the saved directory without erasing
      // an independent login/mapping draft. Normal OIDC Save never uses its draft.
      setForm((current) => ({
        ...current,
        groupDirectory: next.groupDirectory,
      }));
      return;
    }
    setForm(next);
    setProviderPreset("custom");
    setTouched(false);
    setDiagnosticResult(null);
    setDiagnosticError(null);
  }, [currentConfig, form]);

  useEffect(() => {
    const previous = directoryReadback.current;
    if (equalOidcGroupDirectory(savedDirectory, previous)) return;
    directoryReadback.current = savedDirectory;
    setDirectoryDraft((draft) =>
      equalOidcGroupDirectory(draft, previous) ? savedDirectory : draft,
    );
  }, [savedDirectory]);

  const saveDirectory = async () => {
    if (!configured || savingDirectory || saving) return;
    catalog.invalidate();
    setSavingDirectory(true);
    setDirectoryError(null);
    try {
      const response = await gqlFetcher({ query: adminConfigValuesQuery });
      const baseline = adminConfigSnapshotToAppConfig(
        response.admin.adminConfigValues,
      ).oauth?.providers?.oidc;
      if (!isConfigured(baseline))
        throw new Error(
          i18n.t("admin.security.oauth.directory-login-required"),
        );
      // Keep the entire saved provider byte values, including masked leaves;
      // only the directory changes. Never serialize/drop unsaved mapping rows.
      const result = await onSave(
        provider,
        { ...baseline, groupDirectory: directoryDraft ?? null },
        setDirectoryError,
      );
      if (result) {
        const saved = normalizeOidcProviderConfig(
          adminConfigSnapshotToAppConfig(result.config).oauth?.providers?.oidc,
        );
        setDirectoryDraft(saved.groupDirectory);
        setForm((current) => ({
          ...current,
          groupDirectory: saved.groupDirectory,
        }));
      }
    } catch (error) {
      setDirectoryError(UserFriendlyError.fromAny(error).message);
    } finally {
      setSavingDirectory(false);
    }
  };

  const updateField = <K extends keyof OidcProviderConfig>(
    key: K,
    value: OidcProviderConfig[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));
  const updateClaim = <K extends keyof OidcClaimsConfig>(
    key: K,
    value: OidcClaimsConfig[K],
  ) =>
    setForm((prev) => ({
      ...prev,
      claims: { ...prev.claims, [key]: value },
    }));
  const updateGroupMapping = <K extends keyof OidcGroupMappingConfig>(
    key: K,
    value: OidcGroupMappingConfig[K],
  ) =>
    setForm((prev) => ({
      ...prev,
      groupMapping: { ...prev.groupMapping, [key]: value },
    }));
  const updateMappingRule = (
    index: number,
    patch: Partial<OidcGroupMappingRuleConfig>,
  ) =>
    setForm((prev) => ({
      ...prev,
      groupMapping: {
        ...prev.groupMapping,
        mappings: prev.groupMapping.mappings.map((mapping, currentIndex) =>
          currentIndex === index ? { ...mapping, ...patch } : mapping,
        ),
      },
    }));
  const addMappingRule = () =>
    updateGroupMapping("mappings", [
      ...form.groupMapping.mappings,
      {
        providerGroup: "",
        targetUnitId: "",
        role: form.groupMapping.defaultRole,
      },
    ]);
  const removeMappingRule = (index: number) =>
    updateGroupMapping(
      "mappings",
      form.groupMapping.mappings.filter(
        (_, currentIndex) => currentIndex !== index,
      ),
    );

  const urlMsgs = {
    required: i18n.t("admin.security.oauth.url-required"),
    httpsRequired: i18n.t("admin.security.oauth.url-must-be-https"),
  };
  const errors = touched
    ? {
        clientId:
          form.clientId.trim() === ""
            ? i18n.t("admin.security.oauth.client-id-required")
            : undefined,
        clientSecret:
          form.clientSecret.trim() === ""
            ? i18n.t("admin.security.oauth.client-secret-required")
            : undefined,
        issuerUrl: form.issuerUrl
          ? validateUrl(
              form.issuerUrl,
              i18n.t("admin.security.oauth.issuer-url"),
              urlMsgs,
            )
          : undefined,
        discoveryUrl: form.discoveryUrl
          ? validateUrl(
              form.discoveryUrl,
              i18n.t("admin.security.oauth.discovery-url"),
              urlMsgs,
            )
          : undefined,
        authUrl: validateUrl(
          form.authUrl,
          i18n.t("admin.security.oauth.auth-url"),
          urlMsgs,
        ),
        tokenUrl: validateUrl(
          form.tokenUrl,
          i18n.t("admin.security.oauth.token-url"),
          urlMsgs,
        ),
        userinfoUrl: validateUrl(
          form.userinfoUrl,
          i18n.t("admin.security.oauth.userinfo-url"),
          urlMsgs,
        ),
        jwksUrl: form.jwksUrl
          ? validateUrl(
              form.jwksUrl,
              i18n.t("admin.security.oauth.jwks-url"),
              urlMsgs,
            )
          : undefined,
      }
    : {};
  const hasErrors = Object.values(errors).some(Boolean);
  const mappingErrors = form.groupMapping.mappings.map(oidcMappingRuleError);
  const hasMappingErrors = mappingErrors.some(Boolean);
  const canSave =
    form.clientId.trim() !== "" &&
    form.clientSecret.trim() !== "" &&
    form.authUrl.trim() !== "" &&
    form.tokenUrl.trim() !== "" &&
    form.userinfoUrl.trim() !== "" &&
    !hasErrors;
  const runDiagnostic = async () => {
    setTouched(true);
    setDiagnosticResult(null);
    setDiagnosticError(null);
    if (!canSave || hasMappingErrors) return;

    let parsedSampleClaims: Record<string, unknown> | null = null;
    if (sampleClaims.trim() !== "") {
      try {
        parsedSampleClaims = JSON.parse(sampleClaims) as Record<
          string,
          unknown
        >;
      } catch {
        const message = i18n.t("admin.security.oauth.oidc-test-sample-invalid");
        setDiagnosticError(message);
        return;
      }
    }

    try {
      const response = (await testOidcProvider({
        config: serializeOidcProviderConfig(form),
        sampleClaims: parsedSampleClaims,
      })) as AdminTestOidcProviderMutation;
      const result = response.admin.testOidcProvider;
      setDiagnosticResult(result);
      notify.success({
        title: i18n.t("admin.security.oauth.oidc-test-complete"),
        message: result.discoveryOk
          ? i18n.t("admin.security.oauth.oidc-test-discovery-ok")
          : i18n.t("admin.security.oauth.oidc-test-discovery-warning"),
      });
    } catch (e) {
      const error = UserFriendlyError.fromAny(e);
      setDiagnosticError(error.message);
      notify.error({
        title: i18n.t("admin.security.oauth.oidc-test-failed"),
        message: error.message,
      });
    }
  };

  return (
    <AccordionItem value={provider}>
      <AccordionControl data-testid={`security-oauth-provider-${provider}`}>
        <Group justify="space-between" wrap="nowrap">
          {i18n.t(titleKey)}
          <Badge tone={configured ? "success" : "neutral"}>
            {configured
              ? i18n.t("admin.security.oauth.configured")
              : i18n.t("admin.security.oauth.not-configured")}
          </Badge>
        </Group>
      </AccordionControl>
      <AccordionPanel>
        <Stack>
          <SettingsField
            label={i18n.t("admin.security.oauth.preset")}
            description={i18n.t("admin.security.oauth.preset-desc")}
          >
            <Stack>
              <MyoxusSegmentedControl
                value={providerPreset}
                onChange={(value) =>
                  setProviderPreset(value as OidcProviderPresetId)
                }
                data={OIDC_PROVIDER_PRESETS.map((preset) => ({
                  value: preset.value,
                  label: i18n.t(preset.labelKey),
                }))}
                aria-label={i18n.t("admin.security.oauth.preset")}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setForm((prev) =>
                    applyOidcProviderPreset(prev, providerPreset),
                  );
                  setDiagnosticResult(null);
                  setDiagnosticError(null);
                }}
              >
                {i18n.t("admin.security.oauth.apply-preset")}
              </Button>
            </Stack>
          </SettingsField>
          {(
            [
              ["clientId", "client-id", ""],
              ["clientSecret", "client-secret", ""],
              ["issuerUrl", "issuer-url", "https://issuer.example.com"],
              [
                "discoveryUrl",
                "discovery-url",
                "https://issuer.example.com/.well-known/openid-configuration",
              ],
              ["authUrl", "auth-url", "https://issuer.example.com/auth"],
              ["tokenUrl", "token-url", "https://issuer.example.com/token"],
              [
                "userinfoUrl",
                "userinfo-url",
                "https://issuer.example.com/userinfo",
              ],
              ["jwksUrl", "jwks-url", "https://issuer.example.com/jwks"],
            ] as const
          ).map(([key, labelKey, placeholder]) => {
            const typedKey = key as keyof OidcProviderConfig;
            const inputId = `${provider}-${labelKey}`;
            const localizedPlaceholder =
              key === "clientId"
                ? i18n.t("admin.security.oauth.client-id-placeholder")
                : key === "clientSecret"
                  ? i18n.t("admin.security.oauth.client-secret-placeholder")
                  : placeholder;
            return (
              <SettingsField
                key={key}
                labelFor={inputId}
                label={i18n.t(`admin.security.oauth.${labelKey}`)}
              >
                {key === "clientSecret" ? (
                  <PasswordInput
                    id={inputId}
                    value={form.clientSecret}
                    onChange={(v) => updateField("clientSecret", v)}
                    placeholder={localizedPlaceholder}
                    error={errors.clientSecret}
                  />
                ) : (
                  <Input
                    id={inputId}
                    value={String(form[typedKey] ?? "")}
                    onChange={(value) => updateField(typedKey, value)}
                    placeholder={localizedPlaceholder}
                  />
                )}
                {errors[key as keyof typeof errors] ? (
                  <ErrorMessage role="alert">
                    {errors[key as keyof typeof errors]}
                  </ErrorMessage>
                ) : null}
              </SettingsField>
            );
          })}
          <SettingsField
            labelFor={`${provider}-scopes`}
            label={i18n.t("admin.security.oauth.scopes")}
          >
            <Input
              id={`${provider}-scopes`}
              value={form.scopes.join(" ")}
              onChange={(value) =>
                updateField("scopes", normalizeScopes(value))
              }
              placeholder="openid profile email"
            />
          </SettingsField>
          <Accordion
            value={claimsExpanded ? "claims" : null}
            onChange={(value) => setClaimsExpanded(value === "claims")}
            chevronPosition="left"
            keepMounted={false}
          >
            <AccordionItem value="claims">
              <AccordionControl>
                {i18n.t("admin.security.oauth.claim-mappings")}
              </AccordionControl>
              <AccordionPanel>
                <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
                  {(
                    [
                      ["subject", "user-id-field", "sub"],
                      ["email", "email-field", "email"],
                      ["name", "name-field", "name"],
                      ["avatar", "avatar-field", "picture"],
                    ] as const
                  ).map(([key, labelKey, placeholder]) => (
                    <SettingsField
                      key={key}
                      labelFor={`${provider}-${labelKey}`}
                      label={i18n.t(`admin.security.oauth.${labelKey}`)}
                    >
                      <Input
                        id={`${provider}-${labelKey}`}
                        value={form.claims[key]}
                        onChange={(value) => updateClaim(key, value)}
                        placeholder={placeholder}
                      />
                    </SettingsField>
                  ))}
                  <SettingsField
                    labelFor={`${provider}-email-verified-field`}
                    label={i18n.t("admin.security.oauth.email-verified-field")}
                  >
                    <Input
                      id={`${provider}-email-verified-field`}
                      value={form.claims.emailVerified}
                      onChange={(value) => updateClaim("emailVerified", value)}
                      placeholder="email_verified"
                    />
                  </SettingsField>
                  <SettingsField
                    labelFor={`${provider}-groups-field`}
                    label={i18n.t("admin.security.oauth.groups-field")}
                  >
                    <Input
                      id={`${provider}-groups-field`}
                      value={form.claims.groups}
                      onChange={(value) => updateClaim("groups", value)}
                      placeholder="groups"
                    />
                  </SettingsField>
                  <SettingsField
                    labelFor={`${provider}-groups-source`}
                    label={i18n.t("admin.security.oauth.groups-source")}
                  >
                    <Select
                      id={`${provider}-groups-source`}
                      value={form.claims.groupsSource}
                      onChange={(value) =>
                        updateClaim("groupsSource", value as OidcGroupsSource)
                      }
                      data={GROUPS_SOURCE_OPTIONS.map((option) => ({
                        value: option.value,
                        label: i18n.t(option.labelKey),
                      }))}
                    />
                  </SettingsField>
                </ResponsiveGrid>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
          <Accordion
            value={groupsExpanded ? "groups" : null}
            onChange={(value) => setGroupsExpanded(value === "groups")}
            chevronPosition="left"
            keepMounted={false}
          >
            <AccordionItem value="groups">
              <AccordionControl>
                {i18n.t("admin.security.oauth.group-mapping")}
              </AccordionControl>
              <AccordionPanel>
                <Stack>
                  <Checkbox
                    checked={form.groupMapping.enabled}
                    onChange={(_, checked) =>
                      updateGroupMapping("enabled", checked)
                    }
                    label={i18n.t("admin.security.oauth.group-mapping-enabled")}
                  />
                  <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
                    <SettingsField
                      labelFor={`${provider}-default-role`}
                      label={i18n.t("admin.security.oauth.default-role")}
                    >
                      <Select
                        id={`${provider}-default-role`}
                        value={form.groupMapping.defaultRole}
                        onChange={(value) =>
                          updateGroupMapping("defaultRole", value as OidcRole)
                        }
                        data={ROLE_OPTIONS.map((option) => ({
                          value: option.value,
                          label: i18n.t(option.labelKey),
                        }))}
                      />
                    </SettingsField>
                    <SettingsField
                      labelFor={`${provider}-missing-groups-policy`}
                      label={i18n.t(
                        "admin.security.oauth.missing-groups-policy",
                      )}
                    >
                      <Select
                        id={`${provider}-missing-groups-policy`}
                        value={form.groupMapping.missingGroupsPolicy}
                        onChange={(value) =>
                          updateGroupMapping(
                            "missingGroupsPolicy",
                            value as OidcMissingGroupsPolicy,
                          )
                        }
                        data={[
                          {
                            value: "deny_login",
                            label: i18n.t(
                              "admin.security.oauth.missing-groups-deny",
                            ),
                          },
                          {
                            value: "allow_without_memberships",
                            label: i18n.t(
                              "admin.security.oauth.missing-groups-allow",
                            ),
                          },
                        ]}
                      />
                    </SettingsField>
                    <SettingsField
                      labelFor={`${provider}-unknown-groups-policy`}
                      label={i18n.t(
                        "admin.security.oauth.unknown-groups-policy",
                      )}
                    >
                      <Select
                        id={`${provider}-unknown-groups-policy`}
                        value={form.groupMapping.unknownGroups}
                        onChange={(value) =>
                          updateGroupMapping(
                            "unknownGroups",
                            value as OidcUnknownGroupsPolicy,
                          )
                        }
                        data={[
                          {
                            value: "ignore",
                            label: i18n.t(
                              "admin.security.oauth.unknown-groups-ignore",
                            ),
                          },
                          {
                            value: "deny_login",
                            label: i18n.t(
                              "admin.security.oauth.unknown-groups-deny",
                            ),
                          },
                        ]}
                      />
                    </SettingsField>
                    <Checkbox
                      checked={form.groupMapping.removeMissingOidcMemberships}
                      onChange={(_, checked) =>
                        updateGroupMapping(
                          "removeMissingOidcMemberships",
                          checked,
                        )
                      }
                      label={i18n.t(
                        "admin.security.oauth.remove-missing-memberships",
                      )}
                    />
                  </ResponsiveGrid>
                  {provider === "oidc" ? (
                    <>
                      <Group>
                        <Button
                          variant="outline"
                          disabled={
                            !!catalogBlockedMessage ||
                            catalog.state.kind === "loading"
                          }
                          onClick={() => void catalog.load()}
                          data-testid="oidc-directory-load"
                        >
                          {catalog.state.kind === "loading"
                            ? i18n.t("admin.common.loading")
                            : catalog.state.kind === "idle"
                              ? i18n.t("admin.security.oauth.directory-load")
                              : i18n.t("admin.common.refresh")}
                        </Button>
                        {catalogBlockedMessage ? (
                          <Text>{catalogBlockedMessage}</Text>
                        ) : catalog.state.kind === "loaded" ? (
                          <Text>
                            {catalog.state.entries.length
                              ? i18n.t(
                                  "admin.security.oauth.directory-loaded",
                                  { count: catalog.state.entries.length },
                                )
                              : i18n.t("admin.security.oauth.directory-empty")}
                          </Text>
                        ) : catalog.state.kind === "idle" ? (
                          <Text>
                            {i18n.t("admin.security.oauth.directory-idle")}
                          </Text>
                        ) : null}
                      </Group>
                      {catalog.state.kind === "error" ? (
                        <ErrorMessage role="alert">
                          {catalog.state.message}
                        </ErrorMessage>
                      ) : null}
                    </>
                  ) : null}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {i18n.t("admin.security.oauth.provider-group")}
                        </TableHead>
                        <TableHead>
                          {i18n.t("admin.security.oauth.target-ou")}
                        </TableHead>
                        <TableHead>
                          {i18n.t("admin.security.oauth.role")}
                        </TableHead>
                        <TableHead>{i18n.t("admin.common.actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {form.groupMapping.mappings.map((mapping, index) => (
                        <TableRow key={index}>
                          <TableCell>
                            {provider === "oidc" ? (
                              <OidcGroupPicker
                                value={mapping.providerGroup}
                                onChange={(value) =>
                                  updateMappingRule(index, {
                                    providerGroup: value,
                                  })
                                }
                                directory={catalog.state}
                                blockedMessage={catalogBlockedMessage}
                              />
                            ) : (
                              <Input
                                value={mapping.providerGroup}
                                onChange={(value) =>
                                  updateMappingRule(index, {
                                    providerGroup: value,
                                  })
                                }
                                placeholder="finance/managers"
                                error={
                                  touched &&
                                  mappingErrors[index] ===
                                    "admin.security.oauth.mapping-group-required"
                                }
                              />
                            )}
                            {touched && mappingErrors[index] ? (
                              <ErrorMessage role="alert">
                                {i18n.t(mappingErrors[index], {
                                  row: index + 1,
                                })}
                              </ErrorMessage>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <OuPicker
                              value={mapping.targetUnitId || null}
                              displayValue={
                                mapping.targetUnitId
                                  ? (unitLabels.get(mapping.targetUnitId) ??
                                    `${i18n.t(
                                      !unitsData && !unitsError
                                        ? "admin.common.loading"
                                        : "com.myoxus.reference.target-unavailable",
                                    )} (${mapping.targetUnitId})`)
                                  : null
                              }
                              onChange={(value) =>
                                updateMappingRule(index, {
                                  targetUnitId: value ?? "",
                                })
                              }
                              placeholder={i18n.t(
                                "admin.security.oauth.target-ou-placeholder",
                              )}
                              data-testid={`security-oauth-ou-${index}`}
                            />
                            {mapping.targetUnitId &&
                            !unitLabels.has(mapping.targetUnitId) &&
                            (unitsData || unitsError) ? (
                              <ErrorMessage role="status">
                                {unitsError
                                  ? UserFriendlyError.fromAny(unitsError)
                                      .message
                                  : i18n.t(
                                      "com.myoxus.reference.target-unavailable",
                                    )}
                              </ErrorMessage>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={
                                mapping.role ?? form.groupMapping.defaultRole
                              }
                              onChange={(value) =>
                                updateMappingRule(index, {
                                  role: value as OidcRole,
                                })
                              }
                              data={ROLE_OPTIONS.map((option) => ({
                                value: option.value,
                                label: i18n.t(option.labelKey),
                              }))}
                            />
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => removeMappingRule(index)}
                            >
                              {i18n.t("admin.security.oauth.remove-mapping")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={addMappingRule}
                  >
                    {i18n.t("admin.security.oauth.add-mapping")}
                  </Button>
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
          <SettingsField
            labelFor={`${provider}-sample-claims`}
            label={i18n.t("admin.security.oauth.oidc-test-sample-claims")}
          >
            <Textarea
              id={`${provider}-sample-claims`}
              value={sampleClaims}
              onChange={setSampleClaims}
              mono
              minRows={3}
              placeholder='{"groups":["finance","finance/managers"]}'
            />
          </SettingsField>
          {provider === "oidc" ? (
            <Stack
              component="section"
              aria-label={i18n.t("admin.security.oauth.directory-title")}
              data-testid="oidc-group-directory"
            >
              <SettingsHeadingGroup>
                <SettingsSectionHeading level={4}>
                  {i18n.t("admin.security.oauth.directory-title")}
                </SettingsSectionHeading>
                <SettingsSectionDescription>
                  {i18n.t("admin.security.oauth.directory-description")}
                </SettingsSectionDescription>
              </SettingsHeadingGroup>
              <SettingsField
                label={i18n.t("admin.security.oauth.directory-provider")}
              >
                <Select
                  aria-label={i18n.t("admin.security.oauth.directory-provider")}
                  value={directoryDraft?.type ?? "none"}
                  disabled={savingDirectory || saving}
                  onChange={(type) =>
                    setDirectoryDraft(
                      type === "authentik"
                        ? { type, baseUrl: "", token: "" }
                        : type === "keycloak"
                          ? {
                              type,
                              baseUrl: "",
                              realm: "",
                              clientId: "",
                              clientSecret: "",
                              claimValueMode: "name",
                            }
                          : null,
                    )
                  }
                  data={[
                    { value: "none", label: i18n.t("admin.common.none") },
                    {
                      value: "authentik",
                      label: i18n.t("admin.security.oauth.preset-authentik"),
                    },
                    {
                      value: "keycloak",
                      label: i18n.t("admin.security.oauth.preset-keycloak"),
                    },
                  ]}
                />
              </SettingsField>
              {directoryDraft ? (
                <Stack>
                  <ConfigTextField
                    field="oidc-directory-base-url"
                    label="admin.system.overview.base-url"
                    defaultValue={directoryDraft.baseUrl}
                    disabled={savingDirectory || saving}
                    onChange={(_, value) =>
                      setDirectoryDraft((draft) =>
                        draft ? { ...draft, baseUrl: String(value) } : draft,
                      )
                    }
                  />
                  {directoryDraft.type === "keycloak" ? (
                    <>
                      <ConfigTextField
                        field="oidc-directory-realm"
                        label="admin.security.oauth.directory-realm"
                        defaultValue={directoryDraft.realm}
                        disabled={savingDirectory || saving}
                        onChange={(_, value) =>
                          setDirectoryDraft((draft) =>
                            draft?.type === "keycloak"
                              ? { ...draft, realm: String(value) }
                              : draft,
                          )
                        }
                      />
                      <ConfigTextField
                        field="oidc-directory-client-id"
                        label="admin.security.oauth.client-id"
                        defaultValue={directoryDraft.clientId}
                        disabled={savingDirectory || saving}
                        onChange={(_, value) =>
                          setDirectoryDraft((draft) =>
                            draft?.type === "keycloak"
                              ? { ...draft, clientId: String(value) }
                              : draft,
                          )
                        }
                      />
                      <SettingsField
                        label={i18n.t("admin.security.oauth.directory-mode")}
                      >
                        <Select
                          aria-label={i18n.t(
                            "admin.security.oauth.directory-mode",
                          )}
                          value={directoryDraft.claimValueMode}
                          disabled={savingDirectory || saving}
                          onChange={(value) => {
                            if (value === "name" || value === "path")
                              setDirectoryDraft((draft) =>
                                draft?.type === "keycloak"
                                  ? { ...draft, claimValueMode: value }
                                  : draft,
                              );
                          }}
                          data={[
                            {
                              value: "name",
                              label: i18n.t(
                                "admin.security.oauth.directory-name",
                              ),
                            },
                            {
                              value: "path",
                              label: i18n.t(
                                "admin.security.oauth.directory-path",
                              ),
                            },
                          ]}
                        />
                      </SettingsField>
                    </>
                  ) : null}
                  <ConfigTextField
                    field="oidc-directory-credential"
                    sensitive
                    label={
                      directoryDraft.type === "authentik"
                        ? "admin.security.oauth.directory-token"
                        : "admin.security.oauth.client-secret"
                    }
                    defaultValue={
                      directoryDraft.type === "authentik"
                        ? directoryDraft.token
                        : directoryDraft.clientSecret
                    }
                    disabled={savingDirectory || saving}
                    onChange={(_, value) =>
                      setDirectoryDraft((draft) =>
                        draft
                          ? draft.type === "authentik"
                            ? { ...draft, token: String(value) }
                            : { ...draft, clientSecret: String(value) }
                          : draft,
                      )
                    }
                  />
                </Stack>
              ) : null}
              {!configured ? (
                <SettingsNotice tone="info">
                  {i18n.t("admin.security.oauth.directory-login-required")}
                </SettingsNotice>
              ) : null}
              {directoryDirty ? (
                <SettingsNotice tone="warning">
                  {i18n.t("admin.security.oauth.directory-unsaved")}
                </SettingsNotice>
              ) : null}
              {directoryError ? (
                <ErrorMessage role="alert">{directoryError}</ErrorMessage>
              ) : null}
              <Group justify="flex-end">
                {directoryDraft ? (
                  <Button
                    variant="outline"
                    disabled={savingDirectory || saving}
                    onClick={() => setDirectoryDraft(null)}
                  >
                    {i18n.t("admin.security.oauth.remove")}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={!directoryDirty || savingDirectory || saving}
                  onClick={() => {
                    setDirectoryDraft(savedDirectory);
                    setDirectoryError(null);
                  }}
                >
                  {i18n.t("admin.common.discard")}
                </Button>
                <Button
                  data-testid="oidc-directory-save"
                  disabled={
                    !configured || !directoryDirty || savingDirectory || saving
                  }
                  onClick={() => void saveDirectory()}
                >
                  {savingDirectory || saving
                    ? i18n.t("admin.common.loading")
                    : i18n.t("admin.common.save")}
                </Button>
              </Group>
            </Stack>
          ) : null}
          {diagnosticError ? (
            <SettingsNotice tone="error">{diagnosticError}</SettingsNotice>
          ) : null}
          {diagnosticResult ? (
            <SettingsNotice
              tone={
                diagnosticResult.discoveryOk && diagnosticResult.jwksOk
                  ? "success"
                  : "warning"
              }
              title={i18n.t("admin.security.oauth.oidc-test-result")}
            >
              <Stack>
                <MetricStack
                  rows={[
                    {
                      label: i18n.t("admin.security.oauth.oidc-test-discovery"),
                      value: diagnosticResult.discoveryOk
                        ? i18n.t("admin.state.active")
                        : i18n.t("admin.state.error"),
                    },
                    {
                      label: i18n.t("admin.security.oauth.oidc-test-jwks"),
                      value: diagnosticResult.jwksOk
                        ? String(diagnosticResult.jwksKeyCount)
                        : i18n.t("admin.state.error"),
                    },
                    {
                      label: i18n.t("admin.security.oauth.oidc-test-groups"),
                      value: String(diagnosticResult.groupsCount),
                    },
                    {
                      label: i18n.t(
                        "admin.security.oauth.oidc-test-mapped-groups",
                      ),
                      value: String(diagnosticResult.mappedGroupsCount),
                    },
                    {
                      label: i18n.t(
                        "admin.security.oauth.oidc-test-unknown-groups",
                      ),
                      value: String(diagnosticResult.unknownGroupsCount),
                    },
                  ]}
                />
                {diagnosticResult.warnings.length > 0
                  ? diagnosticResult.warnings.join(" ")
                  : i18n.t("admin.security.oauth.oidc-test-no-warnings")}
              </Stack>
            </SettingsNotice>
          ) : null}
          <Group justify="flex-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => void runDiagnostic()}
              disabled={!canSave || testingOidcProvider}
            >
              {testingOidcProvider
                ? i18n.t("admin.common.loading")
                : i18n.t("admin.security.oauth.oidc-test")}
            </Button>
            {configured ? (
              <Button
                type="button"
                variant="error"
                onClick={() => setRemoveOpen(true)}
                disabled={saving}
                prefix={<Trash2Icon aria-hidden />}
              >
                {i18n.t("admin.security.oauth.remove")}
              </Button>
            ) : null}
            <Button
              type="button"
              data-testid={`security-oauth-save-${provider}`}
              onClick={() => {
                setTouched(true);
                if (!canSave || hasMappingErrors) return;
                void onSave(provider, serializeOidcProviderConfig(form));
              }}
              disabled={!canSave || saving}
            >
              {saving
                ? i18n.t("admin.common.loading")
                : i18n.t("admin.common.save")}
            </Button>
          </Group>
        </Stack>
        <ConfirmModal
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title={i18n.t("admin.security.oauth.remove")}
          description={i18n.t("admin.security.oauth.remove-confirm")}
          cancelText={i18n.t("admin.common.cancel")}
          confirmText={i18n.t("admin.security.oauth.remove")}
          confirmButtonOptions={{ variant: "error" }}
          onConfirm={() => {
            catalog.invalidate();
            return onRemove(provider);
          }}
        />
      </AccordionPanel>
    </AccordionItem>
  );
}

const OAuthSettingsTab = memo(function OAuthSettingsTab({
  appConfig,
}: {
  appConfig: AppConfig;
}) {
  const i18n = useI18n();
  const { trigger: saveUpdates } = useMutation({
    mutation: adminUpdateConfigMutation,
  });
  const { data: rawConfigData, mutate } = useQuery({
    query: adminConfigValuesQuery,
  });
  const liveConfig = useMemo(
    () =>
      adminConfigSnapshotToAppConfig(rawConfigData?.admin?.adminConfigValues),
    [rawConfigData],
  );
  const oauthConfig = liveConfig.oauth ?? appConfig.oauth;
  const providers = oauthConfig?.providers ?? {};
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = useCallback(
    async (
      provider: ProviderType,
      config: SimpleProviderConfig | OidcProviderConfig,
      onFailure?: (message: string) => void,
    ) => {
      setSavingProvider(provider);
      setSaveError(null);
      try {
        const envelope = (await saveUpdates({
          updates: [
            { module: "oauth", key: `providers.${provider}`, value: config },
          ],
        })) as AdminUpdateConfigMutation;
        const result = envelope.admin.adminUpdateConfig;
        if (!result.applied || result.fieldErrors.length > 0) {
          throw new Error(
            result.fieldErrors[0]?.message ??
              i18n.t("admin.common.save-failed"),
          );
        }
        await mutate();
        if (result.writeback === "failed") {
          notify.warning({
            title: i18n.t("admin.config.saved-mirror-warning"),
            message: i18n.t("admin.config.saved-mirror-warning-description"),
          });
        } else {
          notify.success({
            title: i18n.t("admin.security.oauth.save-success"),
            message: i18n.t("admin.security.oauth.provider-saved", {
              provider,
            }),
          });
        }
        return result;
      } catch (e) {
        const error = UserFriendlyError.fromAny(e);
        if (onFailure) onFailure(error.message);
        else setSaveError(error.message);
        notify.error({
          title: i18n.t("admin.security.oauth.save-failed"),
          message: error.message,
        });
        return undefined;
      } finally {
        setSavingProvider(null);
      }
    },
    [i18n, mutate, saveUpdates],
  );

  const handleRemove = useCallback(
    async (provider: ProviderType) => {
      setSavingProvider(provider);
      setSaveError(null);
      try {
        const envelope = (await saveUpdates({
          updates: [
            { module: "oauth", key: `providers.${provider}`, value: null },
          ],
        })) as AdminUpdateConfigMutation;
        const result = envelope.admin.adminUpdateConfig;
        if (!result.applied || result.fieldErrors.length > 0) {
          throw new Error(
            result.fieldErrors[0]?.message ??
              i18n.t("admin.common.save-failed"),
          );
        }
        await mutate();
        if (result.writeback === "failed") {
          notify.warning({
            title: i18n.t("admin.config.saved-mirror-warning"),
            message: i18n.t("admin.config.saved-mirror-warning-description"),
          });
        } else {
          notify.success({
            title: i18n.t("admin.security.oauth.removed"),
            message: i18n.t("admin.security.oauth.provider-removed", {
              provider,
            }),
          });
        }
      } catch (e) {
        const error = UserFriendlyError.fromAny(e);
        notify.error({
          title: i18n.t("admin.security.oauth.remove-failed"),
          message: error.message,
        });
        console.error("security.oauth.remove_failed", e);
      } finally {
        setSavingProvider(null);
      }
    },
    [i18n, mutate, saveUpdates],
  );

  return (
    <Stack data-testid="security-tab-oauth" component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.security.oauth.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.security.oauth.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <Accordion variant="default" multiple keepMounted={false}>
        <SimpleProviderSection
          provider="google"
          titleKey="admin.security.oauth.google"
          helpText={i18n.t("admin.security.oauth.google-help")}
          helpUrl="https://console.cloud.google.com/apis/credentials"
          currentConfig={providers.google}
          onSave={handleSave}
          onRemove={handleRemove}
          saving={savingProvider === "google"}
        />
        <SimpleProviderSection
          provider="github"
          titleKey="admin.security.oauth.github"
          helpText={i18n.t("admin.security.oauth.github-help")}
          helpUrl="https://github.com/settings/developers"
          currentConfig={providers.github}
          onSave={handleSave}
          onRemove={handleRemove}
          saving={savingProvider === "github"}
        />
        <OidcProviderSection
          provider="oidc"
          titleKey="admin.security.oauth.oidc"
          currentConfig={providers.oidc}
          onSave={handleSave}
          onRemove={handleRemove}
          saving={savingProvider === "oidc"}
        />
        <OidcProviderSection
          provider="apple"
          titleKey="admin.security.oauth.apple"
          currentConfig={providers.apple}
          onSave={handleSave}
          onRemove={handleRemove}
          saving={savingProvider === "apple"}
        />
      </Accordion>
      {saveError ? <ErrorMessage role="alert">{saveError}</ErrorMessage> : null}
    </Stack>
  );
});

function CaptchaHealthPanel() {
  const i18n = useI18n();
  const [status, setStatus] = useState<
    "idle" | "checking" | "ok" | "disabled" | "error"
  >("idle");
  const [message, setMessage] = useState<string>(
    i18n.t("admin.security.captcha.test-idle"),
  );

  const runTest = useCallback(async () => {
    setStatus("checking");
    setMessage(i18n.t("admin.security.captcha.test-running"));
    try {
      const response = await fetchCaptchaChallenge();
      if (response.status === 503) {
        setStatus("disabled");
        setMessage(i18n.t("admin.security.captcha.test-disabled"));
        return;
      }
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      await response.json();
      setStatus("ok");
      setMessage(i18n.t("admin.security.captcha.test-ok"));
    } catch (err) {
      setStatus("error");
      setMessage(
        i18n.t("admin.security.captcha.test-error", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      console.error("security.captcha.challenge_test_failed", err);
    }
  }, [i18n]);

  const statusLabel =
    status === "error"
      ? i18n.t("admin.security.captcha.status.error-label")
      : i18n.t(`admin.security.captcha.status.${status}` as never);
  const statusTone = status === "ok" ? "success" : "neutral";

  return (
    <SettingsSection
      component="section"
      title={i18n.t("admin.security.captcha.test-title")}
      description={message}
      actions={
        <Group>
          <Badge tone={statusTone}>{statusLabel}</Badge>
          <Button
            type="button"
            variant="secondary"
            onClick={runTest}
            disabled={status === "checking"}
          >
            {i18n.t("admin.security.captcha.test-button")}
          </Button>
        </Group>
      }
    />
  );
}

function GlobalTlsTrust() {
  const i18n = useI18n();
  const config = useQuery({ query: adminConfigValuesQuery });
  const trust = useSWR("admin-global-tls-startup", fetchGlobalTlsSnapshot);
  const field = config.data?.admin.adminConfigValues.effectiveFields?.find(
    (item) => item.path === "tls.additional_ca_bundle_path",
  );
  const path = field?.runtimeEffectiveValue;
  const failed = config.error || trust.error || (!config.isLoading && !field);
  return (
    <Stack id="global-tls" data-testid="global-tls" component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.security.tls.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.security.tls.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <SettingsNotice tone="info">
        {i18n.t("admin.security.tls.instructions")}
      </SettingsNotice>
      {failed ? (
        <ErrorMessage role="alert">
          {i18n.t("admin.security.tls.unavailable")}
        </ErrorMessage>
      ) : config.isLoading || trust.isLoading || !trust.data ? (
        <SettingsNotice tone="info">
          {i18n.t("admin.common.loading")}
        </SettingsNotice>
      ) : (
        <>
          {trust.data.legacy && (
            <SettingsNotice tone="warning">
              {i18n.t("admin.security.tls.legacy")}
            </SettingsNotice>
          )}
          <SettingsDefinitionList>
            <SettingsDefinitionItem
              label={i18n.t("admin.security.tls.path")}
              mono
            >
              {typeof path === "string" && path
                ? path
                : i18n.t("admin.common.none")}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.security.tls.source")}
              mono
            >
              {[trust.data.source, trust.data.source_key]
                .filter(Boolean)
                .join(" · ") || i18n.t("admin.common.none")}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem label={i18n.t("admin.security.tls.count")}>
              {new Intl.NumberFormat(i18n.language).format(
                trust.data.additional_ca_count,
              )}
            </SettingsDefinitionItem>
            {trust.data.legacy && (
              <SettingsDefinitionItem
                label={i18n.t("admin.security.tls.legacy-count")}
              >
                {new Intl.NumberFormat(i18n.language).format(
                  trust.data.legacy_git_ca_count,
                )}
              </SettingsDefinitionItem>
            )}
            <SettingsDefinitionItem
              label={i18n.t("admin.security.tls.snapshot")}
              mono
            >
              {trust.data.snapshot_id}
            </SettingsDefinitionItem>
          </SettingsDefinitionList>
        </>
      )}
      <CaBundleManagement />
      <SettingsNotice tone="info">
        {i18n.t("admin.security.tls.restart")}
      </SettingsNotice>
    </Stack>
  );
}

const SECURITY_TABS = ["auth", "oauth", "cors", "captcha"] as const;

export function SecurityPage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(SECURITY_TABS, "auth");
  const {
    appConfig,
    patchedAppConfig,
    schema,
    update,
    saveGroup,
    resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath = {},
  } = useAppConfig();
  const revalidateServerConfig = useRevalidateServerConfig();

  const handleSaveGroup = useCallback(
    async (module: string) => {
      await saveGroup(module);
      await revalidateServerConfig();
    },
    [revalidateServerConfig, saveGroup],
  );

  const configProps = {
    appConfig,
    patchedAppConfig,
    schema,
    update,
    saveGroup: handleSaveGroup,
    resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath,
  };

  return (
    <AdminPageFrame
      title={i18n.t("admin.security.title")}
      routeAnchor="admin-route-security"
    >
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        layout="page"
        variant="default"
      >
        <AdminSubnav
          items={[
            {
              value: "auth",
              label: i18n.t("admin.security.tab.auth"),
              testId: "security-tab-trigger-auth",
            },
            {
              value: "oauth",
              label: i18n.t("admin.security.tab.oauth"),
              testId: "security-tab-trigger-oauth",
            },
            {
              value: "cors",
              label: i18n.t("admin.security.tab.cors"),
              testId: "security-tab-trigger-cors",
            },
            {
              value: "captcha",
              label: i18n.t("admin.security.tab.captcha"),
              testId: "security-tab-trigger-captcha",
            },
          ]}
        />
        <AdminPageScroll>
          <Stack>
            <OperationalReadinessNotice />

            <TabsContent value="auth" layout="stack">
              <ConfigTab
                module="auth"
                titleKey="admin.security.auth.title"
                descriptionKey="admin.security.auth.description"
                fields={AUTH_FIELDS}
                {...configProps}
              />
              <GlobalTlsTrust />
            </TabsContent>
            <TabsContent value="oauth" layout="stack">
              <OAuthSettingsTab appConfig={appConfig} />
            </TabsContent>
            <TabsContent value="cors" layout="stack">
              <ConfigTab
                module="cors"
                titleKey="admin.security.cors.title"
                descriptionKey="admin.security.cors.description"
                fields={CORS_FIELDS}
                {...configProps}
              />
            </TabsContent>
            <TabsContent value="captcha" layout="stack">
              <ConfigTab
                module="captcha"
                titleKey="admin.security.captcha.title"
                descriptionKey="admin.security.captcha.description"
                fields={CAPTCHA_FIELDS}
                {...configProps}
                extra={<CaptchaHealthPanel />}
              />
            </TabsContent>
          </Stack>
        </AdminPageScroll>
      </Tabs>
    </AdminPageFrame>
  );
}

export { SecurityPage as Component };
