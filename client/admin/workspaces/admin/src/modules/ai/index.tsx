/**
 * AI page — configuration for Copilot, transcription, Indexer, and MCP.
 *
 * Sections:
 *   - Copilot   (module: copilot)
 *     1. Global Settings  — master toggle, default/fallback providers and timeout
 *     2. Providers        — native provider accordions (predefined + custom)
 *     3. Embedding API    — separate search-only endpoint/key/model/dimensions/task encoding
 *     4. Storage          — storage_prefix; storage backend is shared with blob
 *     5. External Services — Unsplash image search, Exa web search
 *   - Indexer   (module: indexer) — search index provider config
 *   - MCP       (module: mcp)     — Model Context Protocol toggle
 *
 * --------------------------------------------------------------------------
 * SAVE MUTATION FORMAT (P100-H-03-0a)
 * --------------------------------------------------------------------------
 * `adminUpdateConfig` accepts `{ module, key, value }` updates. Provider edits
 * are accumulated below the canonical `copilot.providers` object so a save
 * writes one complete, typed provider map rather than partial child rows.
 * --------------------------------------------------------------------------
 */
import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  NumberInput,
  SettingsNotice,
  Button,
  DialogFooterActions,
  Divider,
  FormFieldset,
  Group,
  Input,
  MetricStack,
  Modal,
  MonoText,
  notify,
  PasswordInput,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsField,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsStatusText,
  SimpleGrid,
  Stack,
  StatusDot,
  Tabs,
  TabsContent,
} from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

import { PageConfigErrorBoundary } from "../../components/page-config-error-boundary";
import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { ALL_CONFIG_DESCRIPTORS, type AppConfig } from "../settings/config";
import {
  ConfigArrayField,
  ConfigBooleanField,
  type ConfigControlType,
  ConfigJsonField,
  ConfigNumberField,
  ConfigSelectField,
  ConfigTextField,
  YamlOnlyBanner,
} from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import {
  type AdminConfigSchemaField,
  buildSchemaFieldMap,
} from "../settings/schema-utils";
import { isSensitiveConfigField } from "../settings/sensitive";
import { useAppConfig } from "../settings/use-app-config";
import { useFieldErrors } from "../settings/use-field-errors";
import { getByPath, isEqual } from "../settings/utils";
import { CopilotProviderCard } from "./copilot-provider-card";
import { TranscriptionTab } from "./transcription-tab";

// ---------------------------------------------------------------------------
// Predefined provider list with defaults
// ---------------------------------------------------------------------------

type PredefinedProvider = {
  id: string;
  name: string;
};

const COPILOT_PROVIDERS: PredefinedProvider[] = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "gemini", name: "Google Gemini" },
  { id: "perplexity", name: "Perplexity" },
  { id: "fal", name: "fal.ai" },
  { id: "morph", name: "Morph" },
  { id: "local", name: "Local (Ollama/OpenAI-compatible)" },
];

const AI_TAB_IDS = ["copilot", "transcription", "indexer", "mcp"] as const;
const AI_TAB_LABEL_KEYS = {
  copilot: "admin.ai.copilot",
  transcription: "admin.transcription.title",
  indexer: "admin.ai.indexer",
  mcp: "admin.ai.mcp",
} as const;
const AI_SECTION_DESCRIPTION_KEYS = {
  indexer: "admin.ai.indexer.description",
  mcp: "admin.ai.mcp.description",
} as const;

// ---------------------------------------------------------------------------
// Section definitions for Indexer and MCP
// ---------------------------------------------------------------------------

type FieldDef = {
  key: string;
  type?: ConfigControlType;
  desc?: string;
  suffix?: string;
  options?: string[];
};

type ModuleDef = {
  module: string;
  fields: FieldDef[];
};

/** A sub-field that lives under a parent key (e.g. storage.provider). */
type SubFieldDef = {
  parentKey: string;
  subKey: string;
  type: ConfigControlType;
  desc: string;
  options?: string[];
};

type SimpleSection = {
  module: "indexer" | "mcp";
  modules: ModuleDef[];
  subFields?: { module: string; defs: SubFieldDef[] }[];
};

function AiConfigField({
  module,
  field,
  sourceConfig,
  schemaField,
  showGroupYamlBanner,
  error,
  onErrorChange,
  update,
  saveField,
}: {
  module: string;
  field: FieldDef;
  sourceConfig: Record<string, unknown> | undefined;
  schemaField?: AdminConfigSchemaField | null;
  showGroupYamlBanner: boolean;
  error?: string;
  onErrorChange: (field: string, error?: string) => void;
  update: (path: string, value: unknown) => void;
  saveField: (field: string, value: unknown) => Promise<void>;
}) {
  const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[field.key];
  const fieldPath = `${module}/${field.key}`;
  const type = (field.type ??
    schemaField?.valueType ??
    "String") as ConfigControlType;
  const commonProps = {
    field: fieldPath,
    desc: field.desc ?? descriptor?.desc ?? "",
    defaultValue: getByPath(sourceConfig, field.key),
    onChange: update,
    databaseWritable: schemaField?.databaseWritable,
    restartRequired: Boolean(schemaField?.restart_required),
    suppressYamlBanner: showGroupYamlBanner,
    error,
    onErrorChange,
  };
  const sensitive = Boolean(schemaField?.sensitive);

  if (type === "Boolean") {
    return (
      <ConfigBooleanField
        {...commonProps}
        immediateApply={Boolean(schemaField?.immediate_apply)}
        onSave={schemaField?.immediate_apply ? saveField : undefined}
      />
    );
  }
  if (type === "Number") {
    return (
      <ConfigNumberField
        {...commonProps}
        suffix={field.suffix}
        min={schemaField?.min ?? undefined}
        max={schemaField?.max ?? undefined}
      />
    );
  }
  if (type === "Enum") {
    return <ConfigSelectField {...commonProps} options={field.options ?? []} />;
  }
  if (type === "JSON") return <ConfigJsonField {...commonProps} />;
  return <ConfigTextField {...commonProps} sensitive={sensitive} />;
}

function AiSubConfigField({
  module,
  field,
  sourceConfig,
  schemaField,
  showGroupYamlBanner,
  error,
  onErrorChange,
  update,
}: {
  module: string;
  field: SubFieldDef;
  sourceConfig: Record<string, unknown> | undefined;
  schemaField:
    | {
        databaseWritable?: boolean;
        restart_required?: boolean | null;
      }
    | null
    | undefined;
  showGroupYamlBanner: boolean;
  error?: string;
  onErrorChange: (field: string, error?: string) => void;
  update: (path: string, value: unknown) => void;
}) {
  const fieldPath = `${module}/${field.parentKey}/${field.subKey}`;
  const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[field.parentKey] ?? {
    desc: "",
    type: "JSON",
  };
  const commonProps = {
    field: fieldPath,
    desc: field.desc,
    defaultValue: getByPath(sourceConfig, `${field.parentKey}.${field.subKey}`),
    onChange: update,
    databaseWritable: schemaField?.databaseWritable,
    restartRequired: Boolean(schemaField?.restart_required),
    suppressYamlBanner: showGroupYamlBanner,
    error,
    onErrorChange,
  };
  const sensitive = isSensitiveConfigField(module, field.parentKey, descriptor);

  if (field.type === "Number") return <ConfigNumberField {...commonProps} />;
  if (field.type === "Enum") {
    return <ConfigSelectField {...commonProps} options={field.options ?? []} />;
  }
  if (field.type === "Boolean") return <ConfigBooleanField {...commonProps} />;
  return <ConfigTextField {...commonProps} sensitive={sensitive} />;
}

const SIMPLE_SECTIONS: SimpleSection[] = [
  {
    module: "indexer",
    modules: [
      {
        module: "indexer",
        fields: [
          { key: "enabled", type: "Boolean" },
          { key: "provider_type" },
          { key: "provider_endpoint" },
          { key: "provider_api_key" },
          { key: "provider_username" },
          { key: "provider_password" },
          { key: "auto_index_batch_size", type: "Number" },
        ],
      },
    ],
  },
  {
    module: "mcp",
    modules: [
      {
        module: "mcp",
        fields: [{ key: "enabled", type: "Boolean" }],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// PasswordSecretField — a labeled, sensitive Copilot configuration field
// ---------------------------------------------------------------------------

function PasswordSecretField({
  label,
  fieldPath,
  description,
  patchedAppConfig,
  onUpdate,
  databaseWritable,
  error,
}: {
  label: string;
  fieldPath: string;
  description?: string;
  patchedAppConfig: AppConfig;
  onUpdate: (field: string, value: any) => void;
  databaseWritable?: boolean;
  error?: string;
}) {
  const i18n = useI18n();
  const [module, ...keyParts] = fieldPath.split("/");
  const dotPath = keyParts.join(".");
  const moduleConfig = patchedAppConfig[module] as any;
  const value = dotPath.includes(".")
    ? getByPath(moduleConfig, dotPath)
    : moduleConfig?.[dotPath];
  const currentValue = (value ?? "") as string;

  const isConfigured = currentValue.trim().length > 0;
  const inputId = `secret-field-${fieldPath.replace(/[/.]/g, "-")}`;

  return (
    <SettingsField
      label={
        <Group justify="space-between">
          {label}
          <StatusDot
            tone={isConfigured ? "success" : "neutral"}
            label={
              isConfigured
                ? i18n.t("admin.ai.provider.configured")
                : i18n.t("admin.ai.provider.not-configured")
            }
          />
        </Group>
      }
      description={description}
      labelFor={inputId}
    >
      {databaseWritable === false ? <YamlOnlyBanner /> : null}
      <PasswordInput
        autoComplete="new-password"
        id={inputId}
        aria-label={label}
        disabled={databaseWritable === false}
        error={error}
        value={currentValue}
        onChange={(value) => onUpdate(fieldPath, value)}
        placeholder={i18n.t("admin.ai.secret-field.placeholder")}
        data-testid={inputId}
      />
      <SettingsStatusText>
        {i18n.t("admin.ai.secret-field.env-hint")}
      </SettingsStatusText>
    </SettingsField>
  );
}

// ---------------------------------------------------------------------------
// AddCustomProviderDialog
// ---------------------------------------------------------------------------

function AddCustomProviderDialog({
  existingIds,
  onAdd,
  onClose,
}: {
  existingIds: string[];
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const [providerId, setProviderId] = useState("");
  const [error, setError] = useState("");

  const validate = (id: string) => {
    if (!id) return i18n.t("admin.ai.validation.provider-id-required");
    if (!/^[a-z0-9-_]+$/.test(id))
      return i18n.t("admin.ai.validation.provider-id-format");
    if (existingIds.includes(id))
      return i18n.t("admin.ai.validation.provider-id-exists");
    return "";
  };

  const handleAdd = () => {
    const err = validate(providerId.trim());
    if (err) {
      setError(err);
      return;
    }
    onAdd(providerId.trim());
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={i18n.t("admin.ai.provider.add-custom")}
      contentOptions={{ "data-testid": "add-custom-provider-dialog" }}
    >
      <Stack>
        <Input
          autoFocus
          id="custom-provider-id"
          data-testid="custom-provider-id-input"
          label={i18n.t("admin.ai.provider.id-label")}
          description={i18n.t("admin.ai.provider.id-hint")}
          error={error || undefined}
          value={providerId}
          onChange={(value) => {
            setProviderId(value);
            setError("");
          }}
          onEnter={handleAdd}
          placeholder={i18n.t("admin.ai.provider.id-placeholder")}
        />
        <Divider />
        <DialogFooterActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            {i18n.t("admin.common.cancel")}
          </Button>
          <Button
            type="button"
            data-testid="confirm-add-custom-provider"
            variant="primary"
            onClick={handleAdd}
          >
            {i18n.t("admin.ai.provider.add")}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// EmbeddingSection — collapsible embedding API section
// ---------------------------------------------------------------------------

function EmbeddingSection({
  patchedAppConfig,
  onUpdate,
  disabled = false,
  readOnlyFields = [],
  errors = {},
  onErrorChange,
  schemaFields = {},
}: {
  patchedAppConfig: AppConfig;
  onUpdate: (field: string, value: any) => void;
  disabled?: boolean;
  readOnlyFields?: string[];
  errors?: Record<string, string>;
  onErrorChange: (field: string, error?: string) => void;
  schemaFields?: Record<string, AdminConfigSchemaField>;
}) {
  const i18n = useI18n();
  const [expanded, setExpanded] = useState(false);
  const copilot = patchedAppConfig["copilot"] as any;

  const endpointVal = (getByPath(copilot, "embedding.endpoint") ??
    "") as string;
  const apiKeyVal = (getByPath(copilot, "embedding.api_key") ?? "") as string;
  const modelVal = (getByPath(copilot, "embedding.model") ?? "") as string;
  const dimsVal = (getByPath(copilot, "embedding.dimensions") ??
    1536) as number;
  const dimsMin = schemaFields["embedding.dimensions"]?.min ?? 1;
  const dimsMax = schemaFields["embedding.dimensions"]?.max ?? 16000;

  const localEndpoint = endpointVal;
  const localApiKey = apiKeyVal;
  const localModel = modelVal;
  const [localDims, setLocalDims] = useState<string | number>(dimsVal);
  const [dimsError, setDimsError] = useState<string>();
  const [dimsSource, setDimsSource] = useState(dimsVal);
  if (dimsSource !== dimsVal) {
    setDimsSource(dimsVal);
    setLocalDims(dimsVal);
    setDimsError(undefined);
  }
  useEffect(() => {
    onErrorChange("copilot/embedding.dimensions", dimsError);
  }, [dimsError, onErrorChange]);
  const serverError = Object.values(errors).filter(Boolean).join("\n");
  useEffect(() => {
    if (serverError) setExpanded(true);
  }, [serverError]);
  const fieldDisabled = (field: string) =>
    disabled || readOnlyFields.includes(field);

  return (
    <Accordion
      value={expanded ? "embedding" : null}
      onChange={(value) => setExpanded(Boolean(value))}
      keepMounted={false}
    >
      <AccordionItem value="embedding" data-testid="embedding-section">
        <AccordionControl data-testid="embedding-section-toggle">
          {i18n.t("admin.ai.provider.embedding-section")}
        </AccordionControl>
        <AccordionPanel>
          <Stack>
            {serverError ? (
              <SettingsNotice tone="error">{serverError}</SettingsNotice>
            ) : null}
            <SettingsField
              label={i18n.t("admin.ai.provider.field.endpoint")}
              labelFor="embedding-endpoint"
            >
              <Input
                id="embedding-endpoint"
                disabled={fieldDisabled("embedding.endpoint")}
                error={errors["embedding.endpoint"]}
                data-testid="embedding-endpoint-input"
                value={localEndpoint}
                onChange={(value) => {
                  onUpdate("copilot/embedding.endpoint", value);
                }}
                placeholder={i18n.t("admin.ai.embedding.endpoint-placeholder")}
              />
            </SettingsField>

            <SettingsField
              label={i18n.t("admin.ai.embedding.field.apiKey")}
              labelFor="embedding-apiKey"
              description={i18n.t("admin.ai.embedding.env-hint")}
            >
              <PasswordInput
                id="embedding-apiKey"
                autoComplete="new-password"
                disabled={fieldDisabled("embedding.api_key")}
                error={errors["embedding.api_key"]}
                data-testid="embedding-apikey-input"
                value={localApiKey}
                onChange={(value) => {
                  onUpdate("copilot/embedding.api_key", value);
                }}
                placeholder={i18n.t("admin.ai.embedding.api-key-placeholder")}
              />
            </SettingsField>

            <SettingsField
              label={i18n.t("admin.ai.embedding.field.model")}
              labelFor="embedding-model"
            >
              <Input
                id="embedding-model"
                disabled={fieldDisabled("embedding.model")}
                error={errors["embedding.model"]}
                data-testid="embedding-model-input"
                value={localModel}
                onChange={(value) => {
                  onUpdate("copilot/embedding.model", value);
                }}
                placeholder={i18n.t("admin.ai.embedding.model-placeholder")}
              />
            </SettingsField>

            <SettingsField
              label={i18n.t("admin.ai.embedding.field.dimensions")}
              labelFor="embedding-dims"
            >
              <NumberInput
                id="embedding-dims"
                disabled={fieldDisabled("embedding.dimensions")}
                error={errors["embedding.dimensions"] ?? dimsError}
                data-testid="embedding-dims-input"
                min={dimsMin}
                max={dimsMax}
                allowDecimal={false}
                value={localDims}
                onChange={(value) => {
                  setLocalDims(value);
                  const valid =
                    typeof value === "number" &&
                    Number.isInteger(value) &&
                    value >= dimsMin &&
                    value <= dimsMax;
                  const nextError = valid
                    ? undefined
                    : i18n.t("admin.config.validation.integer-range", {
                        min: String(dimsMin),
                        max: String(dimsMax),
                      });
                  setDimsError(nextError);
                  if (valid) onUpdate("copilot/embedding.dimensions", value);
                }}
                placeholder={i18n.t(
                  "admin.ai.embedding.dimensions-placeholder",
                )}
              />
            </SettingsField>
            <ConfigBooleanField
              field="copilot/embedding.send_task_type"
              label={i18n.t("admin.ai.embedding.task-type")}
              desc={i18n.t("admin.ai.embedding.task-type-hint")}
              defaultValue={
                getByPath(copilot, "embedding.send_task_type") ?? false
              }
              onChange={onUpdate}
              disabled={fieldDisabled("embedding.send_task_type")}
              databaseWritable={
                schemaFields["embedding.send_task_type"]?.databaseWritable
              }
              restartRequired={
                schemaFields["embedding.send_task_type"]?.restart_required ??
                undefined
              }
              error={errors["embedding.send_task_type"]}
              onErrorChange={onErrorChange}
            />
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// CopilotStorageSection
// ---------------------------------------------------------------------------

function CopilotStorageSection({
  patchedAppConfig,
  onUpdate,
  schemaField,
  error,
  onErrorChange,
}: {
  patchedAppConfig: AppConfig;
  onUpdate: (field: string, value: any) => void;
  schemaField?: AdminConfigSchemaField;
  error?: string;
  onErrorChange: (field: string, error?: string) => void;
}) {
  const i18n = useI18n();
  const copilot = patchedAppConfig["copilot"] as any;
  const storage = patchedAppConfig["storage"] as any;

  const prefixVal = (getByPath(copilot, "storage_prefix") ??
    "copilot/") as string;

  // Copilot objects use the canonical shared storage backend.
  const blobProvider = (storage?.backend ?? "local") as string;

  return (
    <Stack>
      <ConfigTextField
        field="copilot/storage_prefix"
        label={i18n.t("admin.ai.storage.prefix-label")}
        desc={i18n.t("admin.ai.storage.prefix-hint")}
        defaultValue={prefixVal}
        onChange={onUpdate}
        placeholder={i18n.t("admin.ai.storage.prefix-placeholder")}
        databaseWritable={schemaField?.databaseWritable}
        restartRequired={Boolean(schemaField?.restart_required)}
        error={error}
        onErrorChange={onErrorChange}
      />
      <SettingsDefinitionList>
        <SettingsDefinitionItem
          label={i18n.t("admin.ai.storage.provider-label")}
          mono
        >
          <MonoText data-testid="copilot-storage-provider-readonly">
            {blobProvider}
          </MonoText>
        </SettingsDefinitionItem>
      </SettingsDefinitionList>
      <SettingsStatusText>
        {i18n.t("admin.ai.storage.provider-hint")}
      </SettingsStatusText>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function AiPage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(AI_TAB_IDS, "copilot");
  const config = useAppConfig();
  const {
    appConfig,
    patchedAppConfig,
    schema,
    update,
    saveGroup,
    saveField,
    resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath = {},
  } = config;

  const { fieldErrors, hasFieldError, onFieldErrorChange } = useFieldErrors();
  const [routingExpanded, setRoutingExpanded] = useState<
    string | string[] | null
  >(null);
  const [externalExpanded, setExternalExpanded] = useState<
    string | string[] | null
  >(null);
  const [indexerExpanded, setIndexerExpanded] = useState<
    string | string[] | null
  >(null);
  // Error ownership is independent of disclosure visibility and active page tab.
  const routingError = Boolean(fieldErrorsByPath["copilot/request_timeout_ms"]);
  const externalError = ["unsplash", "exa"].some((key) =>
    Boolean(fieldErrorsByPath[`copilot/${key}`]),
  );
  const indexerError = Object.keys(fieldErrorsByPath).some(
    (path) => path.startsWith("indexer/") && path !== "indexer/enabled",
  );
  useEffect(() => {
    if (routingError) setRoutingExpanded("routing");
  }, [routingError]);
  useEffect(() => {
    if (externalError) setExternalExpanded("external");
  }, [externalError]);
  useEffect(() => {
    if (indexerError) setIndexerExpanded("indexer");
  }, [indexerError]);

  // Custom provider IDs (user-added, not predefined)
  const predefinedIds = new Set(COPILOT_PROVIDERS.map((p) => p.id));
  const allProviderIds = Object.keys(
    (patchedAppConfig["copilot"] as any)?.providers ?? {},
  );
  const customProviderIds = allProviderIds.filter(
    (id) => !predefinedIds.has(id),
  );
  const [showAddDialog, setShowAddDialog] = useState(false);

  // Build schema field maps per module for sub-field source lookup
  const subFieldSchemaMap: Record<string, Record<string, any>> = {};
  for (const schemaModule of schema?.modules ?? []) {
    const moduleFields: Record<string, any> = (subFieldSchemaMap[
      schemaModule.module
    ] = {});
    for (const group of schemaModule.groups ?? []) {
      for (const schemaField of group.fields ?? []) {
        moduleFields[schemaField.key] = schemaField;
      }
    }
  }

  // Copilot section save/reset helpers
  const copilotDirty = isGroupDirty("copilot");
  const copilotSaving = isGroupSaving("copilot");
  const copilotHasErrors = hasFieldError(["copilot"]);
  const copilotVersionKey = getGroupVersion("copilot");
  const providersReadOnly =
    subFieldSchemaMap.copilot?.providers?.databaseWritable === false;
  const providerError = fieldErrorsByPath["copilot/providers"]?.message;
  const embeddingErrors = Object.fromEntries(
    Object.entries(fieldErrorsByPath)
      .filter(([path]) => path.startsWith("copilot/embedding."))
      .map(([path, error]) => [path.slice("copilot/".length), error.message]),
  );
  const embeddingReadOnlyFields = Object.entries(
    subFieldSchemaMap.copilot ?? {},
  )
    .filter(
      ([key, field]) =>
        key.startsWith("embedding.") && field.databaseWritable === false,
    )
    .map(([key]) => key);

  const handleCopilotSave = async () => {
    await saveGroup("copilot");
  };

  const handleCopilotReset = () => {
    resetGroup("copilot");
    for (const path of Object.keys(fieldErrors)) {
      if (path.startsWith("copilot/")) onFieldErrorChange(path);
    }
  };

  const handleAddCustomProvider = (id: string) => {
    // Set defaults for the new custom provider
    update(`copilot/providers/${id}.kind`, "custom");
    update(`copilot/providers/${id}.enabled`, false);
    update(`copilot/providers/${id}.endpoint`, "");
    update(`copilot/providers/${id}.api_key`, "");
    update(`copilot/providers/${id}.models`, []);
    update(`copilot/providers/${id}.timeout_ms`, 30000);
    setShowAddDialog(false);
  };

  const handleRemoveCustomProvider = (id: string) => {
    // Clear the provider config by setting empty values
    const nextProviders = { ...allProviders };
    delete nextProviders[id];
    update("copilot/providers", nextProviders);
  };

  const allExistingProviderIds = [
    ...COPILOT_PROVIDERS.map((p) => p.id),
    ...customProviderIds,
  ];

  // Derive active providers for warnings
  const copilotCfg = patchedAppConfig["copilot"] as any;
  const allProviders = (copilotCfg?.providers ?? {}) as Record<string, any>;
  const savedProviders = (appConfig.copilot as any)?.providers ?? {};
  // The server validates the provider map atomically. Open changed owners,
  // not every provider, when that shared field is rejected.
  const errorForProvider = (id: string) =>
    providerError && !isEqual(savedProviders[id], allProviders[id])
      ? providerError
      : undefined;
  const activeProviderIds = Object.entries(allProviders)
    .filter(
      ([, cfg]) =>
        (cfg as any)?.enabled &&
        ((cfg as any)?.kind === "local" || (cfg as any)?.api_key),
    )
    .map(([id]) => id);
  const noActiveProvider = activeProviderIds.length === 0;
  const masterEnabled = Boolean(getByPath(copilotCfg, "enabled"));
  const defaultProvider = (getByPath(copilotCfg, "default_provider") ??
    "") as string;
  const defaultProviderIsInactive =
    defaultProvider && !activeProviderIds.includes(defaultProvider);
  const cloudProviders = COPILOT_PROVIDERS.filter((p) => p.id !== "local");
  const localProviders = COPILOT_PROVIDERS.filter((p) => p.id === "local");
  const enabledProviderCount = activeProviderIds.length;

  return (
    <AdminPageFrame
      title={i18n.t("admin.ai.title")}
      routeAnchor="admin-route-ai"
      actions={
        activeTab === "copilot" ? (
          <MetricStack
            rows={[
              {
                label: i18n.t("admin.ai.summary.active-providers"),
                value: (
                  <Badge
                    tone={enabledProviderCount > 0 ? "success" : "neutral"}
                  >
                    {enabledProviderCount}
                  </Badge>
                ),
              },
              {
                label: i18n.t("admin.ai.summary.default-provider"),
                value: defaultProvider ? (
                  <Badge tone={defaultProviderIsInactive ? "error" : "info"}>
                    {defaultProvider}
                  </Badge>
                ) : (
                  "-"
                ),
              },
            ]}
          />
        ) : undefined
      }
    >
      <PageConfigErrorBoundary>
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          layout="page"
          variant="default"
        >
          <AdminSubnav
            items={AI_TAB_IDS.map((value) => ({
              value,
              label: i18n.t(AI_TAB_LABEL_KEYS[value]),
              testId: `ai-tab-${value}`,
            }))}
          />
          <AdminPageScroll>
            <Stack>
              <TabsContent value="copilot" layout="stack">
                <FormFieldset variant="unstyled" disabled={copilotSaving}>
                  <Stack>
                    <Stack key={copilotVersionKey} component="section">
                      <SettingsHeadingGroup>
                        <SettingsSectionHeading level={3}>
                          {i18n.t("admin.ai.global.title")}
                        </SettingsSectionHeading>
                        <SettingsSectionDescription>
                          {i18n.t("admin.ai.global.description")}
                        </SettingsSectionDescription>
                      </SettingsHeadingGroup>
                      <ConfigBooleanField
                        field="copilot/enabled"
                        desc={i18n.t("admin.ai.global.enabled")}
                        defaultValue={masterEnabled}
                        onChange={update}
                        databaseWritable={
                          subFieldSchemaMap.copilot?.enabled?.databaseWritable
                        }
                        error={fieldErrorsByPath["copilot/enabled"]?.message}
                      />

                      {masterEnabled && noActiveProvider && (
                        <SettingsStatusText data-testid="no-active-provider-warning">
                          {i18n.t("admin.ai.global.no-active-provider")}
                        </SettingsStatusText>
                      )}

                      {defaultProviderIsInactive && (
                        <SettingsStatusText data-testid="default-provider-inactive-warning">
                          {i18n.t("admin.ai.global.default-provider-inactive", {
                            provider: defaultProvider,
                          })}
                        </SettingsStatusText>
                      )}

                      <SimpleGrid cols={2}>
                        {/* Default provider */}
                        <ConfigTextField
                          field="copilot/default_provider"
                          desc={i18n.t("admin.ai.global.defaultProvider")}
                          defaultValue={getByPath(
                            copilotCfg,
                            "default_provider",
                          )}
                          onChange={update}
                          error={
                            fieldErrorsByPath["copilot/default_provider"]
                              ?.message
                          }
                          onErrorChange={onFieldErrorChange}
                          databaseWritable={
                            subFieldSchemaMap.copilot?.default_provider
                              ?.databaseWritable
                          }
                        />

                        {/* Fallback providers preserve their server-owned order. */}
                        <ConfigArrayField
                          field="copilot/fallback_providers"
                          desc={i18n.t("admin.ai.global.fallback-providers")}
                          defaultValue={getByPath(
                            copilotCfg,
                            "fallback_providers",
                          )}
                          onChange={update}
                          error={
                            fieldErrorsByPath["copilot/fallback_providers"]
                              ?.message
                          }
                          onErrorChange={onFieldErrorChange}
                          databaseWritable={
                            subFieldSchemaMap.copilot?.fallback_providers
                              ?.databaseWritable
                          }
                        />
                      </SimpleGrid>
                      <Accordion
                        value={routingExpanded}
                        onChange={setRoutingExpanded}
                        keepMounted
                      >
                        <AccordionItem value="routing">
                          <AccordionControl data-testid="ai-routing-details">
                            {i18n.t("admin.ai.global.details")}
                          </AccordionControl>
                          <AccordionPanel>
                            <SimpleGrid cols={2}>
                              {/* Request timeout */}
                              <ConfigNumberField
                                field="copilot/request_timeout_ms"
                                desc={i18n.t(
                                  "admin.ai.global.requestTimeoutMs",
                                )}
                                suffix="ms"
                                min={
                                  subFieldSchemaMap.copilot?.request_timeout_ms
                                    ?.min ?? undefined
                                }
                                max={
                                  subFieldSchemaMap.copilot?.request_timeout_ms
                                    ?.max ?? undefined
                                }
                                defaultValue={getByPath(
                                  copilotCfg,
                                  "request_timeout_ms",
                                )}
                                onChange={update}
                                error={
                                  fieldErrorsByPath[
                                    "copilot/request_timeout_ms"
                                  ]?.message
                                }
                                onErrorChange={onFieldErrorChange}
                                databaseWritable={
                                  subFieldSchemaMap.copilot?.request_timeout_ms
                                    ?.databaseWritable
                                }
                              />
                            </SimpleGrid>
                          </AccordionPanel>
                        </AccordionItem>
                      </Accordion>
                    </Stack>

                    <Stack component="section">
                      <SettingsHeadingGroup>
                        <SettingsSectionHeading level={3}>
                          {i18n.t("admin.ai.provider.group.cloud")}
                        </SettingsSectionHeading>
                        <SettingsSectionDescription>
                          {i18n.t("admin.ai.provider.group.cloud.desc")}
                        </SettingsSectionDescription>
                      </SettingsHeadingGroup>
                      {providersReadOnly ? <YamlOnlyBanner /> : null}
                      {providerError ? (
                        <SettingsNotice tone="error">
                          {providerError}
                        </SettingsNotice>
                      ) : null}
                      <Stack
                        aria-label={i18n.t("admin.ai.provider.group.cloud")}
                      >
                        {cloudProviders.map((provider) => (
                          <CopilotProviderCard
                            key={provider.id}
                            providerId={provider.id}
                            providerName={provider.name}
                            isCustom={false}
                            module="copilot"
                            patchedAppConfig={patchedAppConfig}
                            onUpdate={update}
                            disabled={copilotSaving || providersReadOnly}
                            error={errorForProvider(provider.id)}
                            onErrorChange={onFieldErrorChange}
                            versionKey={copilotVersionKey}
                          />
                        ))}
                      </Stack>
                    </Stack>

                    <Stack component="section">
                      <SettingsHeadingGroup>
                        <SettingsSectionHeading level={3}>
                          {i18n.t("admin.ai.provider.group.local")}
                        </SettingsSectionHeading>
                        <SettingsSectionDescription>
                          {i18n.t("admin.ai.provider.group.local.desc")}
                        </SettingsSectionDescription>
                      </SettingsHeadingGroup>
                      <Stack
                        aria-label={i18n.t("admin.ai.provider.group.local")}
                      >
                        {localProviders.map((provider) => (
                          <CopilotProviderCard
                            key={provider.id}
                            providerId={provider.id}
                            providerName={provider.name}
                            isCustom={false}
                            module="copilot"
                            patchedAppConfig={patchedAppConfig}
                            onUpdate={update}
                            disabled={copilotSaving || providersReadOnly}
                            error={errorForProvider(provider.id)}
                            onErrorChange={onFieldErrorChange}
                            versionKey={copilotVersionKey}
                          />
                        ))}
                      </Stack>
                    </Stack>

                    <Stack component="section">
                      <Group justify="space-between" align="flex-start">
                        <SettingsHeadingGroup>
                          <SettingsSectionHeading level={3}>
                            {i18n.t("admin.ai.provider.group.custom")}
                          </SettingsSectionHeading>
                          <SettingsSectionDescription>
                            {i18n.t("admin.ai.provider.group.custom.desc")}
                          </SettingsSectionDescription>
                        </SettingsHeadingGroup>
                        {
                          <Button
                            type="button"
                            variant="secondary"
                            prefix={<PlusIcon aria-hidden="true" />}
                            onClick={() => setShowAddDialog(true)}
                            disabled={copilotSaving || providersReadOnly}
                            data-testid="add-custom-provider-btn"
                          >
                            {i18n.t("admin.ai.section.add-custom")}
                          </Button>
                        }
                      </Group>
                      {customProviderIds.length === 0 ? (
                        <SettingsStatusText>
                          {i18n.t("admin.ai.provider.group.custom.none")}
                        </SettingsStatusText>
                      ) : (
                        <Stack
                          aria-label={i18n.t("admin.ai.provider.group.custom")}
                        >
                          {customProviderIds.map((id) => (
                            <CopilotProviderCard
                              key={id}
                              providerId={id}
                              providerName={id}
                              isCustom
                              module="copilot"
                              patchedAppConfig={patchedAppConfig}
                              onUpdate={update}
                              onRemove={() => handleRemoveCustomProvider(id)}
                              disabled={copilotSaving || providersReadOnly}
                              error={errorForProvider(id)}
                              onErrorChange={onFieldErrorChange}
                              versionKey={copilotVersionKey}
                            />
                          ))}
                        </Stack>
                      )}
                    </Stack>

                    <Stack component="section">
                      <SettingsHeadingGroup>
                        <SettingsSectionHeading level={3}>
                          {i18n.t("admin.ai.section.embedding-api")}
                        </SettingsSectionHeading>
                        <SettingsSectionDescription>
                          {i18n.t("admin.ai.provider.embedding-description")}
                        </SettingsSectionDescription>
                      </SettingsHeadingGroup>
                      <Stack
                        aria-label={i18n.t("admin.ai.section.embedding-api")}
                      >
                        <EmbeddingSection
                          key={`embedding-${copilotVersionKey}`}
                          disabled={copilotSaving}
                          errors={embeddingErrors}
                          readOnlyFields={embeddingReadOnlyFields}
                          onErrorChange={onFieldErrorChange}
                          patchedAppConfig={patchedAppConfig}
                          onUpdate={update}
                          schemaFields={subFieldSchemaMap.copilot}
                        />
                      </Stack>
                    </Stack>

                    <Stack component="section">
                      <SettingsHeadingGroup>
                        <SettingsSectionHeading level={3}>
                          {i18n.t("admin.ai.section.storage")}
                        </SettingsSectionHeading>
                        <SettingsSectionDescription>
                          {i18n.t("admin.ai.section.storage.desc")}
                        </SettingsSectionDescription>
                      </SettingsHeadingGroup>
                      <CopilotStorageSection
                        key={`storage-${copilotVersionKey}`}
                        patchedAppConfig={patchedAppConfig}
                        onUpdate={update}
                        schemaField={subFieldSchemaMap.copilot?.storage_prefix}
                        error={
                          fieldErrorsByPath["copilot/storage_prefix"]?.message
                        }
                        onErrorChange={onFieldErrorChange}
                      />
                    </Stack>

                    <Accordion
                      value={externalExpanded}
                      onChange={setExternalExpanded}
                      keepMounted
                    >
                      <AccordionItem value="external">
                        <AccordionControl data-testid="ai-external-details">
                          {i18n.t("admin.ai.external.title")}
                        </AccordionControl>
                        <AccordionPanel>
                          <Stack>
                            <SettingsSectionDescription>
                              {i18n.t("admin.ai.external.description")}
                            </SettingsSectionDescription>
                            <PasswordSecretField
                              label={i18n.t("admin.ai.external.unsplash")}
                              fieldPath="copilot/unsplash/key"
                              description={i18n.t(
                                "admin.ai.external.unsplash-description",
                              )}
                              patchedAppConfig={patchedAppConfig}
                              onUpdate={update}
                              databaseWritable={
                                subFieldSchemaMap.copilot?.unsplash
                                  ?.databaseWritable
                              }
                              error={
                                fieldErrorsByPath["copilot/unsplash"]?.message
                              }
                            />
                            <PasswordSecretField
                              label={i18n.t("admin.ai.external.exa")}
                              fieldPath="copilot/exa/key"
                              description={i18n.t(
                                "admin.ai.external.exa-description",
                              )}
                              patchedAppConfig={patchedAppConfig}
                              onUpdate={update}
                              databaseWritable={
                                subFieldSchemaMap.copilot?.exa?.databaseWritable
                              }
                              error={fieldErrorsByPath["copilot/exa"]?.message}
                            />
                          </Stack>
                        </AccordionPanel>
                      </AccordionItem>
                    </Accordion>
                    {copilotDirty && fieldErrorsByPath["config/candidate"] ? (
                      <SettingsNotice tone="error">
                        {fieldErrorsByPath["config/candidate"].message}
                      </SettingsNotice>
                    ) : null}
                    <Group
                      justify="flex-end"
                      aria-label={i18n.t("admin.ai.copilot")}
                    >
                      {copilotDirty ? (
                        <Badge tone="warning">
                          {i18n.t("admin.state.unsaved-changes")}
                        </Badge>
                      ) : null}
                      <ConfigPageSaveButtons
                        dirty={copilotDirty}
                        hasFieldError={copilotHasErrors}
                        saving={copilotSaving}
                        onReset={handleCopilotReset}
                        onSave={() => {
                          handleCopilotSave().catch((error) => {
                            notify.error({
                              title: i18n.t("admin.common.save-failed"),
                              message:
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                            });
                          });
                        }}
                      />
                    </Group>
                  </Stack>
                </FormFieldset>
              </TabsContent>

              <TabsContent value="transcription" layout="stack">
                <TranscriptionTab
                  key={`transcription-${getGroupVersion("transcription")}`}
                  config={config}
                />
              </TabsContent>

              {SIMPLE_SECTIONS.map((section) => {
                const moduleKeys = section.modules.map((m) => m.module);
                const dirty = moduleKeys.some((m) => isGroupDirty(m));
                const saving = moduleKeys.some((m) => isGroupSaving(m));
                const hasErrors = hasFieldError(moduleKeys);
                const versionKey = moduleKeys
                  .map((m) => `${m}-${getGroupVersion(m)}`)
                  .join("_");

                const sectionYamlOnlyCount = section.modules.reduce(
                  (count, moduleDef) => {
                    const sfMap = buildSchemaFieldMap(schema, moduleDef.module);
                    return (
                      count +
                      moduleDef.fields.filter(
                        (f) => sfMap[f.key]?.databaseWritable === false,
                      ).length
                    );
                  },
                  0,
                );
                const showGroupYamlBanner = sectionYamlOnlyCount >= 2;

                const handleSave = async () => {
                  for (const m of moduleKeys) {
                    if (isGroupDirty(m)) {
                      await saveGroup(m);
                    }
                  }
                };

                const handleReset = () => {
                  for (const m of moduleKeys) {
                    if (isGroupDirty(m)) {
                      resetGroup(m);
                    }
                  }
                  for (const path of Object.keys(fieldErrors)) {
                    if (
                      moduleKeys.some((module) => path.startsWith(`${module}/`))
                    ) {
                      onFieldErrorChange(path);
                    }
                  }
                };

                return (
                  <TabsContent
                    key={section.module}
                    value={section.modules[0].module}
                    layout="stack"
                  >
                    <FormFieldset variant="unstyled" disabled={saving}>
                      <Stack component="section">
                        <SettingsHeadingGroup>
                          <SettingsSectionHeading level={3}>
                            {i18n.t(AI_TAB_LABEL_KEYS[section.module])}
                          </SettingsSectionHeading>
                          <SettingsSectionDescription>
                            {i18n.t(
                              AI_SECTION_DESCRIPTION_KEYS[section.module],
                            )}
                          </SettingsSectionDescription>
                        </SettingsHeadingGroup>
                        <Stack key={versionKey}>
                          {showGroupYamlBanner && <YamlOnlyBanner />}
                          {section.modules.map(({ module, fields }) => {
                            const field = fields.find(
                              (item) => item.key === "enabled",
                            );
                            return field ? (
                              <AiConfigField
                                key={`${module}/enabled`}
                                module={module}
                                field={field}
                                sourceConfig={
                                  patchedAppConfig[module] ?? appConfig[module]
                                }
                                schemaField={
                                  buildSchemaFieldMap(schema, module).enabled
                                }
                                showGroupYamlBanner={showGroupYamlBanner}
                                error={
                                  fieldErrorsByPath[`${module}/enabled`]
                                    ?.message
                                }
                                onErrorChange={onFieldErrorChange}
                                update={update}
                                saveField={saveField}
                              />
                            ) : null;
                          })}
                          {section.modules[0].module === "indexer" ? (
                            <Accordion
                              value={indexerExpanded}
                              onChange={setIndexerExpanded}
                              keepMounted
                            >
                              <AccordionItem value="indexer">
                                <AccordionControl data-testid="ai-indexer-details">
                                  {i18n.t("admin.common.details")}
                                </AccordionControl>
                                <AccordionPanel>
                                  <SimpleGrid cols={2}>
                                    {section.modules.map((moduleDef) => {
                                      const { module, fields } = moduleDef;
                                      const sourceConfig =
                                        patchedAppConfig[module] ??
                                        appConfig[module];
                                      const schemaFieldMap =
                                        buildSchemaFieldMap(schema, module);

                                      return fields
                                        .filter(
                                          (field) => field.key !== "enabled",
                                        )
                                        .map((field) => {
                                          const fieldPath = `${module}/${field.key}`;
                                          const schemaField =
                                            schemaFieldMap[field.key];

                                          return (
                                            <AiConfigField
                                              key={fieldPath}
                                              module={module}
                                              field={field}
                                              sourceConfig={sourceConfig}
                                              schemaField={schemaField}
                                              showGroupYamlBanner={
                                                showGroupYamlBanner
                                              }
                                              error={
                                                fieldErrorsByPath[fieldPath]
                                                  ?.message
                                              }
                                              onErrorChange={onFieldErrorChange}
                                              update={update}
                                              saveField={saveField}
                                            />
                                          );
                                        });
                                    })}

                                    {section.subFields?.map((sfGroup) => {
                                      const sourceConfig =
                                        patchedAppConfig[sfGroup.module] ??
                                        appConfig[sfGroup.module];

                                      return sfGroup.defs.map((sf) => {
                                        const fieldPath = `${sfGroup.module}/${sf.parentKey}/${sf.subKey}`;
                                        const sfSchemaField =
                                          subFieldSchemaMap[sfGroup.module]?.[
                                            sf.parentKey
                                          ];
                                        return (
                                          <AiSubConfigField
                                            key={fieldPath}
                                            module={sfGroup.module}
                                            field={sf}
                                            sourceConfig={sourceConfig}
                                            schemaField={sfSchemaField}
                                            showGroupYamlBanner={
                                              showGroupYamlBanner
                                            }
                                            error={
                                              fieldErrorsByPath[fieldPath]
                                                ?.message
                                            }
                                            onErrorChange={onFieldErrorChange}
                                            update={update}
                                          />
                                        );
                                      });
                                    })}
                                  </SimpleGrid>
                                </AccordionPanel>
                              </AccordionItem>
                            </Accordion>
                          ) : null}
                          <Group
                            justify="flex-end"
                            aria-label={i18n.t(
                              AI_TAB_LABEL_KEYS[section.module],
                            )}
                          >
                            {dirty ? (
                              <Badge tone="warning">
                                {i18n.t("admin.state.unsaved-changes")}
                              </Badge>
                            ) : null}
                            <ConfigPageSaveButtons
                              dirty={dirty}
                              hasFieldError={hasErrors}
                              saving={saving}
                              onReset={handleReset}
                              onSave={() => {
                                handleSave().catch((err) => {
                                  notify.error({
                                    title: i18n.t("admin.common.save-failed"),
                                    message: err?.message ?? String(err),
                                  });
                                });
                              }}
                            />
                          </Group>
                        </Stack>
                      </Stack>
                    </FormFieldset>
                  </TabsContent>
                );
              })}
            </Stack>
          </AdminPageScroll>
        </Tabs>
      </PageConfigErrorBoundary>

      {showAddDialog ? (
        <AddCustomProviderDialog
          existingIds={allExistingProviderIds}
          onAdd={handleAddCustomProvider}
          onClose={() => setShowAddDialog(false)}
        />
      ) : null}
    </AdminPageFrame>
  );
}

export { AiPage as Component };
