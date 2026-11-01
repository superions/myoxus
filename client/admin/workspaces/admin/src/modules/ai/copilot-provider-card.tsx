/**
 * CopilotProviderCard — native configuration disclosure for a single Copilot AI provider.
 *
 * Provider edits update one typed `copilot.providers` object. The settings hook
 * merges each provider sub-field into that object before the mutation is sent,
 * so the database never contains partial provider rows.
 *
 * Supported provider kinds:
 * - "openai"  → cloud API (requires api_key)
 * - "local"   → Ollama/vLLM (api_key optional)
 * - "custom"  → user-defined endpoint
 */
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  FormSelect,
  NumberInput,
  TagsInput,
  Button,
  Group,
  Input,
  PasswordInput,
  SettingsField,
  SettingsNotice,
  SettingsSwitchRow,
  Stack,
} from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

import type { AppConfig } from "../settings/config";

// ---------------------------------------------------------------------------
// CopilotProviderCard types
// ---------------------------------------------------------------------------

export type ProviderKind = "openai" | "local" | "custom";

type ReasoningControl =
  | { type: "enable_thinking" }
  | { type: "reasoning_effort"; on: string; off: string };
type ModelOptions = Record<
  string,
  { reasoning_control?: ReasoningControl; supports_vision?: boolean }
>;
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

export type CopilotProviderCardProps = {
  providerId: string;
  providerName: string;
  /** Whether this is a user-added custom provider (shows Remove button) */
  isCustom?: boolean;
  /** Config module — always "copilot". */
  module: string;
  patchedAppConfig: AppConfig;
  onUpdate: (field: string, value: any) => void;
  onRemove?: () => void;
  versionKey: number;
  disabled?: boolean;
  error?: string;
  onErrorChange?: (field: string, error?: string) => void;
};

function getProviderField(
  patchedAppConfig: AppConfig,
  module: string,
  providerId: string,
  subKey: string,
): any {
  const moduleConfig = patchedAppConfig[module] as any;
  return moduleConfig?.providers?.[providerId]?.[subKey];
}

/** Default endpoint URL per kind */
const KIND_DEFAULT_ENDPOINT: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  local: "http://localhost:11434/v1",
  custom: "",
};

const KIND_TONE: Record<ProviderKind, "info" | "success" | "warning"> = {
  openai: "info",
  local: "success",
  custom: "warning",
};

const KIND_LABEL_KEY = {
  openai: "admin.ai.provider.kind.openai",
  local: "admin.ai.provider.kind.local",
  custom: "admin.ai.provider.kind.custom",
} as const;

const KIND_LONG_LABEL_KEY = {
  openai: "admin.ai.provider.kind.openai.long",
  local: "admin.ai.provider.kind.local.long",
  custom: "admin.ai.provider.kind.custom.long",
} as const;

// ---------------------------------------------------------------------------
// CopilotProviderCard
// ---------------------------------------------------------------------------

export function CopilotProviderCard({
  providerId,
  providerName,
  isCustom = false,
  module,
  patchedAppConfig,
  onUpdate,
  onRemove,
  versionKey,
  disabled = false,
  error,
  onErrorChange,
}: CopilotProviderCardProps) {
  const i18n = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [kindChangeWarning, setKindChangeWarning] =
    useState<ProviderKind | null>(null);

  // Field paths within the copilot module
  const enabledPath = `${module}/providers/${providerId}.enabled`;
  const apiKeyPath = `${module}/providers/${providerId}.api_key`;
  const endpointPath = `${module}/providers/${providerId}.endpoint`;
  const timeoutMsPath = `${module}/providers/${providerId}.timeout_ms`;
  const kindPath = `${module}/providers/${providerId}.kind`;

  // Current values from patched config
  const enabled = Boolean(
    getProviderField(patchedAppConfig, module, providerId, "enabled"),
  );
  const apiKey = (getProviderField(
    patchedAppConfig,
    module,
    providerId,
    "api_key",
  ) ?? "") as string;
  const endpoint = (getProviderField(
    patchedAppConfig,
    module,
    providerId,
    "endpoint",
  ) ?? "") as string;
  const models = (getProviderField(
    patchedAppConfig,
    module,
    providerId,
    "models",
  ) ?? []) as string[];
  const modelOptions = (getProviderField(
    patchedAppConfig,
    module,
    providerId,
    "model_options",
  ) ?? {}) as ModelOptions;
  // Model IDs may contain dots/slashes. Submit their containing object, never
  // splice those literal keys into the settings hook's dotted field paths.
  const updateProvider = (patch: Record<string, unknown>) => {
    const providers = (patchedAppConfig[module] as any)?.providers ?? {};
    onUpdate(`${module}/providers`, {
      ...providers,
      [providerId]: { ...providers[providerId], ...patch },
    });
  };
  const updateReasoningControl = (
    model: string,
    control?: ReasoningControl,
  ) => {
    const next = { ...modelOptions };
    const entry = { ...next[model], reasoning_control: control };
    if (control || entry.supports_vision) next[model] = entry;
    else delete next[model];
    updateProvider({ model_options: next });
  };
  const timeoutMs = (getProviderField(
    patchedAppConfig,
    module,
    providerId,
    "timeout_ms",
  ) ?? 30000) as number;
  const kind = (getProviderField(
    patchedAppConfig,
    module,
    providerId,
    "kind",
  ) ?? "openai") as ProviderKind | "open-ai";

  // The config hook owns provider drafts; disclosure lifecycle cannot discard them.
  const localEnabled = enabled;
  const localApiKey = apiKey;
  const localEndpoint = endpoint;
  const localModels = models;
  const localKind = kind === "open-ai" ? "openai" : kind;
  const [localTimeoutMs, setLocalTimeoutMs] = useState<string | number>(
    timeoutMs,
  );
  const [timeoutError, setTimeoutError] = useState<string>();
  const [numberSource, setNumberSource] = useState({ timeoutMs, versionKey });
  // Render-time adoption survives React Activity reconnects. Effects must not
  // reset an invalid numeric draft simply because a page tab becomes visible.
  if (
    numberSource.timeoutMs !== timeoutMs ||
    numberSource.versionKey !== versionKey
  ) {
    setNumberSource({ timeoutMs, versionKey });
    setLocalTimeoutMs(timeoutMs);
    setTimeoutError(undefined);
  }
  useEffect(() => {
    setKindChangeWarning(null);
  }, [versionKey]);
  useEffect(() => {
    onErrorChange?.(timeoutMsPath, timeoutError);
  }, [timeoutMsPath, timeoutError, onErrorChange]);
  useEffect(() => {
    if (error) setExpanded(true);
  }, [error]);

  const handleEnabledChange = (checked: boolean) =>
    onUpdate(enabledPath, checked);
  const handleApiKeyChange = (value: string) => onUpdate(apiKeyPath, value);
  const handleEndpointChange = (value: string) => onUpdate(endpointPath, value);
  const handleModelsChange = (value: string[]) =>
    updateProvider({
      models: value,
      model_options: Object.fromEntries(
        Object.entries(modelOptions).filter(([model]) => value.includes(model)),
      ),
    });
  const handleTimeoutMsChange = (value: string | number) => {
    setLocalTimeoutMs(value);
    const valid =
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 600000;
    const nextError = valid
      ? undefined
      : i18n.t("admin.config.validation.integer-range", {
          min: "100",
          max: "600000",
        });
    setTimeoutError(nextError);
    if (valid) onUpdate(timeoutMsPath, value);
  };

  const handleKindSelect = (newKind: ProviderKind) => {
    if (newKind === localKind) return;
    // If endpoint is already configured, warn before resetting
    if (localEndpoint.trim().length > 0) {
      setKindChangeWarning(newKind);
      return;
    }
    applyKindChange(newKind);
  };

  const applyKindChange = (newKind: ProviderKind) => {
    onUpdate(kindPath, newKind);
    const defaultEndpoint = KIND_DEFAULT_ENDPOINT[newKind];
    onUpdate(endpointPath, defaultEndpoint);
    setKindChangeWarning(null);
  };

  const dismissKindWarning = () => setKindChangeWarning(null);

  const kindLabel = (target: ProviderKind) => i18n.t(KIND_LABEL_KEY[target]);
  const kindLongLabel = (target: ProviderKind) =>
    i18n.t(KIND_LONG_LABEL_KEY[target]);

  return (
    <Accordion
      value={expanded ? providerId : null}
      onChange={(value) => setExpanded(Boolean(value))}
      keepMounted={false}
    >
      <AccordionItem
        value={providerId}
        data-testid={`provider-card-${providerId}`}
      >
        <AccordionControl>
          <Group justify="space-between">
            {providerName}
            <Group>
              <Badge
                tone={KIND_TONE[localKind]}
                data-testid={`provider-kind-badge-${providerId}`}
              >
                {kindLabel(localKind)}
              </Badge>
              <Badge
                tone={localEnabled ? "success" : "neutral"}
                data-testid={`provider-badge-${providerId}`}
              >
                {localEnabled
                  ? i18n.t("admin.ai.provider.field.enabled")
                  : i18n.t("admin.common.disabled")}
              </Badge>
            </Group>
          </Group>
        </AccordionControl>
        <AccordionPanel>
          <Stack>
            {error ? (
              <SettingsNotice tone="error">{error}</SettingsNotice>
            ) : null}
            <SettingsSwitchRow
              label={i18n.t("admin.ai.provider.field.enabled")}
              checked={localEnabled}
              onChange={handleEnabledChange}
              testId={`switch-${providerId}-enabled`}
              disabled={disabled}
            />

            <SettingsField
              label={i18n.t("admin.ai.provider.field.kind")}
              labelFor={`${providerId}-kind`}
              disabled={disabled || !localEnabled}
            >
              <FormSelect
                id={`${providerId}-kind`}
                aria-label={i18n.t("admin.ai.provider.field.kind")}
                value={localKind}
                onChange={(value) => handleKindSelect(value as ProviderKind)}
                disabled={disabled || !localEnabled}
                data={(Object.keys(KIND_TONE) as ProviderKind[]).map(
                  (providerKind) => ({
                    value: providerKind,
                    label: kindLongLabel(providerKind),
                  }),
                )}
                data-testid={`kind-select-${providerId}`}
              />
            </SettingsField>

            {kindChangeWarning ? (
              <SettingsNotice
                tone="warning"
                data-testid={`kind-change-warning-${providerId}`}
                title={i18n.t("admin.ai.provider.kind-change-warning", {
                  kind: kindLongLabel(kindChangeWarning),
                })}
              >
                <Group>
                  <Button
                    type="button"
                    disabled={disabled}
                    onClick={() => applyKindChange(kindChangeWarning)}
                  >
                    {i18n.t("admin.common.confirm")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={dismissKindWarning}
                  >
                    {i18n.t("admin.common.cancel")}
                  </Button>
                </Group>
              </SettingsNotice>
            ) : null}

            <SettingsField
              label={i18n.t("admin.ai.provider.field.endpoint")}
              labelFor={`${providerId}-endpoint`}
              disabled={disabled || !localEnabled}
            >
              <Input
                id={`${providerId}-endpoint`}
                data-testid={`input-${providerId}-endpoint`}
                value={localEndpoint}
                onChange={handleEndpointChange}
                placeholder={
                  KIND_DEFAULT_ENDPOINT[localKind] ||
                  i18n.t("admin.ai.provider.endpoint-placeholder")
                }
                disabled={disabled || !localEnabled}
              />
            </SettingsField>

            <SettingsField
              label={i18n.t("admin.ai.provider.field.apiKey")}
              labelFor={`${providerId}-apiKey`}
              description={
                localKind === "local"
                  ? i18n.t("admin.ai.provider.field.apiKey.optional-local")
                  : i18n.t("admin.ai.provider.env-prefix-hint")
              }
              disabled={disabled || !localEnabled}
            >
              <Group>
                <Badge tone={apiKey.trim() ? "info" : "neutral"}>
                  {apiKey.trim()
                    ? i18n.t("admin.ai.provider.configured")
                    : i18n.t("admin.ai.provider.not-configured")}
                </Badge>
              </Group>
              <PasswordInput
                autoComplete="new-password"
                id={`${providerId}-apiKey`}
                value={localApiKey}
                onChange={handleApiKeyChange}
                placeholder={i18n.t("admin.ai.provider.api-key-placeholder")}
                disabled={disabled || !localEnabled}
              />
            </SettingsField>

            <SettingsField
              label={i18n.t("admin.ai.provider.field.model")}
              labelFor={`${providerId}-models`}
              description={i18n.t("admin.ai.provider.models-hint")}
              disabled={disabled || !localEnabled}
            >
              <TagsInput
                id={`${providerId}-models`}
                acceptValueOnBlur={false}
                isDuplicate={(value, currentValues) =>
                  currentValues.includes(value)
                }
                aria-label={i18n.t("admin.ai.provider.field.model")}
                data-testid={`model-input-${providerId}-models`}
                removeLabel={(model) =>
                  i18n.t("admin.ai.provider.model-remove", { model })
                }
                placeholder={i18n.t(
                  "admin.ai.provider.model-input-placeholder",
                )}
                value={localModels}
                onChange={handleModelsChange}
                disabled={disabled || !localEnabled}
              />
            </SettingsField>

            {localModels.map((model) => {
              const control = modelOptions[model]?.reasoning_control;
              return (
                <Stack key={model} data-reasoning-model={model}>
                  <SettingsSwitchRow
                    label={i18n.t("admin.ai.provider.supports-vision", {
                      model,
                    })}
                    checked={modelOptions[model]?.supports_vision === true}
                    disabled={disabled || !localEnabled}
                    onChange={(supports_vision) => {
                      const next = { ...modelOptions };
                      const entry = { ...next[model], supports_vision };
                      if (supports_vision || entry.reasoning_control)
                        next[model] = entry;
                      else delete next[model];
                      updateProvider({ model_options: next });
                    }}
                  />
                  <SettingsField
                    label={i18n.t("admin.ai.provider.reasoning-control", {
                      model,
                    })}
                    description={i18n.t("admin.ai.provider.reasoning-hint")}
                  >
                    <FormSelect
                      aria-label={i18n.t(
                        "admin.ai.provider.reasoning-control",
                        { model },
                      )}
                      value={control?.type ?? "default"}
                      data={[
                        {
                          value: "default",
                          label: i18n.t("admin.ai.provider.reasoning-default"),
                        },
                        {
                          value: "enable_thinking",
                          label: "vLLM enable_thinking",
                        },
                        {
                          value: "reasoning_effort",
                          label: "reasoning_effort",
                        },
                      ]}
                      disabled={disabled || !localEnabled}
                      onChange={(value) =>
                        updateReasoningControl(
                          model,
                          value === "enable_thinking"
                            ? { type: "enable_thinking" }
                            : value === "reasoning_effort"
                              ? { type: "reasoning_effort", on: "", off: "" }
                              : undefined,
                        )
                      }
                    />
                  </SettingsField>
                  {control?.type === "reasoning_effort" ? (
                    <>
                      <SettingsField
                        label={i18n.t("admin.ai.provider.reasoning-on")}
                      >
                        <FormSelect
                          aria-label={i18n.t("admin.ai.provider.reasoning-on")}
                          value={control.on || null}
                          data={REASONING_EFFORTS.map((value) => ({
                            value,
                            label: value,
                          }))}
                          disabled={disabled || !localEnabled}
                          onChange={(value) =>
                            updateReasoningControl(model, {
                              ...control,
                              on: value ?? "",
                            })
                          }
                        />
                      </SettingsField>
                      <SettingsField
                        label={i18n.t("admin.ai.provider.reasoning-off")}
                      >
                        <FormSelect
                          aria-label={i18n.t("admin.ai.provider.reasoning-off")}
                          value={control.off || null}
                          data={REASONING_EFFORTS.map((value) => ({
                            value,
                            label: value,
                          }))}
                          disabled={disabled || !localEnabled}
                          onChange={(value) =>
                            updateReasoningControl(model, {
                              ...control,
                              off: value ?? "",
                            })
                          }
                        />
                      </SettingsField>
                    </>
                  ) : null}
                </Stack>
              );
            })}

            <SettingsField
              label={i18n.t("admin.ai.provider.field.timeout")}
              labelFor={`${providerId}-timeoutMs`}
              description={
                localKind === "local"
                  ? i18n.t("admin.ai.provider.timeout-hint-local")
                  : undefined
              }
              disabled={disabled || !localEnabled}
            >
              <NumberInput
                id={`${providerId}-timeoutMs`}
                data-testid={`input-${providerId}-timeoutMs`}
                min={100}
                max={600000}
                allowDecimal={false}
                error={timeoutError}
                step={1000}
                value={localTimeoutMs}
                onChange={handleTimeoutMsChange}
                suffix=" ms"
                placeholder={i18n.t("admin.ai.provider.timeout-placeholder")}
                disabled={disabled || !localEnabled}
              />
            </SettingsField>

            {isCustom && onRemove ? (
              <Group justify="flex-start">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={disabled}
                  onClick={onRemove}
                  data-testid={`remove-provider-${providerId}`}
                >
                  {i18n.t("admin.ai.provider.remove")}
                </Button>
              </Group>
            ) : null}
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
