// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Performance & Tuning page — multi-module layout.
 *
 * Manages settings from multiple server config modules:
 *   - server/worker/redis/http/storage (runtime and resource tuning)
 *   - websocket     (Socket.IO transport config)
 *   - throttle      (rate limiting)
 *   - doc           (document history and shared decoder capacity)
 *   - doc_service    (external doc service endpoint)
 *
 * Each section has its own Save/Cancel since they map to different server
 * modules.  The pattern follows the dedicated config-section pattern used by
 * the System page (`modules/system/index.tsx`).
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import {
  adminCacheTuningHistoryQuery,
  adminCacheTuningStatusQuery,
  adminCleanupTrashedDocEmbeddingsMutation,
  adminFlushAllDocCachesMutation,
  adminFlushDocMetadataCacheMutation,
  adminFlushDocMetadataProjectionCacheMutation,
  adminFlushDocSnapshotCacheMutation,
  adminTriggerFullReindexMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Sparkline,
  SettingsListItemMeta,
  SettingsStatusText,
  SettingsRow,
  SimpleGrid,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
  Tabs,
  TabsContent,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useState } from "react";

import { PageConfigErrorBoundary } from "../../components/page-config-error-boundary";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useRevalidateServerConfig } from "../common";
import { ALL_CONFIG_DESCRIPTORS } from "../settings/config";
import {
  ConfigArrayField,
  ConfigBooleanField,
  ConfigCheckboxGroupField,
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
import type { AdminConfigFieldState } from "../settings/use-admin-config-contract";
import { useAppConfig } from "../settings/use-app-config";
import { useFieldErrors } from "../settings/use-field-errors";
import { getByPath } from "../settings/utils";

// ---------------------------------------------------------------------------
// Section definitions — each section maps to one Facade settings section.
// Multi-module sections share a single Save/Cancel action group.
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

type PerfSection = {
  titleKey: string;
  modules: ModuleDef[];
};

function PerformanceConfigField({
  module,
  field,
  sourceConfig,
  schemaField,
  fieldState,
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
  fieldState?: AdminConfigFieldState;
  showGroupYamlBanner: boolean;
  error?: string;
  onErrorChange: (field: string, error?: string) => void;
  update: (path: string, value: unknown) => void;
  saveField: (field: string, value: unknown) => Promise<void>;
}) {
  const i18n = useI18n();
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
    restartRequired: Boolean(
      fieldState?.requiresRestart ?? schemaField?.restart_required,
    ),
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
        min={schemaField?.min ?? undefined}
        max={schemaField?.max ?? undefined}
        feedback={
          fieldState?.requiresRestart &&
          typeof fieldState.runtimeEffectiveValue === "number" ? (
            <SettingsStatusText>
              {i18n.t(
                fieldState.runtimeEffectiveState === "PENDING_RESTART"
                  ? "admin.config.runtime.pending"
                  : "admin.config.runtime.active",
                {
                  value:
                    `${new Intl.NumberFormat(i18n.language).format(fieldState.runtimeEffectiveValue)} ${field.suffix ?? descriptor?.suffix ?? ""}`.trim(),
                },
              )}
            </SettingsStatusText>
          ) : undefined
        }
      />
    );
  }
  if (type === "Enum") {
    return <ConfigSelectField {...commonProps} options={field.options ?? []} />;
  }
  if (type === "CheckboxGroup") {
    return (
      <ConfigCheckboxGroupField
        {...commonProps}
        options={field.options ?? []}
      />
    );
  }
  if (type === "Array") return <ConfigArrayField {...commonProps} />;
  if (type === "JSON") return <ConfigJsonField {...commonProps} />;
  return <ConfigTextField {...commonProps} sensitive={sensitive} />;
}

type PerformanceTabId =
  | "overview"
  | "server-tuning"
  | "websockets"
  | "sync-pipeline"
  | "limits"
  | "previews";

type PerformanceTab = {
  id: PerformanceTabId;
  titleKey: string;
  explainerKey: string;
  sections?: PerfSection[];
  renderContent?: () => ReactNode;
};

const SERVER_WEBSOCKET_SECTION: PerfSection = {
  titleKey: "admin.performance.websocket",
  modules: [
    {
      module: "websocket",
      fields: [
        {
          key: "broadcast_channel_capacity",
          type: "Number",
          desc: "admin.performance.field.ws-broadcast-capacity.desc",
        },
        {
          key: "max_http_buffer_size_mb",
          type: "Number",
          desc: "admin.performance.field.ws-max-http-buffer.desc",
          suffix: "MB",
        },
        {
          key: "ping_interval_seconds",
          type: "Number",
          desc: "admin.config.websocket.pingIntervalSeconds.desc",
          suffix: "s",
        },
        {
          key: "eio_ping_interval_seconds",
          type: "Number",
          desc: "admin.config.websocket.eioPingIntervalSeconds.desc",
          suffix: "s",
        },
        {
          key: "eio_ping_timeout_seconds",
          type: "Number",
          desc: "admin.config.websocket.eioPingTimeoutSeconds.desc",
          suffix: "s",
        },
      ],
    },
  ],
};

const WORKERS_SECTION: PerfSection = {
  titleKey: "admin.performance.workers",
  modules: [
    {
      module: "worker",
      fields: [
        {
          key: "polling.doc_maintenance_interval_ms",
          type: "Number",
          desc: "admin.performance.field.worker-doc-maintenance.desc",
          suffix: "ms",
        },
        {
          key: "polling.indexer_auto_index_interval_ms",
          type: "Number",
          desc: "admin.performance.field.worker-indexer-auto-index.desc",
          suffix: "ms",
        },
        {
          key: "polling.document_graph_reindex_interval_ms",
          type: "Number",
          desc: "admin.performance.field.worker-document-graph-reindex.desc",
          suffix: "ms",
        },
        {
          key: "polling.database_projection_interval_ms",
          type: "Number",
          desc: "admin.performance.field.worker-database-projection.desc",
          suffix: "ms",
        },
        {
          key: "polling.database_reminder_interval_ms",
          type: "Number",
          desc: "admin.performance.field.worker-database-reminder.desc",
          suffix: "ms",
        },
        {
          key: "polling.workspace_automation_retry_interval_ms",
          type: "Number",
          desc: "admin.performance.field.worker-workspace-automation-retry.desc",
          suffix: "ms",
        },
        {
          key: "polling.calendar_reminder_interval_ms",
          type: "Number",
          desc: "admin.performance.field.worker-calendar-reminder.desc",
          suffix: "ms",
        },
        {
          key: "cron_tick_interval_seconds",
          type: "Number",
          desc: "admin.performance.field.cron-tick-interval.desc",
          suffix: "s",
        },
      ],
    },
    {
      module: "logging",
      fields: [
        {
          key: "max_history",
          type: "Number",
          desc: "admin.performance.field.logging-max-history.desc",
          suffix: "entries",
        },
      ],
    },
    {
      module: "server",
      fields: [
        {
          key: "magic_link_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.magic-link-ttl.desc",
          suffix: "s",
        },
      ],
    },
  ],
};

const SERVER_CACHE_SECTION: PerfSection = {
  titleKey: "admin.performance.cache",
  modules: [
    {
      module: "redis",
      fields: [
        {
          key: "cache_ttl_quota_seconds",
          type: "Number",
          desc: "admin.performance.field.cache-ttl-quota.desc",
          suffix: "s",
        },
        {
          key: "cache_ttl_usage_seconds",
          type: "Number",
          desc: "admin.performance.field.cache-ttl-usage.desc",
          suffix: "s",
        },
        {
          key: "cache_ttl_git_status_seconds",
          type: "Number",
          desc: "admin.performance.field.cache-ttl-git-status.desc",
          suffix: "s",
        },
      ],
    },
  ],
};

const HTTP_LIMITS_SECTION: PerfSection = {
  titleKey: "admin.performance.http",
  modules: [
    {
      module: "http",
      fields: [
        {
          key: "proxy_timeout_seconds",
          type: "Number",
          desc: "admin.performance.field.http-proxy-timeout.desc",
          suffix: "s",
        },
      ],
    },
    {
      module: "storage",
      fields: [
        {
          key: "io_timeout_seconds",
          type: "Number",
          desc: "admin.performance.field.storage-io-timeout.desc",
          suffix: "s",
        },
      ],
    },
  ],
};

const WS_TRANSPORT_SECTION: PerfSection = {
  titleKey: "admin.performance.ws-transport",
  modules: [
    {
      module: "websocket",
      fields: [
        {
          key: "transports",
          type: "CheckboxGroup",
          options: ["websocket", "polling"],
        },
        { key: "max_http_buffer_size_mb", type: "Number", suffix: "MB" },
        { key: "ping_interval_seconds", type: "Number", suffix: "s" },
        {
          key: "max_connections_per_second_per_client",
          type: "Number",
          suffix: "/s",
        },
      ],
    },
  ],
};

const THROTTLE_SECTION: PerfSection = {
  titleKey: "admin.performance.throttle",
  modules: [
    {
      module: "throttle",
      fields: [
        { key: "enabled", type: "Boolean" },
        { key: "throttlers.default.ttl_ms", type: "Number" },
        { key: "throttlers.default.limit", type: "Number" },
        { key: "throttlers.strict.ttl_ms", type: "Number" },
        { key: "throttlers.strict.limit", type: "Number" },
      ],
    },
  ],
};

const DOCUMENT_GRAPH_LIMITS_SECTION: PerfSection = {
  titleKey: "admin.performance.document-graph",
  modules: [
    {
      module: "document_graph",
      fields: [
        { key: "max_graph_nodes", type: "Number" },
        { key: "max_graph_edges", type: "Number" },
        { key: "max_occurrences_per_edge", type: "Number" },
        { key: "max_reindex_batch", type: "Number" },
        { key: "max_catch_up_workspaces", type: "Number" },
        { key: "preview_max_chars", type: "Number" },
        { key: "stale_after_seconds", type: "Number", suffix: "s" },
        { key: "enqueue_delay_ms", type: "Number", suffix: "ms" },
        { key: "max_reindex_attempts", type: "Number" },
      ],
    },
  ],
};

const DATABASE_LIMITS_SECTION: PerfSection = {
  titleKey: "admin.performance.databases",
  modules: [
    {
      module: "databases",
      fields: [
        {
          key: "reminder_batch_size",
          type: "Number",
          desc: "admin.performance.field.database-reminder-batch-size.desc",
        },
        {
          key: "max_reminders_per_user_per_cell",
          type: "Number",
          desc: "admin.performance.field.database-reminders-per-cell.desc",
        },
        {
          key: "max_reminder_offset_minutes",
          type: "Number",
          desc: "admin.performance.field.database-reminder-offset.desc",
          suffix: "min",
        },
      ],
    },
  ],
};

const DOC_SECTION: PerfSection = {
  titleKey: "admin.documents.title",
  modules: [
    {
      module: "doc",
      fields: [
        { key: "decoder_concurrency", type: "Number" },
        { key: "history.interval", type: "Number", suffix: "ms" },
      ],
    },
  ],
};

const DOC_SERVICE_SECTION: PerfSection = {
  titleKey: "admin.performance.doc-service",
  modules: [
    {
      module: "doc_service",
      fields: [{ key: "endpoint", type: "String" }],
    },
  ],
};

const DOC_CACHE_SECTION: PerfSection = {
  titleKey: "admin.performance.doc-cache",
  modules: [
    {
      module: "redis",
      fields: [
        {
          key: "doc_snapshot_cache_enabled",
          type: "Boolean",
          desc: "admin.performance.field.doc-snapshot-cache-enabled.desc",
        },
        {
          key: "cache_ttl_doc_snapshot_seconds",
          type: "Number",
          suffix: "s",
          desc: "admin.performance.field.cache-ttl-doc-snapshot.desc",
        },
        {
          key: "doc_snapshot_cache_max_size_mb",
          type: "Number",
          suffix: "MB",
          desc: "admin.performance.field.doc-snapshot-cache-max-size.desc",
        },
        {
          key: "doc_metadata_cache_enabled",
          type: "Boolean",
          desc: "admin.performance.field.doc-metadata-cache-enabled.desc",
        },
        {
          key: "cache_ttl_doc_metadata_seconds",
          type: "Number",
          suffix: "s",
          desc: "admin.performance.field.cache-ttl-doc-metadata.desc",
        },
        {
          key: "doc_metadata_projection_cache_enabled",
          type: "Boolean",
          desc: "admin.performance.field.doc-metadata-projection-cache-enabled.desc",
        },
        {
          key: "cache_ttl_doc_metadata_projection_seconds",
          type: "Number",
          suffix: "s",
          desc: "admin.performance.field.cache-ttl-doc-metadata-projection.desc",
        },
        {
          key: "doc_view_dedup_enabled",
          type: "Boolean",
          desc: "admin.performance.field.doc-view-dedup-enabled.desc",
        },
        {
          key: "compaction_lock_enabled",
          type: "Boolean",
          desc: "admin.performance.field.compaction-lock-enabled.desc",
        },
        {
          key: "compaction_lock_ttl_seconds",
          type: "Number",
          suffix: "s",
          desc: "admin.performance.field.compaction-lock-ttl.desc",
        },
        {
          key: "doc_timestamps_cache_enabled",
          type: "Boolean",
          desc: "admin.performance.field.doc-timestamps-cache-enabled.desc",
        },
        {
          key: "cache_ttl_doc_timestamps_seconds",
          type: "Number",
          suffix: "s",
          desc: "admin.performance.field.cache-ttl-doc-timestamps.desc",
        },
        {
          key: "doc_timestamps_cache_max_docs",
          type: "Number",
          desc: "admin.performance.field.doc-timestamps-cache-max-docs.desc",
        },
        {
          key: "compaction_threshold_default",
          type: "Number",
          desc: "admin.performance.field.compaction-threshold-default.desc",
        },
        {
          key: "compaction_threshold_root_doc",
          type: "Number",
          desc: "admin.performance.field.compaction-threshold-root-doc.desc",
        },
      ],
    },
  ],
};

const GENERAL_CACHE_AUTOTUNING_SECTION: PerfSection = {
  titleKey: "admin.performance.cache-tuning-overrides",
  modules: [
    {
      module: "cache",
      fields: [
        {
          key: "tuning_hourly_enabled",
          type: "Boolean",
          desc: "admin.performance.field.hourly-enabled.desc",
        },
        {
          key: "tuning_daily_enabled",
          type: "Boolean",
          desc: "admin.performance.field.daily-enabled.desc",
        },
        {
          key: "server_config_fixed_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.server-config-fixed-ttl.desc",
          suffix: "s",
        },
        {
          key: "user_features_fixed_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.user-features-fixed-ttl.desc",
          suffix: "s",
        },
        {
          key: "throttle_config_fixed_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.throttle-config-fixed-ttl.desc",
          suffix: "s",
        },
      ],
    },
  ],
};

const WEBSOCKET_CACHE_AUTOTUNING_SECTION: PerfSection = {
  titleKey: "admin.performance.cache-tuning-overrides",
  modules: [
    {
      module: "cache",
      fields: [
        {
          key: "ws_settings_fixed_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.ws-settings-fixed-ttl.desc",
          suffix: "s",
        },
      ],
    },
  ],
};

const DOC_CACHE_AUTOTUNING_SECTION: PerfSection = {
  titleKey: "admin.performance.cache-tuning-overrides",
  modules: [
    {
      module: "cache",
      fields: [
        {
          key: "doc_snapshot_fixed_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.doc-snapshot-fixed-ttl.desc",
          suffix: "s",
        },
        {
          key: "doc_metadata_fixed_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.doc-metadata-fixed-ttl.desc",
          suffix: "s",
        },
        {
          key: "doc_metadata_projection_fixed_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.doc-metadata-projection-fixed-ttl.desc",
          suffix: "s",
        },
        {
          key: "doc_timestamps_fixed_ttl_seconds",
          type: "Number",
          desc: "admin.performance.field.doc-timestamps-fixed-ttl.desc",
          suffix: "s",
        },
      ],
    },
  ],
};

/**
 * Presentation metadata only. The server registry remains authoritative for
 * numeric bounds, defaults, write policy and live-versus-restart lifecycle.
 */
const PREVIEW_SECTION: PerfSection = {
  titleKey: "admin.performance.preview",
  modules: [
    {
      module: "preview",
      fields: [
        { key: "max_input_bytes", type: "Number", suffix: "bytes" },
        { key: "max_source_blocks", type: "Number" },
        { key: "max_projected_blocks", type: "Number" },
        { key: "max_text_chars", type: "Number", suffix: "chars" },
        { key: "max_depth", type: "Number" },
        { key: "max_table_rows", type: "Number" },
        { key: "max_table_columns", type: "Number" },
        { key: "max_visuals", type: "Number" },
        { key: "max_media_bytes", type: "Number", suffix: "bytes" },
        { key: "max_font_bytes", type: "Number", suffix: "bytes" },
        { key: "max_decoded_image_pixels", type: "Number", suffix: "px" },
        { key: "max_svg_input_bytes", type: "Number", suffix: "bytes" },
        { key: "max_mermaid_source_bytes", type: "Number", suffix: "bytes" },
        { key: "max_mermaid_elements", type: "Number" },
        { key: "max_outlined_paths", type: "Number" },
        { key: "max_output_svg_bytes", type: "Number", suffix: "bytes" },
        { key: "max_png_pixels", type: "Number", suffix: "px" },
        { key: "max_active_global_renders", type: "Number" },
        { key: "max_active_renders_per_actor", type: "Number" },
        { key: "max_in_flight_requests", type: "Number" },
        { key: "output_cache_max_bytes", type: "Number", suffix: "bytes" },
        { key: "output_cache_max_entries", type: "Number" },
        { key: "output_cache_ttl_seconds", type: "Number", suffix: "s" },
        {
          key: "prepared_font_cache_max_bytes",
          type: "Number",
          suffix: "bytes",
        },
        { key: "prepared_font_cache_max_entries", type: "Number" },
        {
          key: "prepared_font_cache_ttl_seconds",
          type: "Number",
          suffix: "s",
        },
        { key: "request_timeout_ms", type: "Number", suffix: "ms" },
        { key: "render_timeout_ms", type: "Number", suffix: "ms" },
        { key: "failure_expiry_seconds", type: "Number", suffix: "s" },
        { key: "retry_count", type: "Number" },
      ],
    },
  ],
};

const PERFORMANCE_TABS: PerformanceTab[] = [
  {
    id: "overview",
    titleKey: "admin.performance.tab.overview",
    explainerKey: "admin.performance.overview.desc",
    renderContent: () => <CacheTuningStatusSection />,
  },
  {
    id: "server-tuning",
    titleKey: "admin.performance.tab.server-tuning",
    explainerKey: "admin.performance.server-tuning.desc",
    sections: [
      WORKERS_SECTION,
      SERVER_CACHE_SECTION,
      GENERAL_CACHE_AUTOTUNING_SECTION,
    ],
  },
  {
    id: "websockets",
    titleKey: "admin.performance.tab.websockets",
    explainerKey: "admin.performance.websockets.desc",
    sections: [
      SERVER_WEBSOCKET_SECTION,
      WS_TRANSPORT_SECTION,
      WEBSOCKET_CACHE_AUTOTUNING_SECTION,
    ],
  },
  {
    id: "sync-pipeline",
    titleKey: "admin.performance.tab.sync-pipeline",
    explainerKey: "admin.performance.sync-pipeline.desc",
    sections: [
      DOC_SECTION,
      DOC_SERVICE_SECTION,
      DOC_CACHE_SECTION,
      DOC_CACHE_AUTOTUNING_SECTION,
    ],
    renderContent: () => <DocCacheFlushSection />,
  },
  {
    id: "limits",
    titleKey: "admin.performance.tab.limits",
    explainerKey: "admin.performance.limits.desc",
    sections: [
      HTTP_LIMITS_SECTION,
      THROTTLE_SECTION,
      DOCUMENT_GRAPH_LIMITS_SECTION,
      DATABASE_LIMITS_SECTION,
    ],
  },
  {
    id: "previews",
    titleKey: "admin.performance.tab.previews",
    explainerKey: "admin.performance.preview.desc",
    sections: [PREVIEW_SECTION],
  },
];

const PERFORMANCE_TAB_IDS = new Set(PERFORMANCE_TABS.map((tab) => tab.id));

function resolvePerformanceTabId(raw: string | null): PerformanceTabId {
  return PERFORMANCE_TAB_IDS.has(raw as PerformanceTabId)
    ? (raw as PerformanceTabId)
    : "overview";
}

function updateCurrentSearchTab(tab: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

// ---------------------------------------------------------------------------
// Native inline history; the adjacent percentage columns own absolute rates.
// ---------------------------------------------------------------------------

function HitRateSparkline({ cacheName }: { cacheName: string }) {
  const i18n = useI18n();
  const { data } = useQuery(
    {
      query: adminCacheTuningHistoryQuery,
      variables: { cacheName, hours: 24 },
    },
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
  );
  const points = data?.admin?.adminCacheTuningHistory ?? [];
  if (points.length < 2) {
    return <SettingsListItemMeta>—</SettingsListItemMeta>;
  }
  return (
    <Sparkline
      role="img"
      aria-label={`${i18n.t("admin.performance.cache-col-trend")}: ${cacheName}`}
      data={points.map((point) => point.hitRate)}
    />
  );
}

// ---------------------------------------------------------------------------
// Cache tuning status section (read-only live stats)
// ---------------------------------------------------------------------------

function formatCacheAction(
  action: string | null | undefined,
  t: (key: string) => string,
) {
  if (!action) return "—";
  const normalized = action.trim().toLowerCase();
  const knownActions = new Set([
    "increased",
    "decreased",
    "unchanged",
    "enabled",
    "disabled",
    "none",
  ]);
  return knownActions.has(normalized)
    ? t(`admin.performance.cache-action.${normalized}`)
    : action;
}

function CacheTuningStatusSection() {
  const i18n = useI18n();
  const { data } = useQuery(
    { query: adminCacheTuningStatusQuery },
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
  const rows = data?.admin?.adminCacheTuningStatus ?? [];

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.performance.cache-tuning-status")}
        </SettingsSectionHeading>
      </SettingsHeadingGroup>
      {rows.length === 0 ? (
        <SettingsListItemMeta>
          {i18n.t("admin.performance.cache-tuning-no-data")}
        </SettingsListItemMeta>
      ) : (
        <TableScrollContainer>
          <Table verticalSpacing="xs">
            <TableHeader>
              <TableRow>
                <TableHead>
                  {i18n.t("admin.performance.cache-col-name")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.performance.cache-col-ttl")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.performance.cache-col-hit1h")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.performance.cache-col-hit24h")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.performance.cache-col-last-action")}
                </TableHead>
                <TableHead ta="center">
                  {i18n.t("admin.performance.cache-col-fixed")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.performance.cache-col-trend")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.name}>
                  <TableCell mono>{row.name}</TableCell>
                  <TableCell tabular ta="right">
                    {row.currentTtlSeconds}s
                  </TableCell>
                  <TableCell tabular ta="right">
                    {row.hitRate1H != null
                      ? `${(row.hitRate1H * 100).toFixed(1)}%`
                      : "—"}
                  </TableCell>
                  <TableCell tabular ta="right">
                    {row.hitRate24H != null
                      ? `${(row.hitRate24H * 100).toFixed(1)}%`
                      : "—"}
                  </TableCell>
                  <TableCell muted>
                    {formatCacheAction(row.lastAction, i18n.t)}
                  </TableCell>
                  <TableCell ta="center">
                    {row.isFixedOverride ? "✓" : ""}
                  </TableCell>
                  <TableCell>
                    <HitRateSparkline cacheName={row.name} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScrollContainer>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// P103-B-04: Doc-cache flush section (server-side mutations now implemented)
// ---------------------------------------------------------------------------

function DocCacheFlushSection() {
  const i18n = useI18n();
  const { trigger: triggerFlushSnapshot } = useMutation({
    mutation: adminFlushDocSnapshotCacheMutation,
  });
  const { trigger: triggerFlushMetadata } = useMutation({
    mutation: adminFlushDocMetadataCacheMutation,
  });
  const { trigger: triggerFlushMetadataProjection } = useMutation({
    mutation: adminFlushDocMetadataProjectionCacheMutation,
  });
  const { trigger: triggerFlushAll } = useMutation({
    mutation: adminFlushAllDocCachesMutation,
  });

  const handleFlushSnapshot = useCallback(() => {
    triggerFlushSnapshot()
      .then((res) => {
        const count = res?.admin?.adminFlushDocSnapshotCache ?? 0;
        toast.success(
          i18n.t("admin.performance.flush-snapshot-cache-success", { count }),
        );
      })
      .catch((e) => {
        toast.error(
          i18n.t("admin.performance.flush-cache-error", {
            message: (e as Error).message,
          }),
        );
      });
  }, [triggerFlushSnapshot, i18n]);

  const handleFlushMetadata = useCallback(() => {
    triggerFlushMetadata()
      .then((res) => {
        const count = res?.admin?.adminFlushDocMetadataCache ?? 0;
        toast.success(
          i18n.t("admin.performance.flush-metadata-cache-success", { count }),
        );
      })
      .catch((e) => {
        toast.error(
          i18n.t("admin.performance.flush-cache-error", {
            message: (e as Error).message,
          }),
        );
      });
  }, [triggerFlushMetadata, i18n]);

  const handleFlushMetadataProjection = useCallback(() => {
    triggerFlushMetadataProjection()
      .then((res) => {
        const count = res?.admin?.adminFlushDocMetadataProjectionCache ?? 0;
        toast.success(
          i18n.t("admin.performance.flush-metadata-projection-cache-success", {
            count,
          }),
        );
      })
      .catch((e) => {
        toast.error(
          i18n.t("admin.performance.flush-cache-error", {
            message: (e as Error).message,
          }),
        );
      });
  }, [triggerFlushMetadataProjection, i18n]);

  const handleFlushAll = useCallback(() => {
    triggerFlushAll()
      .then((res) => {
        const count = res?.admin?.adminFlushAllDocCaches ?? 0;
        toast.success(
          i18n.t("admin.performance.flush-all-doc-caches-success", { count }),
        );
      })
      .catch((e) => {
        toast.error(
          i18n.t("admin.performance.flush-cache-error", {
            message: (e as Error).message,
          }),
        );
      });
  }, [triggerFlushAll, i18n]);

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.performance.doc-cache-flush")}
        </SettingsSectionHeading>
      </SettingsHeadingGroup>
      <Stack>
        <SettingsRow
          name={i18n.t("admin.performance.flush-snapshot-cache")}
          desc={i18n.t("admin.performance.flush-snapshot-cache-desc")}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={handleFlushSnapshot}
            data-testid="flush-snapshot-cache-btn"
          >
            {i18n.t("admin.performance.flush-snapshot-cache")}
          </Button>
        </SettingsRow>
        <SettingsRow
          name={i18n.t("admin.performance.flush-metadata-cache")}
          desc={i18n.t("admin.performance.flush-metadata-cache-desc")}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={handleFlushMetadata}
            data-testid="flush-metadata-cache-btn"
          >
            {i18n.t("admin.performance.flush-metadata-cache")}
          </Button>
        </SettingsRow>
        <SettingsRow
          name={i18n.t("admin.performance.flush-metadata-projection-cache")}
          desc={i18n.t(
            "admin.performance.flush-metadata-projection-cache-desc",
          )}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={handleFlushMetadataProjection}
            data-testid="flush-metadata-projection-cache-btn"
          >
            {i18n.t("admin.performance.flush-metadata-projection-cache")}
          </Button>
        </SettingsRow>
        <SettingsRow
          name={i18n.t("admin.performance.flush-all-doc-caches")}
          desc={i18n.t("admin.performance.flush-all-doc-caches-desc")}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={handleFlushAll}
            data-testid="flush-all-doc-caches-btn"
          >
            {i18n.t("admin.performance.flush-all-doc-caches")}
          </Button>
        </SettingsRow>
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function PerformancePage() {
  const i18n = useI18n();
  const initialTab = resolvePerformanceTabId(
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("tab"),
  );
  const [activeTab, setActiveTab] = useState<PerformanceTabId>(initialTab);
  const {
    appConfig,
    patchedAppConfig,
    schema,
    update,
    saveGroup,
    saveField,
    removeOverrides,
    resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath = {},
    configFieldStates = {},
  } = useAppConfig();
  const revalidateServerConfig = useRevalidateServerConfig();

  const { hasFieldError, onFieldErrorChange } = useFieldErrors();

  // P98-B-02: Full reindex
  const { trigger: triggerFullReindex } = useMutation({
    mutation: adminTriggerFullReindexMutation,
  });
  const [fullReindexDialogOpen, setFullReindexDialogOpen] = useState(false);
  const [restoringSection, setRestoringSection] = useState<string>();

  const handleFullReindex = useCallback(() => {
    triggerFullReindex()
      .then(() => {
        toast.success(i18n.t("admin.performance.full-reindex-success"));
        setFullReindexDialogOpen(false);
      })
      .catch((e) => {
        toast.error(
          i18n.t("admin.performance.full-reindex-error", {
            message: (e as Error).message,
          }),
        );
      });
  }, [triggerFullReindex, i18n]);

  // P98-B-03: Cleanup trashed embeddings
  const { trigger: triggerCleanup } = useMutation({
    mutation: adminCleanupTrashedDocEmbeddingsMutation,
  });
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);

  const handleCleanup = useCallback(() => {
    triggerCleanup()
      .then((res) => {
        const count = res?.admin?.triggerCleanupTrashedDocEmbeddings ?? 0;
        toast.success(
          i18n.t("admin.performance.cleanup-embeddings-success", { count }),
        );
        setCleanupDialogOpen(false);
      })
      .catch((e) => {
        toast.error(
          i18n.t("admin.performance.cleanup-embeddings-error", {
            message: (e as Error).message,
          }),
        );
      });
  }, [triggerCleanup, i18n]);

  // Shared section renderer used in both tabs.
  const renderSection = (section: PerfSection) => {
    const moduleKeys = [
      ...new Set(section.modules.map((m: { module: string }) => m.module)),
    ];
    const dirty = moduleKeys.some((m) => isGroupDirty(m));
    const saving = moduleKeys.some((m) => isGroupSaving(m));
    const hasErrors = hasFieldError(moduleKeys);
    const versionKey = moduleKeys
      .map((m) => `${m}-${getGroupVersion(m)}`)
      .join("_");
    const overriddenPaths = section.modules.flatMap(({ module, fields }) =>
      fields
        .map(({ key }) => `${module}.${key}`)
        .filter((path) => configFieldStates[path]?.winningSource === "DATABASE")
        .map((path) => path.replace(".", "/")),
    );

    const sectionYamlOnlyCount = section.modules.reduce((count, moduleDef) => {
      const sfMap = buildSchemaFieldMap(schema, moduleDef.module);
      return (
        count +
        moduleDef.fields.filter(
          (f: FieldDef) => sfMap[f.key]?.databaseWritable === false,
        ).length
      );
    }, 0);
    const showGroupYamlBanner = sectionYamlOnlyCount >= 2;

    const handleSave = async () => {
      for (const m of moduleKeys) {
        if (isGroupDirty(m)) {
          await saveGroup(m);
        }
      }
      await revalidateServerConfig();
    };

    const handleReset = () => {
      for (const m of moduleKeys) {
        if (isGroupDirty(m)) {
          resetGroup(m);
        }
      }
    };

    const handleRestoreBaseline = async () => {
      setRestoringSection(section.titleKey);
      try {
        await removeOverrides(overriddenPaths);
        await revalidateServerConfig();
      } finally {
        setRestoringSection(undefined);
      }
    };

    return (
      <Stack key={section.titleKey} component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t(section.titleKey)}
          </SettingsSectionHeading>
        </SettingsHeadingGroup>
        {section === SERVER_WEBSOCKET_SECTION ? (
          <SettingsStatusText>
            {i18n.t("admin.config.websocket.proxyRequirement", {
              configured: new Intl.NumberFormat(i18n.language).format(
                Number(
                  (patchedAppConfig.websocket ?? appConfig.websocket)
                    ?.eio_ping_interval_seconds,
                ) +
                  Number(
                    (patchedAppConfig.websocket ?? appConfig.websocket)
                      ?.eio_ping_timeout_seconds,
                  ),
              ),
              active: new Intl.NumberFormat(i18n.language).format(
                Number(
                  configFieldStates["websocket.eio_ping_interval_seconds"]
                    ?.runtimeEffectiveValue ??
                    appConfig.websocket?.eio_ping_interval_seconds,
                ) +
                  Number(
                    configFieldStates["websocket.eio_ping_timeout_seconds"]
                      ?.runtimeEffectiveValue ??
                      appConfig.websocket?.eio_ping_timeout_seconds,
                  ),
              ),
            })}
          </SettingsStatusText>
        ) : null}
        <Stack key={versionKey}>
          {showGroupYamlBanner && <YamlOnlyBanner />}
          <SimpleGrid cols={2}>
            {section.modules.map((moduleDef) => {
              const { module, fields } = moduleDef;
              const sourceConfig =
                patchedAppConfig[module] ?? appConfig[module];

              const schemaFieldMap = buildSchemaFieldMap(schema, module);

              return fields.map((field: FieldDef) => {
                const fieldPath = `${module}/${field.key}`;
                const schemaField = schemaFieldMap[field.key];

                return (
                  <PerformanceConfigField
                    key={fieldPath}
                    module={module}
                    field={field}
                    sourceConfig={sourceConfig}
                    schemaField={schemaField}
                    fieldState={configFieldStates[`${module}.${field.key}`]}
                    showGroupYamlBanner={showGroupYamlBanner}
                    error={fieldErrorsByPath[fieldPath]?.message}
                    onErrorChange={onFieldErrorChange}
                    update={update}
                    saveField={saveField}
                  />
                );
              });
            })}
          </SimpleGrid>
          {/* Save / Cancel per section */}
          <ConfigPageSaveButtons
            dirty={dirty}
            hasFieldError={hasErrors}
            saving={saving}
            hasSavedOverride={overriddenPaths.length > 0}
            restoring={restoringSection === section.titleKey}
            onReset={handleReset}
            onRestoreBaseline={() => {
              handleRestoreBaseline().catch((err) => {
                toast.error(i18n.t("admin.common.save-failed"), {
                  description: err?.message ?? String(err),
                });
              });
            }}
            onSave={() => {
              handleSave().catch((err) => {
                toast.error(i18n.t("admin.common.save-failed"), {
                  description: err?.message ?? String(err),
                });
              });
            }}
          />
        </Stack>
      </Stack>
    );
  };

  const renderMaintenanceSection = () => (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.performance.maintenance")}
        </SettingsSectionHeading>
      </SettingsHeadingGroup>
      <Stack>
        <SettingsRow
          name={i18n.t("admin.performance.full-reindex")}
          desc={i18n.t("admin.performance.full-reindex-desc")}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => setFullReindexDialogOpen(true)}
            data-testid="full-reindex-btn"
          >
            {i18n.t("admin.performance.full-reindex")}
          </Button>
        </SettingsRow>

        <SettingsRow
          name={i18n.t("admin.performance.cleanup-embeddings")}
          desc={i18n.t("admin.performance.cleanup-embeddings-desc")}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => setCleanupDialogOpen(true)}
            data-testid="cleanup-embeddings-btn"
          >
            {i18n.t("admin.performance.cleanup-embeddings")}
          </Button>
        </SettingsRow>
      </Stack>
    </Stack>
  );

  return (
    <AdminPageFrame
      title={i18n.t("admin.performance.title")}
      routeAnchor="admin-route-performance"
    >
      <PageConfigErrorBoundary>
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const nextTab = resolvePerformanceTabId(value);
            setActiveTab(nextTab);
            updateCurrentSearchTab(nextTab);
          }}
          layout="page"
          variant="default"
        >
          <AdminSubnav
            items={PERFORMANCE_TABS.map((tab) => ({
              value: tab.id,
              label: i18n.t(tab.titleKey),
              testId: `performance-tab-${tab.id}`,
            }))}
          />

          <AdminPageScroll>
            <Stack>
              {PERFORMANCE_TABS.map((tab) => (
                <TabsContent
                  key={tab.id}
                  value={tab.id}
                  data-testid={`tab-content-${tab.id}`}
                  layout="stack"
                  forceMount
                >
                  {tab.renderContent?.()}
                  {tab.sections?.map((section) => renderSection(section))}
                  {tab.id === "sync-pipeline"
                    ? renderMaintenanceSection()
                    : null}
                </TabsContent>
              ))}

              {/* Confirmation dialogs (outside tabs so they don't unmount) */}
              <AdminConfirmModal
                open={fullReindexDialogOpen}
                onOpenChange={setFullReindexDialogOpen}
                title={i18n.t("admin.performance.full-reindex-confirm-title")}
                description={i18n.t(
                  "admin.performance.full-reindex-confirm-desc",
                )}
                confirmText={i18n.t("admin.performance.full-reindex")}
                danger
                onConfirm={handleFullReindex}
                onCancel={() => setFullReindexDialogOpen(false)}
              />
              <AdminConfirmModal
                open={cleanupDialogOpen}
                onOpenChange={setCleanupDialogOpen}
                title={i18n.t(
                  "admin.performance.cleanup-embeddings-confirm-title",
                )}
                description={i18n.t(
                  "admin.performance.cleanup-embeddings-confirm-desc",
                )}
                confirmText={i18n.t("admin.performance.cleanup-embeddings")}
                danger
                onConfirm={handleCleanup}
                onCancel={() => setCleanupDialogOpen(false)}
              />
            </Stack>
          </AdminPageScroll>
        </Tabs>
      </PageConfigErrorBoundary>
    </AdminPageFrame>
  );
}
export { PerformancePage as Component };
