/**
 * Step 4: Authentication Method
 *
 * Configures the runtime OAuth providers that are surfaced by the shared
 * sign-in flow. Password and magic-link support stay in the shared auth
 * runtime; this step only writes provider configuration.
 */
import { adminConfigValuesQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  ErrorMessage,
  Checkbox,
  Input,
  MyoxusSegmentedControl,
  RadioCardGroup,
  RadioCard,
  RadioCardIndicator,
  SelectionCardGrid,
  Group,
  Select,
  SettingsField,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsNotice,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useEffect,
  useId,
  useState,
  type SetStateAction,
} from "react";

import { OuPicker } from "../../../components/domain-pickers/ou-picker";
import { useAdminUpdateConfig } from "../../../hooks/use-admin-update-config";
import { gqlFetcher } from "../../../use-query";
import { adminConfigSnapshotToAppConfig } from "../../settings/use-admin-config-contract";
import {
  applyOidcProviderPreset,
  normalizeOidcProviderConfig,
  normalizeScopes,
  oidcMappingRuleError,
  OIDC_PROVIDER_PRESETS,
  type OidcGroupMappingRuleConfig,
  type OidcProviderPresetId,
  type OidcRole,
  ROLE_OPTIONS,
  serializeOidcProviderConfig,
} from "../../security/oidc-config";
import {
  ConfigWizardActions,
  ConfigWizardHelpText,
  ConfigWizardInlineControls,
  ConfigWizardStep,
  ConfigWizardStepHeader,
} from "../primitives";

interface AuthMethodStepProps {
  onNext: () => void;
  onBusyChange?: (busy: boolean) => void;
}

type AuthMethod = "magic-link" | "google" | "github" | "oidc" | null;

type ProviderOption = {
  id: Exclude<AuthMethod, null>;
  title: string;
  description: string;
};

export function AuthMethodStep({ onNext, onBusyChange }: AuthMethodStepProps) {
  const i18n = useI18n();
  const [selectedMethod, setSelectedMethod] =
    useState<AuthMethod>("magic-link");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [githubClientId, setGithubClientId] = useState("");
  const [githubClientSecret, setGithubClientSecret] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcIssuerUrl, setOidcIssuerUrl] = useState("");
  const [oidcDiscoveryUrl, setOidcDiscoveryUrl] = useState("");
  const [oidcAuthUrl, setOidcAuthUrl] = useState("");
  const [oidcTokenUrl, setOidcTokenUrl] = useState("");
  const [oidcUserinfoUrl, setOidcUserinfoUrl] = useState("");
  const [oidcJwksUrl, setOidcJwksUrl] = useState("");
  const [oidcScopes, setOidcScopes] = useState("openid profile email");
  const [oidcPreset, setOidcPreset] = useState<OidcProviderPresetId>("custom");
  const [oidcGroupMappingEnabled, setOidcGroupMappingEnabled] = useState(false);
  const [oidcDefaultRole, setOidcDefaultRole] = useState<OidcRole>("member");
  const [oidcMappingRules, setOidcMappingRules] = useState<
    OidcGroupMappingRuleConfig[]
  >([]);
  const [mappingEdits, setMappingEdits] = useState({
    enabled: false,
    defaultRole: false,
    mappings: false,
  });
  const [isSaving, setIsSaving] = useState(false);
  const editMappingRules = useCallback(
    (update: SetStateAction<OidcGroupMappingRuleConfig[]>) => {
      setMappingEdits((edits) => ({ ...edits, mappings: true }));
      setOidcMappingRules(update);
    },
    [],
  );
  const [showGoogleSecret, setShowGoogleSecret] = useState(false);
  const [showGithubSecret, setShowGithubSecret] = useState(false);
  const [showOidcSecret, setShowOidcSecret] = useState(false);
  const [error, setError] = useState("");
  const [showMappingErrors, setShowMappingErrors] = useState(false);
  const { mutate: updateConfig, isLoading } = useAdminUpdateConfig();

  useEffect(() => {
    onBusyChange?.(isLoading || isSaving);
  }, [onBusyChange, isLoading, isSaving]);

  const providerOptions: ProviderOption[] = [
    {
      id: "magic-link",
      title: i18n.t("admin.configWizard.authMethod.magicLink"),
      description: i18n.t("admin.configWizard.authMethod.magicLinkDesc"),
    },
    {
      id: "google",
      title: i18n.t("admin.configWizard.authMethod.google"),
      description: i18n.t("admin.configWizard.authMethod.googleDesc"),
    },
    {
      id: "github",
      title: i18n.t("admin.configWizard.authMethod.github"),
      description: i18n.t("admin.configWizard.authMethod.githubDesc"),
    },
    {
      id: "oidc",
      title: i18n.t("admin.configWizard.authMethod.oidc"),
      description: i18n.t("admin.configWizard.authMethod.oidcDesc"),
    },
  ];

  const setMethod = useCallback((method: AuthMethod) => {
    setSelectedMethod(method);
    setError("");
  }, []);

  const requireFields = useCallback(
    (fields: Array<[string, string]>) => {
      const missing = fields.find(([, value]) => !value.trim());
      if (missing) {
        setError(
          i18n
            .t("admin.configWizard.authMethod.error.required")
            .replace("{{field}}", missing[0]),
        );
        return false;
      }
      return true;
    },
    [i18n],
  );

  const validateConfig = useCallback(() => {
    setError("");

    if (selectedMethod === "google") {
      return requireFields([
        [i18n.t("admin.configWizard.authMethod.clientId"), googleClientId],
        [
          i18n.t("admin.configWizard.authMethod.clientSecret"),
          googleClientSecret,
        ],
      ]);
    }

    if (selectedMethod === "github") {
      return requireFields([
        [i18n.t("admin.configWizard.authMethod.clientId"), githubClientId],
        [
          i18n.t("admin.configWizard.authMethod.clientSecret"),
          githubClientSecret,
        ],
      ]);
    }

    if (selectedMethod === "oidc") {
      setShowMappingErrors(true);
      const invalid = oidcMappingRules.findIndex(
        (rule) => oidcMappingRuleError(rule) !== undefined,
      );
      if (invalid >= 0) {
        setError(
          i18n.t(oidcMappingRuleError(oidcMappingRules[invalid])!, {
            row: invalid + 1,
          }),
        );
        return false;
      }
      return requireFields([
        [i18n.t("admin.configWizard.authMethod.clientId"), oidcClientId],
        [
          i18n.t("admin.configWizard.authMethod.clientSecret"),
          oidcClientSecret,
        ],
        [i18n.t("admin.configWizard.authMethod.authUrl"), oidcAuthUrl],
        [i18n.t("admin.configWizard.authMethod.tokenUrl"), oidcTokenUrl],
        [i18n.t("admin.configWizard.authMethod.userinfoUrl"), oidcUserinfoUrl],
      ]);
    }

    return true;
  }, [
    githubClientId,
    githubClientSecret,
    googleClientId,
    googleClientSecret,
    i18n,
    oidcAuthUrl,
    oidcClientId,
    oidcClientSecret,
    oidcMappingRules,
    oidcTokenUrl,
    oidcUserinfoUrl,
    requireFields,
    selectedMethod,
  ]);

  const handleSave = useCallback(async () => {
    if (isSaving || !validateConfig()) {
      return;
    }

    setIsSaving(true);
    try {
      if (selectedMethod === "google") {
        await updateConfig({
          module: "oauth",
          key: "providers.google",
          value: {
            clientId: googleClientId.trim(),
            clientSecret: googleClientSecret.trim(),
          },
        });
      } else if (selectedMethod === "github") {
        await updateConfig({
          module: "oauth",
          key: "providers.github",
          value: {
            clientId: githubClientId.trim(),
            clientSecret: githubClientSecret.trim(),
          },
        });
      } else if (selectedMethod === "oidc") {
        // Setup edits only its exposed fields. Read the latest saved baseline
        // before writing the whole provider leaf; failure must not erase hidden
        // claims, sync policies or the independent directory-read credentials.
        const response = await gqlFetcher({ query: adminConfigValuesQuery });
        const snapshot = response.admin.adminConfigValues;
        const savedProvider =
          adminConfigSnapshotToAppConfig(snapshot).oauth?.providers?.oidc;
        const saved = normalizeOidcProviderConfig(savedProvider);
        const baseConfig = normalizeOidcProviderConfig({
          clientId: oidcClientId,
          clientSecret: oidcClientSecret,
          issuerUrl: oidcIssuerUrl,
          discoveryUrl: oidcDiscoveryUrl,
          authUrl: oidcAuthUrl,
          tokenUrl: oidcTokenUrl,
          userinfoUrl: oidcUserinfoUrl,
          jwksUrl: oidcJwksUrl,
          scopes: normalizeScopes(oidcScopes),
          groupMapping: {
            enabled: oidcGroupMappingEnabled,
            defaultRole: oidcDefaultRole,
            removeMissingOidcMemberships: true,
            missingGroupsPolicy: "deny_login",
            unknownGroups: "ignore",
            mappings: oidcMappingRules,
          },
        });
        const providerConfig =
          oidcPreset === "custom"
            ? baseConfig
            : applyOidcProviderPreset(baseConfig, oidcPreset);
        await updateConfig({
          module: "oauth",
          key: "providers.oidc",
          value: serializeOidcProviderConfig({
            ...providerConfig,
            groupDirectory: saved.groupDirectory,
            claims: savedProvider ? saved.claims : providerConfig.claims,
            groupMapping: {
              ...saved.groupMapping,
              enabled: mappingEdits.enabled
                ? oidcGroupMappingEnabled
                : saved.groupMapping.enabled,
              defaultRole: mappingEdits.defaultRole
                ? oidcDefaultRole
                : saved.groupMapping.defaultRole,
              mappings: mappingEdits.mappings
                ? oidcMappingRules
                : saved.groupMapping.mappings,
            },
          }),
        });
      }

      onNext();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : i18n.t("admin.configWizard.authMethod.error.persist");
      setError(message);
    } finally {
      setIsSaving(false);
    }
  }, [
    githubClientId,
    githubClientSecret,
    googleClientId,
    googleClientSecret,
    i18n,
    oidcAuthUrl,
    oidcClientId,
    oidcClientSecret,
    oidcDefaultRole,
    oidcDiscoveryUrl,
    oidcGroupMappingEnabled,
    oidcIssuerUrl,
    oidcJwksUrl,
    oidcMappingRules,
    oidcPreset,
    oidcScopes,
    oidcTokenUrl,
    oidcUserinfoUrl,
    isSaving,
    mappingEdits,
    onNext,
    selectedMethod,
    updateConfig,
    validateConfig,
  ]);

  const isSaveDisabled =
    !selectedMethod ||
    isLoading ||
    isSaving ||
    (selectedMethod === "google" && (!googleClientId || !googleClientSecret)) ||
    (selectedMethod === "github" && (!githubClientId || !githubClientSecret)) ||
    (selectedMethod === "oidc" &&
      (!oidcClientId ||
        !oidcClientSecret ||
        !oidcAuthUrl ||
        !oidcTokenUrl ||
        !oidcUserinfoUrl));

  const secretToggleLabel = (visible: boolean) =>
    visible ? i18n.t("common.hide") : i18n.t("common.show");

  return (
    <ConfigWizardStep>
      <ConfigWizardStepHeader
        title={i18n.t("admin.configWizard.authMethod.title")}
        description={i18n.t("admin.configWizard.authMethod.description")}
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <RadioCardGroup
        value={selectedMethod ?? undefined}
        onChange={(value) => {
          const option = providerOptions.find((option) => option.id === value);
          if (option) setMethod(option.id);
        }}
        aria-label={i18n.t("admin.configWizard.authMethod.title")}
      >
        <SelectionCardGrid>
          {providerOptions.map((option) => (
            <RadioCard key={option.id} value={option.id} disabled={isLoading}>
              <Stack>
                <Group>
                  <RadioCardIndicator />
                  <SettingsListItemTitle>{option.title}</SettingsListItemTitle>
                </Group>
                <SettingsListItemMeta>
                  {option.description}
                </SettingsListItemMeta>
              </Stack>
            </RadioCard>
          ))}
        </SelectionCardGrid>
      </RadioCardGroup>

      {selectedMethod === "google" && (
        <ProviderCredentials
          hint={i18n.t("admin.configWizard.authMethod.googleHint")}
          clientId={googleClientId}
          clientSecret={googleClientSecret}
          showSecret={showGoogleSecret}
          setClientId={setGoogleClientId}
          setClientSecret={setGoogleClientSecret}
          setShowSecret={setShowGoogleSecret}
          setError={setError}
          clientIdLabel={i18n.t("admin.configWizard.authMethod.clientId")}
          clientSecretLabel={i18n.t(
            "admin.configWizard.authMethod.clientSecret",
          )}
          secretToggleLabel={secretToggleLabel}
        />
      )}

      {selectedMethod === "github" && (
        <ProviderCredentials
          hint={i18n.t("admin.configWizard.authMethod.githubHint")}
          clientId={githubClientId}
          clientSecret={githubClientSecret}
          showSecret={showGithubSecret}
          setClientId={setGithubClientId}
          setClientSecret={setGithubClientSecret}
          setShowSecret={setShowGithubSecret}
          setError={setError}
          clientIdLabel={i18n.t("admin.configWizard.authMethod.clientId")}
          clientSecretLabel={i18n.t(
            "admin.configWizard.authMethod.clientSecret",
          )}
          secretToggleLabel={secretToggleLabel}
        />
      )}

      {selectedMethod === "oidc" && (
        <Stack gap="sm">
          <ConfigWizardHelpText>
            {i18n.t("admin.configWizard.authMethod.oidcHint")}
          </ConfigWizardHelpText>
          <SettingsField label={i18n.t("admin.security.oauth.preset")}>
            <Stack gap="xs">
              <MyoxusSegmentedControl
                value={oidcPreset}
                onChange={(value) =>
                  setOidcPreset(value as OidcProviderPresetId)
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
                  const config = applyOidcProviderPreset(
                    normalizeOidcProviderConfig({
                      clientId: oidcClientId,
                      clientSecret: oidcClientSecret,
                      issuerUrl: oidcIssuerUrl,
                      discoveryUrl: oidcDiscoveryUrl,
                      authUrl: oidcAuthUrl,
                      tokenUrl: oidcTokenUrl,
                      userinfoUrl: oidcUserinfoUrl,
                      jwksUrl: oidcJwksUrl,
                      scopes: normalizeScopes(oidcScopes),
                      groupMapping: {
                        enabled: oidcGroupMappingEnabled,
                        defaultRole: oidcDefaultRole,
                        removeMissingOidcMemberships: true,
                        missingGroupsPolicy: "deny_login",
                        unknownGroups: "ignore",
                        mappings: oidcMappingRules,
                      },
                    }),
                    oidcPreset,
                  );
                  setOidcIssuerUrl(config.issuerUrl ?? "");
                  setOidcDiscoveryUrl(config.discoveryUrl ?? "");
                  setOidcAuthUrl(config.authUrl);
                  setOidcTokenUrl(config.tokenUrl);
                  setOidcUserinfoUrl(config.userinfoUrl);
                  setOidcJwksUrl(config.jwksUrl ?? "");
                  setOidcScopes(config.scopes.join(" "));
                  setOidcDefaultRole(config.groupMapping.defaultRole);
                  setError("");
                }}
              >
                {i18n.t("admin.security.oauth.apply-preset")}
              </Button>
            </Stack>
          </SettingsField>
          <ProviderCredentials
            clientId={oidcClientId}
            clientSecret={oidcClientSecret}
            showSecret={showOidcSecret}
            setClientId={setOidcClientId}
            setClientSecret={setOidcClientSecret}
            setShowSecret={setShowOidcSecret}
            setError={setError}
            clientIdLabel={i18n.t("admin.configWizard.authMethod.clientId")}
            clientSecretLabel={i18n.t(
              "admin.configWizard.authMethod.clientSecret",
            )}
            secretToggleLabel={secretToggleLabel}
          />
          <EndpointInput
            label={i18n.t("admin.configWizard.authMethod.issuerUrl")}
            placeholder={i18n.t(
              "admin.configWizard.authMethod.endpointPlaceholder",
            )}
            value={oidcIssuerUrl}
            onChange={setOidcIssuerUrl}
            setError={setError}
          />
          <EndpointInput
            label={i18n.t("admin.configWizard.authMethod.discoveryUrl")}
            placeholder={i18n.t(
              "admin.configWizard.authMethod.discoveryPlaceholder",
            )}
            value={oidcDiscoveryUrl}
            onChange={setOidcDiscoveryUrl}
            setError={setError}
          />
          <EndpointInput
            label={i18n.t("admin.configWizard.authMethod.authUrl")}
            placeholder={i18n.t(
              "admin.configWizard.authMethod.endpointPlaceholder",
            )}
            value={oidcAuthUrl}
            onChange={setOidcAuthUrl}
            setError={setError}
          />
          <EndpointInput
            label={i18n.t("admin.configWizard.authMethod.tokenUrl")}
            placeholder={i18n.t(
              "admin.configWizard.authMethod.endpointPlaceholder",
            )}
            value={oidcTokenUrl}
            onChange={setOidcTokenUrl}
            setError={setError}
          />
          <EndpointInput
            label={i18n.t("admin.configWizard.authMethod.userinfoUrl")}
            placeholder={i18n.t(
              "admin.configWizard.authMethod.endpointPlaceholder",
            )}
            value={oidcUserinfoUrl}
            onChange={setOidcUserinfoUrl}
            setError={setError}
          />
          <EndpointInput
            label={i18n.t("admin.configWizard.authMethod.jwksUrl")}
            placeholder={i18n.t(
              "admin.configWizard.authMethod.endpointPlaceholder",
            )}
            value={oidcJwksUrl}
            onChange={setOidcJwksUrl}
            setError={setError}
          />
          <EndpointInput
            label={i18n.t("admin.configWizard.authMethod.scopes")}
            placeholder="openid profile email"
            value={oidcScopes}
            onChange={setOidcScopes}
            setError={setError}
            type="text"
          />
          <Stack gap="xs">
            <Checkbox
              checked={oidcGroupMappingEnabled}
              onChange={(_, checked) => {
                setOidcGroupMappingEnabled(checked);
                setMappingEdits((edits) => ({ ...edits, enabled: true }));
              }}
              label={i18n.t(
                "admin.configWizard.authMethod.groupMappingEnabled",
              )}
            />
            {oidcGroupMappingEnabled ? (
              <Stack gap="xs">
                <SettingsField
                  label={i18n.t("admin.security.oauth.default-role")}
                >
                  <Select
                    value={oidcDefaultRole}
                    onChange={(value) => {
                      setOidcDefaultRole(value as OidcRole);
                      setMappingEdits((edits) => ({
                        ...edits,
                        defaultRole: true,
                      }));
                    }}
                    data={ROLE_OPTIONS.map((option) => ({
                      value: option.value,
                      label: i18n.t(option.labelKey),
                    }))}
                  />
                </SettingsField>
                {oidcMappingRules.length > 0 ? (
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
                      {oidcMappingRules.map((mapping, index) => (
                        <TableRow key={index}>
                          <TableCell>
                            <Input
                              value={mapping.providerGroup}
                              onChange={(value) =>
                                editMappingRules((rules) =>
                                  rules.map((rule, currentIndex) =>
                                    currentIndex === index
                                      ? { ...rule, providerGroup: value }
                                      : rule,
                                  ),
                                )
                              }
                              placeholder="finance/managers"
                              error={
                                showMappingErrors &&
                                oidcMappingRuleError(mapping) ===
                                  "admin.security.oauth.mapping-group-required"
                              }
                            />
                            {showMappingErrors &&
                            oidcMappingRuleError(mapping) ? (
                              <ErrorMessage role="alert">
                                {i18n.t(oidcMappingRuleError(mapping)!, {
                                  row: index + 1,
                                })}
                              </ErrorMessage>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <OuPicker
                              value={mapping.targetUnitId || null}
                              displayValue={mapping.targetUnitId || null}
                              onChange={(value) =>
                                editMappingRules((rules) =>
                                  rules.map((rule, currentIndex) =>
                                    currentIndex === index
                                      ? { ...rule, targetUnitId: value ?? "" }
                                      : rule,
                                  ),
                                )
                              }
                              placeholder={i18n.t(
                                "admin.security.oauth.target-ou-placeholder",
                              )}
                            />
                          </TableCell>
                          <TableCell>
                            <Select
                              value={mapping.role ?? oidcDefaultRole}
                              onChange={(value) =>
                                editMappingRules((rules) =>
                                  rules.map((rule, currentIndex) =>
                                    currentIndex === index
                                      ? { ...rule, role: value as OidcRole }
                                      : rule,
                                  ),
                                )
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
                              onClick={() =>
                                editMappingRules((rules) =>
                                  rules.filter(
                                    (_, currentIndex) => currentIndex !== index,
                                  ),
                                )
                              }
                            >
                              {i18n.t("admin.security.oauth.remove-mapping")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <SettingsNotice tone="info">
                    {i18n.t("admin.configWizard.authMethod.groupMappingEmpty")}
                  </SettingsNotice>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    editMappingRules((rules) => [
                      ...rules,
                      {
                        providerGroup: "",
                        targetUnitId: "",
                        role: oidcDefaultRole,
                      },
                    ])
                  }
                >
                  {i18n.t("admin.security.oauth.add-mapping")}
                </Button>
              </Stack>
            ) : null}
          </Stack>
        </Stack>
      )}

      <ConfigWizardActions centered={false}>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={isSaveDisabled}
        >
          {isLoading || isSaving
            ? i18n.t("common.saving")
            : i18n.t("common.continue")}
        </Button>
      </ConfigWizardActions>
    </ConfigWizardStep>
  );
}

function ProviderCredentials({
  hint,
  clientId,
  clientSecret,
  showSecret,
  setClientId,
  setClientSecret,
  setShowSecret,
  setError,
  clientIdLabel,
  clientSecretLabel,
  secretToggleLabel,
}: {
  hint?: string;
  clientId: string;
  clientSecret: string;
  showSecret: boolean;
  setClientId: (value: string) => void;
  setClientSecret: (value: string) => void;
  setShowSecret: (value: boolean) => void;
  setError: (value: string) => void;
  clientIdLabel: string;
  clientSecretLabel: string;
  secretToggleLabel: (visible: boolean) => string;
}) {
  const clientIdInputId = useId();
  const clientSecretInputId = useId();

  return (
    <Stack gap="sm">
      {hint ? <ConfigWizardHelpText>{hint}</ConfigWizardHelpText> : null}
      <SettingsField label={clientIdLabel} labelFor={clientIdInputId}>
        <Input
          id={clientIdInputId}
          type="text"
          value={clientId}
          onChange={(value) => {
            setClientId(value);
            setError("");
          }}
        />
      </SettingsField>
      <SettingsField label={clientSecretLabel} labelFor={clientSecretInputId}>
        <ConfigWizardInlineControls>
          <Input
            id={clientSecretInputId}
            type={showSecret ? "text" : "password"}
            value={clientSecret}
            onChange={(value) => {
              setClientSecret(value);
              setError("");
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowSecret(!showSecret)}
          >
            {secretToggleLabel(showSecret)}
          </Button>
        </ConfigWizardInlineControls>
      </SettingsField>
    </Stack>
  );
}

function EndpointInput({
  label,
  placeholder,
  value,
  onChange,
  setError,
  type = "url",
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  setError: (value: string) => void;
  type?: "url" | "text";
}) {
  const inputId = useId();

  return (
    <SettingsField label={label} labelFor={inputId}>
      <Input
        id={inputId}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(nextValue) => {
          onChange(nextValue);
          setError("");
        }}
      />
    </SettingsField>
  );
}
