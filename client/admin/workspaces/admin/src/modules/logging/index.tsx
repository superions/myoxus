// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Logging administration page.
 *
 * Provides runtime log-level management per module, preset quick-actions,
 * log output configuration, and a change history audit trail.
 */
import {
  applyLogPresetMutation,
  loggingConfigQuery,
  resetLogLevelsMutation,
  updateLogModuleLevelMutation,
  updateLogOutputMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
  TimerIcon,
  XCircleIcon,
} from "@myoxus/icons/react";
import {
  Button,
  ErrorMessage,
  Group,
  Input,
  MonoText,
  MyoxusSelect,
  SettingsNotice,
  SettingsSkeleton,
  SettingsField,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
  TerminalMutedText,
  TerminalPanel,
  Tooltip,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";

import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import { formatAdminDateTime } from "../../utils/locale-format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

interface LogModule {
  group: string;
  displayName: string;
  level: LogLevel;
  recommendedDefault: LogLevel;
  description: string;
  highVolumeWarning: boolean;
}

interface LogOutput {
  filePath: string;
  rotation: string;
  maxFiles: number;
  pathValid: boolean;
  pathError: string | null;
}

interface RecentChange {
  timestamp: string;
  group: string;
  previousLevel: LogLevel;
  newLevel: LogLevel;
  changedBy: string;
  autoRevertAt: string | null;
}

interface DiskUsage {
  totalBytes: number;
  fileCount: number;
  freeBytes: number;
}

interface LoggingConfig {
  modules: LogModule[];
  output: LogOutput;
  recentChanges: RecentChange[];
  diskUsage: DiskUsage;
}

type I18nLike = {
  t: (key: string) => string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error"];
const LOG_ROTATIONS = ["Never", "Hourly", "Daily", "Weekly"] as const;
const LOG_ROTATION_LABEL_KEYS: Record<
  (typeof LOG_ROTATIONS)[number],
  | "admin.logging.rotation.never"
  | "admin.logging.rotation.hourly"
  | "admin.logging.rotation.daily"
  | "admin.logging.rotation.weekly"
> = {
  Never: "admin.logging.rotation.never",
  Hourly: "admin.logging.rotation.hourly",
  Daily: "admin.logging.rotation.daily",
  Weekly: "admin.logging.rotation.weekly",
};
const AUTO_REVERT_OPTIONS = [
  { label: "5 min", value: 5 },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "60 min", value: 60 },
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTimestamp(language: string | undefined, iso: string): string {
  return formatAdminDateTime(language, iso);
}

function moduleDescription(i18n: I18nLike, mod: LogModule): string {
  const key = `admin.logging.module-description.${mod.group}`;
  const translated = i18n.t(key);
  return translated === key ? mod.description : translated;
}

function isHighVolume(level: LogLevel): boolean {
  return level === "trace" || level === "debug";
}

function normalizeRotationForSelect(rotation: string): string {
  const match = LOG_ROTATIONS.find(
    (candidate) => candidate.toLowerCase() === rotation.toLowerCase(),
  );
  return match ?? rotation;
}

function rotationMutationValue(rotation: string): string {
  return rotation.toUpperCase();
}

// ---------------------------------------------------------------------------
// Countdown Hook
// ---------------------------------------------------------------------------

function useCountdown(targetIso: string | null): string | null {
  const [remaining, setRemaining] = useState<string | null>(null);

  useEffect(() => {
    if (!targetIso) {
      setRemaining(null);
      return;
    }
    const update = () => {
      const diff = new Date(targetIso).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining(null);
        return;
      }
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setRemaining(`${mins}:${secs.toString().padStart(2, "0")}`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  return remaining;
}

// ---------------------------------------------------------------------------
// Module Level Row
// ---------------------------------------------------------------------------

function ModuleLevelRow({
  mod,
  onLevelChange,
}: {
  mod: LogModule;
  onLevelChange: (
    group: string,
    level: LogLevel,
    autoRevertMinutes?: number,
  ) => void;
}) {
  const i18n = useI18n();
  const [tempDebug, setTempDebug] = useState(false);
  const [autoRevertMinutes, setAutoRevertMinutes] = useState(15);
  const [autoRevertAt, setAutoRevertAt] = useState<string | null>(null);
  const countdown = useCountdown(autoRevertAt);

  const handleLevelChange = useCallback(
    (level: string) => {
      onLevelChange(mod.group, level as LogLevel);
    },
    [mod.group, onLevelChange],
  );

  const handleTempDebugToggle = useCallback(() => {
    if (tempDebug) {
      // Disable temp debug — revert to recommended default
      setTempDebug(false);
      setAutoRevertAt(null);
      onLevelChange(mod.group, mod.recommendedDefault);
    } else {
      // Enable temp debug
      setTempDebug(true);
      const revertTime = new Date(
        Date.now() + autoRevertMinutes * 60 * 1000,
      ).toISOString();
      setAutoRevertAt(revertTime);
      onLevelChange(mod.group, "debug", autoRevertMinutes);
    }
  }, [
    tempDebug,
    mod.group,
    mod.recommendedDefault,
    autoRevertMinutes,
    onLevelChange,
  ]);

  return (
    <TableRow>
      <TableCell>
        <Group wrap="nowrap">
          <strong>{mod.displayName}</strong>
          {mod.highVolumeWarning && isHighVolume(mod.level) && (
            <Tooltip content={i18n.t("admin.logging.high-volume-warning")}>
              <AlertTriangleIcon size="var(--mantine-spacing-lg)" aria-hidden />
            </Tooltip>
          )}
        </Group>
      </TableCell>
      <TableCell>
        <MyoxusSelect
          aria-label={`${mod.displayName} ${i18n.t("admin.logging.table.level")}`}
          value={mod.level}
          onChange={handleLevelChange}
          data={LOG_LEVELS.map((level) => ({
            value: level,
            label: level.toUpperCase(),
          }))}
        />
      </TableCell>
      <TableCell>{mod.recommendedDefault}</TableCell>
      <TableCell>{moduleDescription(i18n, mod)}</TableCell>
      <TableCell>
        <Group wrap="nowrap">
          <Button
            variant={tempDebug ? "default" : "outline"}
            onClick={handleTempDebugToggle}
          >
            <TimerIcon size="var(--mantine-spacing-lg)" aria-hidden />
            {tempDebug
              ? i18n.t("admin.logging.stop")
              : i18n.t("admin.logging.temp-debug")}
          </Button>
          {tempDebug && (
            <>
              <MyoxusSelect
                aria-label={`${mod.displayName} ${i18n.t("admin.logging.table.auto-revert")}`}
                value={String(autoRevertMinutes)}
                onChange={(value) => setAutoRevertMinutes(Number(value))}
                data={AUTO_REVERT_OPTIONS.map((option) => ({
                  value: String(option.value),
                  label: option.label,
                }))}
              />
              {countdown && <MonoText>{countdown}</MonoText>}
            </>
          )}
        </Group>
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Main content
// ---------------------------------------------------------------------------

export function LoggingContent() {
  const i18n = useI18n();
  const { data, error, isValidating, mutate } = useQuery({
    query: loggingConfigQuery,
  });
  const config = data?.admin.loggingConfig as LoggingConfig | undefined;
  const revalidate = useMutateQueryResource();

  const { trigger: triggerUpdateLevel } = useMutation({
    mutation: updateLogModuleLevelMutation,
  });
  const { trigger: triggerReset } = useMutation({
    mutation: resetLogLevelsMutation,
  });
  const { trigger: triggerPreset } = useMutation({
    mutation: applyLogPresetMutation,
  });
  const { trigger: triggerUpdateOutput } = useMutation({
    mutation: updateLogOutputMutation,
  });

  // Local state for output form
  const [filePath, setFilePath] = useState(config?.output.filePath ?? "");
  const [rotation, setRotation] = useState(config?.output.rotation ?? "");
  const [maxFiles, setMaxFiles] = useState(config?.output.maxFiles ?? 0);
  const [pathValid, setPathValid] = useState(config?.output.pathValid ?? true);
  const [pathError, setPathError] = useState<string | null>(
    config?.output.pathError ?? null,
  );
  const [traceDialogOpen, setTraceDialogOpen] = useState(false);
  const filePathRef = useRef<HTMLInputElement>(null);

  // Sync from server data
  useEffect(() => {
    if (!config) {
      return;
    }
    setFilePath(config.output.filePath);
    setRotation(config.output.rotation);
    setMaxFiles(config.output.maxFiles);
    setPathValid(config.output.pathValid);
    setPathError(config.output.pathError);
  }, [config]);

  const refetch = useCallback(async () => {
    await revalidate(loggingConfigQuery);
  }, [revalidate]);

  // Handlers
  const handleLevelChange = useCallback(
    async (group: string, level: LogLevel, autoRevertMinutes?: number) => {
      await triggerUpdateLevel({
        input: { group, level, autoRevertMinutes: autoRevertMinutes ?? null },
      });
      await refetch();
    },
    [triggerUpdateLevel, refetch],
  );

  const handlePreset = useCallback(
    async (preset: string) => {
      await triggerPreset({ preset });
      await refetch();
    },
    [triggerPreset, refetch],
  );

  const handleReset = useCallback(async () => {
    await triggerReset();
    await refetch();
  }, [triggerReset, refetch]);

  const handleOutputSave = useCallback(
    async (updates: {
      filePath?: string;
      rotation?: string;
      maxFiles?: number;
    }) => {
      const result = await triggerUpdateOutput({ input: updates });
      if (result?.admin?.updateLogOutput) {
        setPathValid(result.admin.updateLogOutput.pathValid);
        setPathError(result.admin.updateLogOutput.pathError);
      }
      await refetch();
    },
    [triggerUpdateOutput, refetch],
  );

  const handleFilePathBlur = useCallback(() => {
    if (config && filePath !== config.output.filePath) {
      void handleOutputSave({ filePath });
    }
  }, [filePath, config, handleOutputSave]);

  const handleRotationChange = useCallback(
    (value: string) => {
      setRotation(value);
      void handleOutputSave({ rotation: rotationMutationValue(value) });
    },
    [handleOutputSave],
  );

  const handleMaxFilesChange = useCallback((value: string) => {
    const val = Math.max(1, Math.min(365, Number(value) || 1));
    setMaxFiles(val);
  }, []);

  const handleMaxFilesBlur = useCallback(() => {
    if (config && maxFiles !== config.output.maxFiles) {
      void handleOutputSave({ maxFiles });
    }
  }, [maxFiles, config, handleOutputSave]);

  if (error)
    return (
      <SettingsNotice
        tone="error"
        title={i18n.t("com.myoxus.settings.common.load-error")}
      >
        {error.message}
        <Group>
          <Button
            disabled={isValidating}
            onClick={() => void mutate(undefined, { throwOnError: false })}
          >
            {i18n.t("admin.error.retry")}
          </Button>
        </Group>
      </SettingsNotice>
    );
  if (!config) return <SettingsSkeleton />;

  return (
    <Stack>
      {/* Section 1: Module Levels */}
      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.logging.module-levels")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.logging.module-levels-description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <TableScrollContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{i18n.t("admin.logging.table.module")}</TableHead>
                <TableHead>{i18n.t("admin.logging.table.level")}</TableHead>
                <TableHead>{i18n.t("admin.logging.table.default")}</TableHead>
                <TableHead>
                  {i18n.t("admin.logging.table.description")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.logging.table.temp-debug")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {config.modules.map((mod) => (
                <ModuleLevelRow
                  key={mod.group}
                  mod={mod}
                  onLevelChange={handleLevelChange}
                />
              ))}
            </TableBody>
          </Table>
        </TableScrollContainer>
      </Stack>

      {/* Section 2: Presets */}
      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.logging.presets")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.logging.presets-description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <Group wrap="wrap">
          <Button variant="outline" onClick={() => handlePreset("production")}>
            {i18n.t("admin.logging.preset.production")}
          </Button>
          <Button variant="outline" onClick={() => handlePreset("debug")}>
            {i18n.t("admin.logging.preset.debug")}
          </Button>

          <Button variant="outline" onClick={() => setTraceDialogOpen(true)}>
            {i18n.t("admin.logging.preset.trace")}
          </Button>
          <AdminConfirmModal
            open={traceDialogOpen}
            onOpenChange={setTraceDialogOpen}
            title={i18n.t("admin.logging.preset.trace-confirm")}
            description={i18n.t("admin.logging.preset.trace-warning")}
            danger
            confirmText={i18n.t("admin.logging.preset.trace-enable")}
            onConfirm={() => {
              setTraceDialogOpen(false);
              void handlePreset("trace");
            }}
          />

          <Button variant="secondary" onClick={handleReset}>
            <RefreshCwIcon size="var(--mantine-spacing-lg)" aria-hidden />
            {i18n.t("admin.logging.reset")}
          </Button>
        </Group>
      </Stack>

      {/* Section 3: Log Output */}
      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.logging.log-output")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.logging.log-output-description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <Stack>
          <SettingsField label={i18n.t("admin.logging.file-path")}>
            <Input
              ref={filePathRef}
              aria-label={i18n.t("admin.logging.file-path")}
              value={filePath}
              onChange={setFilePath}
              onBlur={handleFilePathBlur}
              placeholder="/var/log/myoxus/server.log"
              endFix={
                pathValid ? (
                  <SettingsStatusText tone="active">
                    <CheckCircle2Icon
                      size="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
                      aria-hidden
                    />
                  </SettingsStatusText>
                ) : (
                  <Tooltip
                    content={pathError || i18n.t("admin.logging.invalid-path")}
                  >
                    <SettingsStatusText tone="error">
                      <XCircleIcon
                        size="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
                        aria-hidden
                      />
                    </SettingsStatusText>
                  </Tooltip>
                )
              }
            />
            {!pathValid && pathError && (
              <ErrorMessage role="alert">{pathError}</ErrorMessage>
            )}
          </SettingsField>

          <SettingsField label={i18n.t("admin.logging.rotation")}>
            <MyoxusSelect
              aria-label={i18n.t("admin.logging.rotation")}
              value={normalizeRotationForSelect(rotation)}
              onChange={handleRotationChange}
              data={LOG_ROTATIONS.map((value) => ({
                value,
                label: i18n.t(LOG_ROTATION_LABEL_KEYS[value]),
              }))}
            />
          </SettingsField>

          <SettingsField label={i18n.t("admin.logging.max-files")}>
            <Input
              type="number"
              aria-label={i18n.t("admin.logging.max-files")}
              min={1}
              max={365}
              step={1}
              value={maxFiles}
              onChange={handleMaxFilesChange}
              onBlur={handleMaxFilesBlur}
            />
          </SettingsField>

          <SettingsStatusText data-testid="logging-disk-usage">
            {i18n.t("admin.logging.disk-usage", {
              totalBytes: formatBytes(config.diskUsage.totalBytes),
              fileCount: config.diskUsage.fileCount,
              freeBytes: formatBytes(config.diskUsage.freeBytes),
            })}
          </SettingsStatusText>
        </Stack>
      </Stack>

      {/* Section 4: Change History */}
      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.logging.change-history")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.logging.change-history-description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        {config.recentChanges.length === 0 ? (
          <SettingsStatusText>
            {i18n.t("admin.logging.no-recent-changes")}
          </SettingsStatusText>
        ) : (
          <TableScrollContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {i18n.t("admin.logging.table.timestamp")}
                  </TableHead>
                  <TableHead>{i18n.t("admin.logging.table.group")}</TableHead>
                  <TableHead>
                    {i18n.t("admin.logging.table.level-change")}
                  </TableHead>
                  <TableHead>
                    {i18n.t("admin.logging.table.changed-by")}
                  </TableHead>
                  <TableHead>
                    {i18n.t("admin.logging.table.auto-revert")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {config.recentChanges.slice(0, 20).map((change, idx) => (
                  <ChangeHistoryRow
                    key={`${change.timestamp}-${idx}`}
                    change={change}
                  />
                ))}
              </TableBody>
            </Table>
          </TableScrollContainer>
        )}
      </Stack>

      {/* Section 5: Live Tail */}
      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.logging.live-tail")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.logging.live-tail-description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <LiveTailTerminal />
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Change History Row
// ---------------------------------------------------------------------------

function ChangeHistoryRow({ change }: { change: RecentChange }) {
  const i18n = useI18n();
  const countdown = useCountdown(change.autoRevertAt);

  return (
    <TableRow>
      <TableCell>{formatTimestamp(i18n.language, change.timestamp)}</TableCell>
      <TableCell>
        <strong>{change.group}</strong>
      </TableCell>
      <TableCell>
        <span>{change.previousLevel}</span>
        {" → "}
        <strong>{change.newLevel}</strong>
      </TableCell>
      <TableCell>{change.changedBy}</TableCell>
      <TableCell>
        {change.autoRevertAt ? (
          <SettingsStatusText tone="warning">
            <TimerIcon size="var(--mantine-spacing-lg)" aria-hidden />
            {countdown ?? formatTimestamp(i18n.language, change.autoRevertAt)}
          </SettingsStatusText>
        ) : (
          <span>{i18n.t("admin.logging.permanent")}</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Live Tail Terminal (P33-E-09)
// ---------------------------------------------------------------------------

function LiveTailTerminal() {
  const i18n = useI18n();
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    const basePath =
      typeof environment !== "undefined" && environment.subPath
        ? environment.subPath
        : "";
    const es = new EventSource(`${basePath}/api/admin/logs/tail`);
    eventSourceRef.current = es;
    setConnected(true);
    setLines([]);

    es.onmessage = (event) => {
      if (!paused) {
        setLines((prev) => {
          const next = [...prev, event.data];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      eventSourceRef.current = null;
    };
  }, [paused]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);
  }, []);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (!paused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, paused]);

  const filteredLines = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <Stack>
      <SettingsToolbar justify="space-between" align="center">
        <SettingsToolbar justify="flex-start" align="center">
          {!connected ? (
            <Button variant="outline" onClick={connect}>
              {i18n.t("admin.logging.connect")}
            </Button>
          ) : (
            <Button variant="outline" onClick={disconnect}>
              {i18n.t("admin.logging.disconnect")}
            </Button>
          )}
          <Button
            variant={paused ? "default" : "outline"}
            onClick={() => setPaused(!paused)}
            disabled={!connected}
          >
            {paused
              ? i18n.t("admin.logging.resume")
              : i18n.t("admin.logging.pause")}
          </Button>
          <Input
            placeholder={i18n.t("admin.logging.filter-placeholder")}
            value={filter}
            onChange={setFilter}
          />
        </SettingsToolbar>
        <SettingsStatusText>
          {connected
            ? i18n.t("admin.logging.lines-count", {
                count: filteredLines.length,
              })
            : i18n.t("admin.logging.disconnected")}
        </SettingsStatusText>
      </SettingsToolbar>
      <TerminalPanel ref={containerRef} data-testid="logging-live-terminal">
        {filteredLines.length === 0 ? (
          <TerminalMutedText>
            {connected
              ? i18n.t("admin.logging.waiting-for-output")
              : i18n.t("admin.logging.click-connect")}
          </TerminalMutedText>
        ) : (
          filteredLines.map((line, i) => <div key={i}>{line}</div>)
        )}
      </TerminalPanel>
    </Stack>
  );
}
