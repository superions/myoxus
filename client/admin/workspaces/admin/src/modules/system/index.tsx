// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * System page.
 *
 * Consolidates the system-level runtime and config surfaces into the
 * P-AR-3 tab model:
 * Overview, Mail, Telemetry, Metrics, Localization, Frontend and Logging.
 *
 * Rationale: every real server module must stay reachable from the admin GUI so
 * operators can enable/disable the feature explicitly — see LRN-20260316-133
 * ("disabled features always visible"). Captcha and CORS deliberately moved to
 * Security; this page keeps only system/runtime ownership.
 */
import {
  type Language,
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGE_LABEL_KEYS,
  useI18n,
} from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Button,
  notify,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsToolbar,
  SimpleGrid,
  Stack,
  StatCell,
  StatGrid,
  Tabs,
  TabsContent,
} from "@myoxus/ui-facade";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";

import {
  fetchSystemHealth,
  type HealthSnapshot,
} from "../../api/runtime-status-api";
import { PageConfigErrorBoundary } from "../../components/page-config-error-boundary";
import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useServerConfig } from "../common";
import { ALL_CONFIG_DESCRIPTORS, type AppConfig } from "../settings/config";
import {
  ConfigArrayField,
  ConfigBooleanField,
  type ConfigControlType,
  ConfigJsonField,
  ConfigMultiSelectField,
  ConfigNumberField,
  ConfigSelectField,
  ConfigTextField,
  YamlOnlyBanner,
} from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import { SendTestEmail } from "../settings/operations/send-test-email";
import {
  type AdminConfigSchemaField,
  buildSchemaFieldMap,
} from "../settings/schema-utils";
import { useAppConfig } from "../settings/use-app-config";
import { useFieldErrors } from "../settings/use-field-errors";
import { getByPath } from "../settings/utils";
import { MetricsCategoriesGrid } from "./metrics-categories";
import { MetricsLiveStats } from "./metrics-live-stats";
import { SystemLoggingTab } from "./tabs/logging";
import { TelemetryCategoriesGrid } from "./telemetry-categories";
import { TelemetryLiveStats } from "./telemetry-live-stats";

// ---------------------------------------------------------------------------
// Section definitions
// ---------------------------------------------------------------------------

type FieldDef = {
  key: string;
  type?: ConfigControlType;
  label?: string;
  desc?: string;
  suffix?: string;
  options?: string[];
  labels?: Record<string, string>;
  min?: number;
  max?: number;
};

const WEB_FRONTEND_LOCALE_OPTIONS = [...SUPPORTED_LANGUAGE_CODES];
const SHARED_LOCALE_LABELS: Record<string, string> = {
  ...SUPPORTED_LANGUAGE_LABEL_KEYS,
};

const ADMIN_FRONTEND_LOCALE_OPTIONS = [
  "en",
  "de",
  "fr",
  "es",
] satisfies Language[];
const DATABASE_DEFAULT_CURRENCY_OPTIONS = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "CAD",
  "AUD",
  "JPY",
];
const SMTP_TRANSPORT_OPTIONS = ["starttls", "implicit_tls", "plain"];
const SMTP_TRANSPORT_LABELS = {
  starttls: "admin.configWizard.smtp.transport.option.starttls",
  implicit_tls: "admin.configWizard.smtp.transport.option.implicit_tls",
  plain: "admin.configWizard.smtp.transport.option.plain",
};

type SystemConfigFieldProps = {
  module: string;
  field: FieldDef;
  sourceConfig: Record<string, unknown> | undefined;
  schemaField?: AdminConfigSchemaField | null;
  descriptor:
    | {
        desc?: string;
        suffix?: string;
      }
    | undefined;
  showGroupYamlBanner: boolean;
  error?: string;
  onErrorChange: (field: string, error?: string) => void;
  update: (path: string, value: unknown) => void;
  saveField: (field: string, value: unknown) => Promise<void>;
};

function SystemConfigField({
  module,
  field,
  sourceConfig,
  schemaField,
  descriptor,
  showGroupYamlBanner,
  error,
  onErrorChange,
  update,
  saveField,
}: SystemConfigFieldProps) {
  const fieldPath = `${module}/${field.key}`;
  const type = (field.type ??
    schemaField?.valueType ??
    "String") as ConfigControlType;
  const commonProps = {
    field: fieldPath,
    label: field.label,
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
        suffix={field.suffix ?? descriptor?.suffix}
        min={field.min ?? schemaField?.min ?? undefined}
        max={field.max ?? schemaField?.max ?? undefined}
      />
    );
  }
  if (type === "Enum") {
    return (
      <ConfigSelectField
        {...commonProps}
        options={field.options ?? []}
        labels={field.labels}
      />
    );
  }
  if (type === "Array" && field.options?.length) {
    return (
      <ConfigMultiSelectField
        {...commonProps}
        options={field.options}
        labels={field.labels}
      />
    );
  }
  if (type === "Array") {
    return <ConfigArrayField {...commonProps} />;
  }
  if (type === "JSON") {
    return <ConfigJsonField {...commonProps} />;
  }
  if (type === "Color") {
    return <ConfigTextField {...commonProps} />;
  }
  return <ConfigTextField {...commonProps} sensitive={sensitive} />;
}

type ModuleDef = {
  module: string;
  fields: FieldDef[];
  headingKey?: string;
  descriptionKey?: string;
};

type SystemSection = {
  id:
    | "overview"
    | "mail"
    | "telemetry"
    | "metrics"
    | "localization"
    | "frontend"
    | "logging";
  titleKey: string;
  modules: ModuleDef[];
  operations?: ComponentType<{ appConfig: AppConfig }>[];
  /**
   * Optional i18n key for a 1-2 sentence section-level explainer rendered at
   * the top of the tab, above all config fields. Use when the section name
   * alone is ambiguous (e.g. "Telemetry" vs "Metrics") and readers benefit
   * from a short orientation before the config grid.
   */
  explainerKey?: string;
  /** Optional custom content rendered before config rows. */
  renderContent?: () => ReactNode;
  /**
   * Optional extra content rendered **after** the module field rows and
   * **before** the Save/Cancel buttons.  Used by sections that need editors
   * for config types the generic `config form field` cannot handle (e.g. Object-typed
   * telemetry categories / sampling rates — P-Telemetry-E).
   */
  renderExtras?: (ctx: {
    appConfig: AppConfig;
    patchedAppConfig: AppConfig;
    update: (path: string, value: unknown) => void;
  }) => ReactNode;
  /**
   * Standalone tabs own their own data loading and save semantics. They are
   * still mounted inside System's tab shell, but bypass the generic config
   * field renderer to avoid fake Save/Cancel controls for GraphQL-backed UIs.
   */
  renderStandaloneContent?: () => ReactNode;
};

function formatDuration(totalSeconds?: number) {
  if (typeof totalSeconds !== "number") return "—";
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function useSystemHealth() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchSystemHealth()
      .then((payload) => {
        if (!cancelled && payload && typeof payload === "object") {
          setHealth(payload as HealthSnapshot);
        }
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return health;
}

function SystemOverviewSnapshot({
  serverInfo,
  uptimeSeconds,
}: {
  serverInfo: {
    version?: string;
    name?: string;
    baseUrl?: string;
    deploymentType?: string;
  };
  uptimeSeconds?: number;
}) {
  const i18n = useI18n();
  const deploymentType =
    serverInfo.deploymentType === undefined
      ? "—"
      : formatDeploymentType(serverInfo.deploymentType, i18n);
  const facts = [
    {
      label: i18n.t("admin.system.overview.server-version"),
      value: serverInfo.version ?? "—",
    },
    {
      label: i18n.t("admin.system.overview.server-name"),
      value: serverInfo.name ?? "—",
    },
    {
      label: i18n.t("admin.system.overview.deployment"),
      value: deploymentType,
    },
    {
      label: i18n.t("admin.system.overview.base-url"),
      value: serverInfo.baseUrl ?? "—",
    },
    {
      label: i18n.t("admin.system.overview.app-build"),
      value: `${BUILD_CONFIG.appVersion} (${BUILD_CONFIG.appBuildType})`,
    },
    {
      label: i18n.t("admin.system.overview.editor-version"),
      value: BUILD_CONFIG.editorVersion,
    },
    {
      label: i18n.t("admin.system.overview.uptime"),
      value: formatDuration(uptimeSeconds),
    },
  ];

  return (
    <StatGrid data-testid="system-overview-snapshot">
      {facts.map((fact) => (
        <StatCell key={fact.label} label={fact.label} value={fact.value} />
      ))}
    </StatGrid>
  );
}

function formatDeploymentType(
  deploymentType: string,
  i18n: ReturnType<typeof useI18n>,
) {
  const normalized = deploymentType.toLowerCase();
  if (normalized === "standalone") {
    return i18n.t("admin.system.field.deployment-type.option.standalone");
  }
  if (normalized === "cloud") {
    return i18n.t("admin.system.field.deployment-type.option.cloud");
  }
  return deploymentType;
}

function SmtpCredentialActions({
  patchedAppConfig,
  update,
}: {
  patchedAppConfig: AppConfig;
  update: (path: string, value: unknown) => void;
}) {
  const i18n = useI18n();
  const mail = patchedAppConfig.mail ?? {};
  const hasPrimaryCredentials = Boolean(
    getByPath(mail, "smtp_user") || getByPath(mail, "smtp_pass"),
  );
  const hasFallbackCredentials = Boolean(
    getByPath(mail, "fallback_smtp.username") ||
    getByPath(mail, "fallback_smtp.password"),
  );
  if (!hasPrimaryCredentials && !hasFallbackCredentials) return null;

  return (
    <SettingsToolbar justify="flex-start">
      {hasPrimaryCredentials ? (
        <Button
          variant="outline"
          data-testid="clear-primary-smtp-credentials"
          onClick={() => {
            update("mail/smtp_user", null);
            update("mail/smtp_pass", null);
          }}
        >
          {i18n.t("admin.system.mail.clearPrimaryCredentials")}
        </Button>
      ) : null}
      {hasFallbackCredentials ? (
        <Button
          variant="outline"
          data-testid="clear-fallback-smtp-credentials"
          onClick={() => {
            update("mail/fallback_smtp.username", null);
            update("mail/fallback_smtp.password", null);
          }}
        >
          {i18n.t("admin.system.mail.clearFallbackCredentials")}
        </Button>
      ) : null}
    </SettingsToolbar>
  );
}

const SECTIONS: SystemSection[] = [
  {
    id: "overview",
    titleKey: "admin.system.overview.title",
    modules: [
      {
        module: "server",
        fields: [
          {
            key: "name",
            label: "admin.system.overview.server-name",
          },
          {
            key: "deployment_type",
            type: "Enum" as const,
            label: "admin.system.overview.deployment",
            options: ["standalone", "cloud"],
            labels: {
              standalone:
                "admin.system.field.deployment-type.option.standalone",
              cloud: "admin.system.field.deployment-type.option.cloud",
            },
            desc: "admin.system.field.deployment-type.desc",
          },
          {
            key: "origin",
            label: "admin.system.overview.base-url",
          },
          { key: "host" },
          { key: "port", type: "Number", min: 1, max: 65535 },
        ],
      },
      {
        module: "crypto",
        fields: [{ key: "private_key" }],
      },
      {
        module: "flags",
        fields: [{ key: "allow_guest_demo_workspace" }],
      },
    ],
  },
  {
    id: "mail",
    titleKey: "admin.system.mail",
    modules: [
      {
        module: "mail",
        headingKey: "admin.system.mail.primary.title",
        descriptionKey: "admin.system.mail.primary.description",
        fields: [
          {
            key: "smtp_host",
            label: "admin.system.mail.field.host",
          },
          {
            key: "smtp_port",
            label: "admin.system.mail.field.port",
          },
          {
            key: "smtp_transport",
            type: "Enum",
            label: "admin.system.mail.field.transport",
            options: SMTP_TRANSPORT_OPTIONS,
            labels: SMTP_TRANSPORT_LABELS,
          },
          {
            key: "smtp_verify_certificate",
            type: "Boolean",
            label: "admin.system.mail.field.verifyCertificate",
          },
          {
            key: "smtp_name",
            label: "admin.system.mail.field.heloHostname",
          },
          {
            key: "sender",
            label: "admin.system.mail.field.sender",
          },
          {
            key: "smtp_user",
            label: "admin.system.mail.field.usernameOptional",
          },
          {
            key: "smtp_pass",
            label: "admin.system.mail.field.passwordOptional",
          },
        ],
      },
      {
        module: "mail",
        headingKey: "admin.system.mail.fallback.title",
        descriptionKey: "admin.system.mail.fallback.description",
        fields: [
          {
            key: "fallback_domains",
            label: "admin.system.mail.field.fallbackDomains",
          },
          {
            key: "fallback_smtp.host",
            label: "admin.system.mail.field.host",
          },
          {
            key: "fallback_smtp.port",
            type: "Number",
            min: 1,
            max: 65535,
            label: "admin.system.mail.field.port",
          },
          {
            key: "fallback_smtp.transport",
            type: "Enum",
            label: "admin.system.mail.field.transport",
            options: SMTP_TRANSPORT_OPTIONS,
            labels: SMTP_TRANSPORT_LABELS,
          },
          {
            key: "fallback_smtp.verify_certificate",
            type: "Boolean",
            label: "admin.system.mail.field.verifyCertificate",
          },
          {
            key: "fallback_smtp.name",
            label: "admin.system.mail.field.heloHostname",
          },
          {
            key: "fallback_smtp.sender",
            label: "admin.system.mail.field.sender",
          },
          {
            key: "fallback_smtp.username",
            label: "admin.system.mail.field.usernameOptional",
          },
          {
            key: "fallback_smtp.password",
            label: "admin.system.mail.field.passwordOptional",
          },
        ],
      },
    ],
    operations: [SendTestEmail],
    renderExtras: ({ patchedAppConfig, update }) => (
      <SmtpCredentialActions
        patchedAppConfig={patchedAppConfig}
        update={update}
      />
    ),
  },
  {
    id: "telemetry",
    titleKey: "admin.system.telemetry",
    explainerKey: "admin.system.telemetry.explainer",
    modules: [
      {
        module: "telemetry",
        fields: [
          {
            key: "enabled",
            type: "Boolean",
            label: "admin.config.telemetry.enabled.label",
          },
          {
            key: "allowed_origins",
            type: "Array",
            label: "admin.config.telemetry.allowedOrigins.label",
          },
          {
            key: "dedupe_ttl_hours",
            type: "Number",
            label: "admin.config.telemetry.dedupe.ttlHours.label",
            suffix: "h",
            min: 1,
          },
          {
            key: "dedupe_max_entries",
            type: "Number",
            label: "admin.config.telemetry.dedupe.maxEntries.label",
            min: 1,
          },
          {
            key: "batch_max_events",
            type: "Number",
            label: "admin.config.telemetry.batch.maxEvents.label",
            min: 1,
          },
          {
            key: "flush_interval_seconds",
            type: "Number",
            label: "admin.config.telemetry.flushIntervalSeconds.label",
            suffix: "s",
            min: 1,
          },
          {
            key: "retention_raw_days",
            type: "Number",
            label: "admin.config.telemetry.retention.rawDays.label",
            suffix: "d",
            min: 1,
          },
          {
            key: "retention_daily_days",
            type: "Number",
            label: "admin.config.telemetry.retention.dailyDays.label",
            suffix: "d",
            min: 1,
          },
          {
            key: "ingest_rate_limit_per_ip_per_min",
            type: "Number",
            label: "admin.config.telemetry.ingestRateLimitPerIpPerMin.label",
            min: 1,
          },
        ],
      },
    ],
    renderExtras: ({ patchedAppConfig, update }) => (
      <>
        <TelemetryCategoriesGrid
          patchedAppConfig={patchedAppConfig}
          update={update}
        />
        <TelemetryLiveStats />
      </>
    ),
  },
  {
    id: "metrics",
    titleKey: "admin.system.metrics",
    explainerKey: "admin.system.metrics.explainer",
    modules: [
      {
        module: "metrics",
        fields: [
          {
            key: "enabled",
            type: "Boolean",
            label: "admin.config.metrics.enabled.label",
          },
          {
            key: "prometheus_enabled",
            type: "Boolean",
            label: "admin.config.metrics.prometheusEnabled.label",
          },
          {
            key: "persistence_enabled",
            type: "Boolean",
            label: "admin.config.metrics.persistenceEnabled.label",
          },
          {
            key: "flush_interval_seconds",
            type: "Number",
            label: "admin.config.metrics.flushIntervalSeconds.label",
            suffix: "s",
            min: 1,
          },
          {
            key: "retention_raw_days",
            type: "Number",
            label: "admin.config.metrics.retentionRawDays.label",
            suffix: "d",
            min: 1,
          },
          {
            key: "retention_daily_days",
            type: "Number",
            label: "admin.config.metrics.retentionDailyDays.label",
            suffix: "d",
            min: 1,
          },
          {
            key: "label_workspace_id_enabled",
            type: "Boolean",
            label: "admin.config.metrics.labelWorkspaceIdEnabled.label",
          },
          {
            key: "cardinality_limit_per_metric",
            type: "Number",
            label: "admin.config.metrics.cardinalityLimitPerMetric.label",
            min: 1,
          },
        ],
      },
    ],
    renderExtras: ({ patchedAppConfig, update }) => (
      <>
        <MetricsCategoriesGrid
          patchedAppConfig={patchedAppConfig}
          update={update}
        />
        <MetricsLiveStats />
      </>
    ),
  },
  {
    id: "localization",
    titleKey: "admin.system.localization.title",
    modules: [
      {
        module: "i18n",
        fields: [
          {
            key: "default_locale",
            type: "Enum" as const,
            options: WEB_FRONTEND_LOCALE_OPTIONS,
            labels: SHARED_LOCALE_LABELS,
            desc: "admin.system.locale.web-default-locale",
          },
          {
            key: "available_locales",
            type: "Array" as const,
            options: WEB_FRONTEND_LOCALE_OPTIONS,
            labels: SHARED_LOCALE_LABELS,
          },
          {
            key: "default_currency",
            type: "Enum" as const,
            options: DATABASE_DEFAULT_CURRENCY_OPTIONS,
            label: "admin.system.locale.default-currency",
            desc: "admin.system.locale.default-currency-desc",
          },
        ],
      },
      {
        module: "admin_i18n",
        fields: [
          {
            key: "default_locale",
            type: "Enum" as const,
            options: ADMIN_FRONTEND_LOCALE_OPTIONS,
            labels: SHARED_LOCALE_LABELS,
            desc: "admin.system.locale.admin-default-locale",
          },
        ],
      },
      {
        module: "journal",
        fields: [
          { key: "show_calendar_weeks" },
          {
            key: "first_day_of_week",
            type: "Enum",
            options: ["monday", "sunday"],
            labels: {
              monday: "com.myoxus.common.week.monday",
              sunday: "com.myoxus.common.week.sunday",
            },
            desc: "com.myoxus.common.week.first-day.desc",
          },
        ],
      },
      {
        module: "calendar",
        fields: [{ key: "google" }, { key: "caldav" }],
      },
    ],
  },
  {
    id: "frontend",
    titleKey: "admin.system.frontend.title",
    modules: [
      {
        module: "client",
        fields: [
          {
            key: "download_url",
            type: "String",
            desc: "admin.system.field.download-url.desc",
          },
          { key: "version_control.enabled" },
          { key: "version_control.required_version" },
          { key: "clipboard_http_fallback" },
        ],
      },
    ],
  },
  {
    id: "logging",
    titleKey: "admin.logging.title",
    explainerKey: "admin.system.logging.explainer",
    modules: [],
    renderStandaloneContent: () => <SystemLoggingTab />,
  },
];

const SYSTEM_TAB_IDS = new Set(SECTIONS.map((section) => section.id));

function resolveSystemTabId(raw: string | null): SystemSection["id"] {
  return SYSTEM_TAB_IDS.has(raw as SystemSection["id"])
    ? (raw as SystemSection["id"])
    : "overview";
}

function updateCurrentSearchTab(tab: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function SystemPage() {
  const i18n = useI18n();
  const initialTab = resolveSystemTabId(
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("tab"),
  );
  const [activeTab, setActiveTab] = useState<SystemSection["id"]>(initialTab);
  const serverInfo = useServerConfig();
  const health = useSystemHealth();
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
  } = useAppConfig();

  const { hasFieldError, onFieldErrorChange } = useFieldErrors();

  /** Renders the field rows and Save/Cancel for one section (tab content). */
  function renderSection(section: SystemSection) {
    if (section.renderStandaloneContent) {
      return section.renderStandaloneContent();
    }

    const moduleKeys = [...new Set(section.modules.map((m) => m.module))];
    const dirty = moduleKeys.some((m) => isGroupDirty(m));
    const saving = moduleKeys.some((m) => isGroupSaving(m));
    const hasErrors = hasFieldError(moduleKeys);
    const versionKey = moduleKeys
      .map((m) => `${m}-${getGroupVersion(m)}`)
      .join("_");

    const sectionYamlOnlyCount = section.modules.reduce((count, moduleDef) => {
      const sfMap = buildSchemaFieldMap(schema, moduleDef.module);
      return (
        count +
        moduleDef.fields.filter((f) => sfMap[f.key]?.databaseWritable === false)
          .length
      );
    }, 0);
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
    };

    const renderModuleFields = (moduleDef: ModuleDef) => {
      const { module, fields } = moduleDef;
      const sourceConfig = patchedAppConfig[module] ?? appConfig[module];
      const schemaFieldMap = buildSchemaFieldMap(schema, module);

      return fields.map((field) => {
        const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[field.key];
        const schemaField = schemaFieldMap[field.key];
        const fieldPath = `${module}/${field.key}`;
        return (
          <SystemConfigField
            key={fieldPath}
            module={module}
            field={field}
            sourceConfig={sourceConfig}
            schemaField={schemaField}
            descriptor={descriptor}
            showGroupYamlBanner={showGroupYamlBanner}
            error={fieldErrorsByPath[fieldPath]?.message}
            onErrorChange={onFieldErrorChange}
            update={update}
            saveField={saveField}
          />
        );
      });
    };
    const hasNamedModuleGroups = section.modules.some(
      (moduleDef) => moduleDef.headingKey,
    );

    return (
      <Stack component="section" data-testid={`system-section-${section.id}`}>
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {section.id === "overview"
              ? i18n.t("admin.system.overview.eyebrow")
              : i18n.t(section.titleKey)}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {section.explainerKey ? i18n.t(section.explainerKey) : undefined}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <Stack key={versionKey}>
          {section.id === "overview" ? (
            <SystemOverviewSnapshot
              serverInfo={serverInfo ?? {}}
              uptimeSeconds={health?.uptime_seconds}
            />
          ) : null}
          {section.renderContent?.()}
          {showGroupYamlBanner ? <YamlOnlyBanner /> : null}
          {hasNamedModuleGroups ? (
            <Accordion
              variant="default"
              multiple
              defaultValue={[`${section.id}-${section.modules[0]?.module}-0`]}
              data-testid={`system-control-list-${section.id}`}
            >
              {section.modules.map((moduleDef, index) => (
                <AccordionItem
                  key={`${moduleDef.module}-${moduleDef.headingKey ?? index}`}
                  value={`${section.id}-${moduleDef.module}-${index}`}
                >
                  <AccordionControl>
                    {moduleDef.headingKey
                      ? i18n.t(moduleDef.headingKey)
                      : moduleDef.module}
                  </AccordionControl>
                  <AccordionPanel>
                    <Stack>
                      {moduleDef.descriptionKey ? (
                        <SettingsSectionDescription>
                          {i18n.t(moduleDef.descriptionKey)}
                        </SettingsSectionDescription>
                      ) : null}
                      <SimpleGrid cols={2}>
                        {renderModuleFields(moduleDef)}
                      </SimpleGrid>
                    </Stack>
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          ) : (
            <SimpleGrid
              cols={2}
              data-testid={`system-control-list-${section.id}`}
            >
              {section.modules.flatMap(renderModuleFields)}
            </SimpleGrid>
          )}

          {/* Operations (e.g. SendTestEmail) */}
          {section.operations?.length ? (
            <SettingsToolbar justify="flex-start">
              {section.operations.map((Op, idx) => (
                <Op key={idx} appConfig={patchedAppConfig as AppConfig} />
              ))}
            </SettingsToolbar>
          ) : null}

          {/* Section-specific extras (e.g. telemetry categories grid + live stats) */}
          {section.renderExtras?.({
            appConfig: appConfig as AppConfig,
            patchedAppConfig: patchedAppConfig as AppConfig,
            update,
          })}

          {/* Save / Cancel */}
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
        </Stack>
      </Stack>
    );
  }

  return (
    <AdminPageFrame
      title={i18n.t("admin.system.title")}
      routeAnchor="admin-route-system"
    >
      <PageConfigErrorBoundary>
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const nextTab = resolveSystemTabId(value);
            setActiveTab(nextTab);
            updateCurrentSearchTab(nextTab);
          }}
          layout="page"
          variant="default"
        >
          <AdminSubnav
            items={SECTIONS.map((section) => ({
              value: section.id,
              label: i18n.t(`admin.system.tab.${section.id}`),
              testId: `system-tab-${section.id}`,
            }))}
          />

          <AdminPageScroll>
            <Stack>
              {SECTIONS.map((section) => {
                return (
                  <TabsContent
                    key={section.id}
                    value={section.id}
                    data-testid={`panel-${section.id}`}
                    forceMount
                    layout="stack"
                  >
                    {renderSection(section)}
                  </TabsContent>
                );
              })}
            </Stack>
          </AdminPageScroll>
        </Tabs>
      </PageConfigErrorBoundary>
    </AdminPageFrame>
  );
}

export { SystemPage as Component };
