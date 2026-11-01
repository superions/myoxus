/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const useAppConfigMock = vi.fn();
const useQueryMock = vi.fn();

vi.mock("../settings/use-app-config", () => ({
  useAppConfig: () => useAppConfigMock(),
}));
vi.mock("../common", () => ({ useRevalidateServerConfig: () => vi.fn() }));

import enJson from "../../../../../../libs/i18n/src/resources/en.json";

const translations = enJson as Record<string, string>;
const tMock = vi.fn((key: string, options?: Record<string, unknown>) => {
  let text = translations[key] ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replaceAll(`{{${name}}}`, String(value));
  }
  return text;
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: tMock,
    exists: (key: string) => key in translations,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

const mutations = vi.hoisted(() => ({
  reindex: vi.fn().mockResolvedValue({ admin: { triggerFullReindex: true } }),
  cleanup: vi
    .fn()
    .mockResolvedValue({ admin: { triggerCleanupTrashedDocEmbeddings: 4 } }),
  snapshot: vi
    .fn()
    .mockResolvedValue({ admin: { adminFlushDocSnapshotCache: 2 } }),
  metadata: vi
    .fn()
    .mockResolvedValue({ admin: { adminFlushDocMetadataCache: 3 } }),
  projection: vi
    .fn()
    .mockResolvedValue({ admin: { adminFlushDocMetadataProjectionCache: 5 } }),
  all: vi.fn().mockResolvedValue({ admin: { adminFlushAllDocCaches: 10 } }),
}));

vi.mock("../../use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { op: string } }) => {
    const trigger =
      {
        adminTriggerFullReindex: mutations.reindex,
        adminCleanupTrashedDocEmbeddings: mutations.cleanup,
        adminFlushDocSnapshotCache: mutations.snapshot,
        adminFlushDocMetadataCache: mutations.metadata,
        adminFlushDocMetadataProjectionCache: mutations.projection,
        adminFlushAllDocCaches: mutations.all,
      }[mutation.op] ?? vi.fn();
    return { trigger, isMutating: false };
  },
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@myoxus/admin/notifications", () => ({ adminToast: toast }));
vi.mock("../../use-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));
vi.mock("../settings/config", () => ({ ALL_CONFIG_DESCRIPTORS: {} }));
vi.mock("../settings/config-form-fields", () => {
  const field =
    (type: string) =>
    ({
      field,
      defaultValue,
      databaseWritable,
      restartRequired,
      feedback,
      onChange,
    }: {
      field: string;
      defaultValue?: unknown;
      databaseWritable?: boolean;
      restartRequired?: boolean;
      feedback?: ReactNode;
      onChange?: (path: string, value: unknown) => void;
    }) => (
      <label
        data-testid={`field-${field}`}
        data-type={type}
        data-writable={String(databaseWritable)}
        data-restart-required={String(restartRequired)}
      >
        {field}
        {feedback}
        <input
          data-testid={`input-${field}`}
          defaultValue={String(defaultValue ?? "")}
          onChange={(event) => onChange?.(field, event.target.value)}
        />
      </label>
    );
  return {
    ConfigTextField: field("String"),
    ConfigNumberField: field("Number"),
    ConfigBooleanField: field("Boolean"),
    ConfigSelectField: field("Enum"),
    ConfigArrayField: field("Array"),
    ConfigJsonField: field("Object"),
    ConfigCheckboxGroupField: field("CheckboxGroup"),
    YamlOnlyBanner: () => <div data-testid="file-only-banner" />,
  };
});

import { PerformancePage } from "./index";

const config = {
  websocket: {
    broadcast_channel_capacity: 4096,
    max_http_buffer_size_mb: 100,
    ping_interval_seconds: 25,
    eio_ping_interval_seconds: 60,
    eio_ping_timeout_seconds: 120,
    max_connections_per_second_per_client: 10,
    transports: ["polling", "websocket"],
  },
  worker: {
    polling: {
      doc_maintenance_interval_ms: 120_000,
      indexer_auto_index_interval_ms: 30_000,
      document_graph_reindex_interval_ms: 30_000,
      database_projection_interval_ms: 30_000,
      database_reminder_interval_ms: 60_000,
      workspace_automation_retry_interval_ms: 30_000,
      calendar_reminder_interval_ms: 60_000,
    },
    cron_tick_interval_seconds: 60,
  },
  server: { magic_link_ttl_seconds: 1800 },
  redis: {
    cache_ttl_quota_seconds: 300,
    cache_ttl_usage_seconds: 300,
    cache_ttl_git_status_seconds: 60,
  },
  http: { proxy_timeout_seconds: 10 },
  storage: { io_timeout_seconds: 15 },
  throttle: {
    enabled: true,
    throttlers: {
      default: { ttl_ms: 60_000, limit: 120 },
      strict: { ttl_ms: 60_000, limit: 20 },
    },
  },
  doc: { history: { interval: 60_000 } },
  doc_service: { endpoint: "http://localhost:3010" },
  document_graph: {
    max_graph_nodes: 250,
    max_graph_edges: 500,
    max_occurrences_per_edge: 25,
    max_reindex_batch: 100,
    max_catch_up_workspaces: 25,
    preview_max_chars: 256,
    stale_after_seconds: 300,
    enqueue_delay_ms: 0,
    max_reindex_attempts: 5,
  },
  databases: {
    reminder_batch_size: 100,
    max_reminders_per_user_per_cell: 5,
    max_reminder_offset_minutes: 525_600,
  },
  cache: {
    tuning_hourly_enabled: true,
    tuning_daily_enabled: true,
    server_config_fixed_ttl_seconds: 60,
    user_features_fixed_ttl_seconds: 60,
    throttle_config_fixed_ttl_seconds: 60,
    ws_settings_fixed_ttl_seconds: 60,
    doc_snapshot_fixed_ttl_seconds: 60,
    doc_metadata_fixed_ttl_seconds: 60,
    doc_metadata_projection_fixed_ttl_seconds: 60,
    doc_timestamps_fixed_ttl_seconds: 60,
  },
  preview: Object.fromEntries(
    [
      "max_input_bytes",
      "max_source_blocks",
      "max_projected_blocks",
      "max_text_chars",
      "max_depth",
      "max_table_rows",
      "max_table_columns",
      "max_visuals",
      "max_media_bytes",
      "max_font_bytes",
      "max_decoded_image_pixels",
      "max_svg_input_bytes",
      "max_mermaid_source_bytes",
      "max_mermaid_elements",
      "max_outlined_paths",
      "max_output_svg_bytes",
      "max_png_pixels",
      "max_active_global_renders",
      "max_active_renders_per_actor",
      "max_in_flight_requests",
      "output_cache_max_bytes",
      "output_cache_max_entries",
      "output_cache_ttl_seconds",
      "prepared_font_cache_max_bytes",
      "prepared_font_cache_max_entries",
      "prepared_font_cache_ttl_seconds",
      "request_timeout_ms",
      "render_timeout_ms",
      "failure_expiry_seconds",
      "retry_count",
    ].map((key) => [key, 1]),
  ),
};

const schema = {
  modules: Object.entries(config).map(([module, value]) => ({
    module,
    groups: [
      {
        fields: Object.keys(value).map((key) => ({
          key,
          path: `${module}.${key}`,
          valueType: "Number",
          databaseWritable: true,
          immediate_apply: false,
          restart_required: false,
        })),
      },
    ],
  })),
};

function defaultConfigHook(overrides: Record<string, unknown> = {}) {
  return {
    appConfig: config,
    patchedAppConfig: config,
    schema,
    update: vi.fn(),
    saveField: vi.fn().mockResolvedValue(undefined),
    removeOverrides: vi.fn().mockResolvedValue(undefined),
    saveGroup: vi.fn().mockResolvedValue(undefined),
    resetGroup: vi.fn(),
    isGroupDirty: vi.fn().mockReturnValue(false),
    isGroupSaving: vi.fn().mockReturnValue(false),
    getGroupVersion: vi.fn().mockReturnValue(0),
    fieldErrorsByPath: {},
    configFieldStates: {},
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MyoxusUIProvider>
      <PerformancePage />
    </MyoxusUIProvider>,
  );
}

describe("PerformancePage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/adminfrontend/performance");
    useAppConfigMock.mockReset();
    useAppConfigMock.mockReturnValue(defaultConfigHook());
    useQueryMock.mockImplementation(({ query }: { query: { op: string } }) => ({
      data: {
        admin:
          query.op === "adminCacheTuningStatus"
            ? { adminCacheTuningStatus: [] }
            : { adminCacheTuningHistory: [] },
      },
    }));
    Object.values(mutations).forEach((mock) => mock.mockClear());
    toast.success.mockClear();
    toast.error.mockClear();
  });

  afterEach(cleanup);

  test("renders canonical config paths and nested values", () => {
    renderPage();

    expect(
      screen.getByTestId("field-websocket/broadcast_channel_capacity"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("field-worker/polling.doc_maintenance_interval_ms"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("field-server/magic_link_ttl_seconds"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("field-cache/app_config_fixed_ttl_seconds"),
    ).toBeNull();
    expect(
      (
        screen.getByTestId(
          "input-throttle/throttlers.default.ttl_ms",
        ) as HTMLInputElement
      ).value,
    ).toBe("60000");
  });

  test("uses server schema write policy and saves the canonical owner module", async () => {
    const saveGroup = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn();
    useAppConfigMock.mockReturnValue(
      defaultConfigHook({
        saveGroup,
        update,
        configFieldStates: {
          "websocket.eio_ping_interval_seconds": {
            requiresRestart: true,
            runtimeEffectiveValue: 2,
            runtimeEffectiveState: "PENDING_RESTART",
          },
          "websocket.eio_ping_timeout_seconds": {
            requiresRestart: true,
            runtimeEffectiveValue: 3,
            runtimeEffectiveState: "PENDING_RESTART",
          },
        },
        isGroupDirty: (module: string) => module === "websocket",
      }),
    );
    renderPage();

    fireEvent.click(screen.getByTestId("performance-tab-websockets"));

    for (const key of [
      "eio_ping_interval_seconds",
      "eio_ping_timeout_seconds",
    ]) {
      expect(screen.getByTestId(`field-websocket/${key}`).dataset.type).toBe(
        "Number",
      );
      expect(
        screen.getByTestId(`field-websocket/${key}`).dataset.restartRequired,
      ).toBe("true");
    }
    expect(
      screen.getByText(/Proxy read\/send timeouts must exceed 180 s/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Active on this API: 2 s. Saved changes require an API restart.",
      ),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByTestId("input-websocket/eio_ping_interval_seconds"),
      {
        target: { value: "2" },
      },
    );
    expect(update).toHaveBeenCalledWith(
      "websocket/eio_ping_interval_seconds",
      "2",
    );
    expect(update).not.toHaveBeenCalledWith(
      "websocket/ping_interval_seconds",
      "2",
    );
    const field = screen.getByTestId(
      "field-websocket/broadcast_channel_capacity",
    );
    expect(field.dataset.writable).toBe("true");
    fireEvent.change(
      screen.getByTestId("input-websocket/broadcast_channel_capacity"),
      {
        target: { value: "8192" },
      },
    );
    expect(update).toHaveBeenCalledWith(
      "websocket/broadcast_channel_capacity",
      "8192",
    );

    const save = screen
      .getAllByRole("button", { name: translations["admin.common.save"] })
      .find((button) => !button.hasAttribute("disabled"));
    expect(save).toBeTruthy();
    fireEvent.click(save!);
    await waitFor(() => expect(saveGroup).toHaveBeenCalledWith("websocket"));
  });

  test("renders current cache status without the removed app-config cache", () => {
    useQueryMock.mockImplementation(({ query }: { query: { op: string } }) => ({
      data: {
        admin:
          query.op === "adminCacheTuningStatus"
            ? {
                adminCacheTuningStatus: [
                  {
                    name: "server_config",
                    currentTtlSeconds: 120,
                    hitRate1H: 0.75,
                    hitRate24H: 0.5,
                    lastAction: "unchanged",
                    isFixedOverride: true,
                  },
                ],
              }
            : {
                adminCacheTuningHistory: [{ hitRate: 0.5 }, { hitRate: 0.75 }],
              },
      },
    }));
    renderPage();

    expect(screen.getByText("server_config")).toBeTruthy();
    expect(screen.queryByText("app_config")).toBeNull();
    expect(screen.getByText("75.0%")).toBeTruthy();
    screen.getByRole("img", {
      name: "Trend (24h): server_config",
    });
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ op: "adminCacheTuningHistory" }),
        variables: { cacheName: "server_config", hours: 24 },
      }),
      expect.objectContaining({ dedupingInterval: 300_000 }),
    );
  });

  test("keeps document-cache maintenance actions wired to their owner mutations", async () => {
    window.history.replaceState(
      null,
      "",
      "/adminfrontend/performance?tab=sync-pipeline",
    );
    renderPage();

    fireEvent.click(screen.getByTestId("flush-snapshot-cache-btn"));
    fireEvent.click(screen.getByTestId("flush-all-doc-caches-btn"));
    await waitFor(() => {
      expect(mutations.snapshot).toHaveBeenCalledTimes(1);
      expect(mutations.all).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledTimes(2);
    });
  });

  test("makes every canonical preview setting reachable with schema lifecycle metadata", () => {
    window.history.replaceState(
      null,
      "",
      "/adminfrontend/performance?tab=previews",
    );
    const previewRestartFields = new Set([
      "max_active_global_renders",
      "max_active_renders_per_actor",
      "max_in_flight_requests",
      "output_cache_max_bytes",
      "output_cache_max_entries",
      "output_cache_ttl_seconds",
      "prepared_font_cache_max_bytes",
      "prepared_font_cache_max_entries",
      "prepared_font_cache_ttl_seconds",
      "failure_expiry_seconds",
    ]);
    const previewSchema = schema.modules.find(
      (module) => module.module === "preview",
    );
    for (const field of previewSchema?.groups[0]?.fields ?? []) {
      field.restart_required = previewRestartFields.has(field.key);
    }

    renderPage();

    expect(screen.getByTestId("tab-content-previews")).toBeTruthy();
    expect(Object.keys(config.preview)).toHaveLength(30);
    for (const fieldName of Object.keys(config.preview)) {
      const field = screen.getByTestId(`field-preview/${fieldName}`);
      expect(field.dataset.type).toBe("Number");
      expect(field.dataset.writable).toBe("true");
      expect(field.dataset.restartRequired).toBe(
        String(previewRestartFields.has(fieldName)),
      );
    }
  });

  test("removes saved preview overrides through the canonical config writer", async () => {
    window.history.replaceState(
      null,
      "",
      "/adminfrontend/performance?tab=previews",
    );
    const removeOverrides = vi.fn().mockResolvedValue(undefined);
    useAppConfigMock.mockReturnValue(
      defaultConfigHook({
        removeOverrides,
        configFieldStates: {
          "preview.max_text_chars": { winningSource: "DATABASE" },
          "preview.max_projected_blocks": { winningSource: "DEFAULT" },
        },
      }),
    );

    renderPage();
    fireEvent.click(
      screen.getByRole("button", {
        name: translations["admin.config.restore_baseline"],
      }),
    );

    await waitFor(() =>
      expect(removeOverrides).toHaveBeenCalledWith(["preview/max_text_chars"]),
    );
  });
});
