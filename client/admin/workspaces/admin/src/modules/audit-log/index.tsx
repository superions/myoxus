// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unified Admin Audit Log — server-backed audit search for all admin domains.
 *
 * Filters are sent to the GraphQL resolver whenever the schema supports them.
 * The actor filter intentionally uses the shared Admin UserPicker so this
 * page does not invent a second user lookup surface.
 */
import {
  type AdminAuditLogEntryType,
  adminAuditLogQuery,
  type AuditLogFilterInput,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { RotateCcw } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  FormSelect,
  IconButton,
  Input,
  SettingsListItemMeta,
  SettingsSectionHeading,
  SettingsStatusText,
  SettingsToolbar,
  SimpleGrid,
  Stack,
  TableCell,
  TableRow,
} from "@myoxus/ui-facade";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { UserPicker } from "../../components/domain-pickers";
import { useQuery } from "../../use-query";
import { formatAdminDateTime } from "../../utils/locale-format";
import { AdminPageFrame, AdminPageScroll } from "../admin-shell";
import { auditActorLabel, auditTargetLabel, eventLabel } from "./audit-labels";
import { AuditDetailDrawer } from "./components/audit-detail-drawer";
import { AuditRowDiffCell } from "./components/audit-row";
import { AuditPaginatedTable } from "./components/audit-table-section";

const PAGE_SIZE = 50;

const CATEGORIES = [
  "auth",
  "config",
  "organization",
  "user",
  "workspace",
  "document",
  "template",
  "pdf_export_config",
  "document_version",
  "mcp",
  "feature",
  "cache",
  "logging",
] as const;

const TARGET_TYPES = [
  "workspace",
  "user",
  "organization_unit",
  "template",
  "document",
  "mcp_api_key",
  "pdf_export_config",
  "config",
] as const;

/** Format a Date to an app-controlled, locale-neutral filter value. */
function toDatetimeText(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDatetimeFilter(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.replace(/\s+/, "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    return undefined;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function categoryTone(category: string) {
  return CATEGORIES.includes(category as (typeof CATEGORIES)[number])
    ? category
    : "default";
}

function CategoryBadge({
  category,
  label,
}: {
  category: string;
  label: string;
}) {
  const tone = categoryTone(category);
  const badgeTone =
    tone === "user" || tone === "workspace"
      ? "success"
      : tone === "template" || tone === "document_version" || tone === "mcp"
        ? "warning"
        : tone === "feature" ||
            tone === "cache" ||
            tone === "logging" ||
            tone === "auth"
          ? "error"
          : tone === "config" ||
              tone === "pdf_export_config" ||
              tone === "organization"
            ? "info"
            : "neutral";

  return <Badge tone={badgeTone}>{label}</Badge>;
}

function categoryLabel(category: string, t: (key: string) => string) {
  const key = `admin.audit-log.category.${category}`;
  const label = t(key);
  return label === key ? category : label;
}

function filterValue(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function AuditLogPage() {
  const i18n = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState(searchParams.get("category") ?? "");
  const [actorUserId, setActorUserId] = useState(
    searchParams.get("actor_user_id") ?? "",
  );
  const [targetType, setTargetType] = useState(
    searchParams.get("target_type") ??
      (searchParams.has("target_unit_id") ? "organization_unit" : ""),
  );
  const [targetId, setTargetId] = useState(searchParams.get("target_id") ?? "");
  const [targetUnitId, setTargetUnitId] = useState(
    searchParams.get("target_unit_id") ?? "",
  );
  const [eventKeyPrefix, setEventKeyPrefix] = useState(
    searchParams.get("event_key_prefix") ?? "",
  );
  const [fromLocal, setFromLocal] = useState("");
  const [toLocal, setToLocal] = useState("");
  const [filterResetKey, setFilterResetKey] = useState(0);
  const [selectedEntry, setSelectedEntry] =
    useState<AdminAuditLogEntryType | null>(null);

  const filter: AuditLogFilterInput = useMemo(() => {
    const next: AuditLogFilterInput = {};
    if (category) next.category = category;
    if (actorUserId) next.actorUserId = actorUserId;
    if (targetType) next.targetType = targetType;
    if (targetType && filterValue(targetId)) next.targetId = targetId.trim();
    if (targetUnitId) next.targetUnitId = targetUnitId;
    if (eventKeyPrefix.trim().length >= 2) {
      next.eventKeyPrefix = eventKeyPrefix.trim();
    }
    const from = parseDatetimeFilter(fromLocal);
    const to = parseDatetimeFilter(toLocal);
    if (from) next.from = from;
    if (to) next.to = to;
    return next;
  }, [
    actorUserId,
    category,
    eventKeyPrefix,
    fromLocal,
    targetId,
    targetType,
    targetUnitId,
    toLocal,
  ]);

  const { data } = useQuery(
    {
      query: adminAuditLogQuery,
      variables: { filter, limit: PAGE_SIZE, offset },
    },
    { keepPreviousData: true },
  );

  const entries: AdminAuditLogEntryType[] = data?.admin?.adminAuditLog ?? [];
  const totalCount: number = data?.admin?.adminAuditLogCount ?? 0;

  function updatePresetParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  function resetFilters() {
    setCategory("");
    setActorUserId("");
    setTargetType("");
    setTargetId("");
    setTargetUnitId("");
    setEventKeyPrefix("");
    setFromLocal("");
    setToLocal("");
    setOffset(0);
    setSearchParams({}, { replace: true });
    // Reset the picker's transient search draft as well as the server filter.
    setFilterResetKey((key) => key + 1);
  }

  function applyPreset(hours: number | null) {
    const now = new Date();
    setToLocal(toDatetimeText(now));
    if (hours === null) {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      setFromLocal(toDatetimeText(startOfDay));
    } else {
      setFromLocal(toDatetimeText(new Date(now.getTime() - hours * 3_600_000)));
    }
    setOffset(0);
  }

  return (
    <AdminPageFrame
      title={i18n.t("admin.audit-log.title")}
      routeAnchor="admin-route-audit-log"
    >
      <AdminPageScroll>
        <Stack>
          <Stack>
            <SettingsSectionHeading>
              {i18n.t("admin.audit-log.filter.title")}
            </SettingsSectionHeading>
            <SimpleGrid cols={3}>
              <FormSelect
                id="audit-category"
                label={i18n.t("admin.audit-log.filter.category.label")}
                value={category}
                onChange={(next) => {
                  setCategory(next);
                  updatePresetParam("category", next || null);
                  setOffset(0);
                }}
                aria-label={i18n.t("admin.audit-log.filter.category.label")}
                data={[
                  {
                    value: "",
                    label: i18n.t("admin.audit-log.filter.category.all"),
                  },
                  ...CATEGORIES.map((cat) => ({
                    value: cat,
                    label: i18n.t(`admin.audit-log.category.${cat}` as never),
                  })),
                ]}
              />
              <Stack>
                <UserPicker
                  key={filterResetKey}
                  mode="admin"
                  label={i18n.t("admin.audit-log.filter.actor.label")}
                  value={actorUserId || null}
                  onChange={(id) => {
                    const next = id ?? "";
                    setActorUserId(next);
                    updatePresetParam("actor_user_id", next || null);
                    setOffset(0);
                  }}
                  placeholder={i18n.t(
                    "admin.audit-log.filter.actor.placeholder",
                  )}
                  data-testid="audit-log-actor-picker"
                />
                {actorUserId ? (
                  <SettingsListItemMeta breakAnywhere>
                    {i18n.t("admin.audit-log.filter.actor.selected")}:{" "}
                    {actorUserId}
                  </SettingsListItemMeta>
                ) : null}
              </Stack>
              <Stack>
                <FormSelect
                  id="audit-target-type"
                  label={i18n.t("admin.audit-log.filter.targetType.label")}
                  value={targetType}
                  onChange={(next) => {
                    const nextParams = new URLSearchParams(searchParams);
                    setTargetType(next);
                    if (next) nextParams.set("target_type", next);
                    else nextParams.delete("target_type");
                    if (next !== "organization_unit") {
                      setTargetUnitId("");
                      nextParams.delete("target_unit_id");
                    }
                    setSearchParams(nextParams, { replace: true });
                    setOffset(0);
                  }}
                  aria-label={i18n.t("admin.audit-log.filter.targetType.label")}
                  data={[
                    {
                      value: "",
                      label: i18n.t("admin.audit-log.filter.targetType.all"),
                    },
                    ...TARGET_TYPES.map((type) => ({
                      value: type,
                      label: i18n.t(
                        `admin.audit-log.filter.targetType.${type}` as never,
                      ),
                    })),
                  ]}
                />
                {targetType ? (
                  <Input
                    id="audit-target-id"
                    label={i18n.t("admin.audit-log.filter.target.label")}
                    placeholder={i18n.t(
                      "admin.audit-log.filter.target.placeholder",
                    )}
                    value={targetId}
                    onChange={(next) => {
                      setTargetId(next);
                      updatePresetParam("target_id", next || null);
                      setOffset(0);
                    }}
                    aria-label={i18n.t("admin.audit-log.filter.target.label")}
                  />
                ) : null}
                {targetUnitId ? (
                  <SettingsListItemMeta breakAnywhere>
                    {i18n.t("admin.audit-log.filter.targetUnit.preset")}:{" "}
                    {targetUnitId}
                  </SettingsListItemMeta>
                ) : null}
              </Stack>
              <Input
                id="audit-event-key"
                label={i18n.t("admin.audit-log.filter.eventKey.label")}
                placeholder={i18n.t(
                  "admin.audit-log.filter.eventKey.placeholder",
                )}
                value={eventKeyPrefix}
                onChange={(next) => {
                  setEventKeyPrefix(next);
                  updatePresetParam("event_key_prefix", next || null);
                  setOffset(0);
                }}
                aria-label={i18n.t("admin.audit-log.filter.eventKey.label")}
              />
              <Input
                id="audit-from"
                label={i18n.t("admin.audit-log.filter.from.label")}
                type="text"
                placeholder={i18n.t(
                  "admin.audit-log.filter.datetime.placeholder",
                )}
                pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}"
                value={fromLocal}
                onChange={(next) => {
                  setFromLocal(next);
                  setOffset(0);
                }}
                aria-label={i18n.t("admin.audit-log.filter.from.label")}
              />
              <Input
                id="audit-to"
                label={i18n.t("admin.audit-log.filter.to.label")}
                type="text"
                placeholder={i18n.t(
                  "admin.audit-log.filter.datetime.placeholder",
                )}
                pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}"
                value={toLocal}
                onChange={(next) => {
                  setToLocal(next);
                  setOffset(0);
                }}
                aria-label={i18n.t("admin.audit-log.filter.to.label")}
              />
            </SimpleGrid>
            <SettingsToolbar>
              <Button
                type="button"
                variant="ghost"
                onClick={() => applyPreset(null)}
              >
                {i18n.t("admin.audit-log.filter.preset.today")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => applyPreset(24)}
              >
                {i18n.t("admin.audit-log.filter.preset.last24h")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => applyPreset(24 * 7)}
              >
                {i18n.t("admin.audit-log.filter.preset.last7d")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => applyPreset(24 * 30)}
              >
                {i18n.t("admin.audit-log.filter.preset.last30d")}
              </Button>
              <IconButton
                type="button"
                variant="ghost"
                tooltip={i18n.t("admin.audit-log.filter.reset")}
                onClick={resetFilters}
              >
                <RotateCcw aria-hidden="true" />
              </IconButton>
            </SettingsToolbar>
          </Stack>

          <AuditPaginatedTable
            columns={[
              { key: "time", label: i18n.t("admin.audit-log.col.time") },
              {
                key: "category",
                label: i18n.t("admin.audit-log.col.category"),
              },
              { key: "actor", label: i18n.t("admin.audit-log.col.actor") },
              {
                key: "eventKey",
                label: i18n.t("admin.audit-log.col.eventKey"),
              },
              { key: "target", label: i18n.t("admin.audit-log.col.target") },
              { key: "diff", label: i18n.t("admin.audit-log.col.diff") },
            ]}
            entryCount={entries.length}
            totalCount={totalCount}
            offset={offset}
            pageSize={PAGE_SIZE}
            onOffsetChange={setOffset}
            emptyTitle={i18n.t("admin.audit-log.empty")}
          >
            {entries.map((entry) => (
              <TableRow key={entry.id} onClick={() => setSelectedEntry(entry)}>
                <TableCell mono>
                  {formatAdminDateTime(i18n.language, entry.createdAt)}
                </TableCell>
                <TableCell>
                  <CategoryBadge
                    category={entry.category}
                    label={categoryLabel(entry.category, i18n.t)}
                  />
                </TableCell>
                <TableCell>
                  {entry.actor ? (
                    auditActorLabel(entry.actor, i18n.t)
                  ) : (
                    <SettingsStatusText>
                      {i18n.t("admin.audit-log.systemChange")}
                    </SettingsStatusText>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="link"
                    onClick={() => setSelectedEntry(entry)}
                    title={entry.eventKey}
                    data-testid="audit-event-label"
                    data-event-key={entry.eventKey}
                  >
                    {eventLabel(entry.eventKey, i18n.t)}
                  </Button>
                </TableCell>
                <TableCell>{auditTargetLabel(entry.target, i18n.t)}</TableCell>
                <TableCell>
                  <AuditRowDiffCell entry={entry} />
                </TableCell>
              </TableRow>
            ))}
          </AuditPaginatedTable>
        </Stack>
      </AdminPageScroll>

      <AuditDetailDrawer
        entry={selectedEntry}
        onClose={() => setSelectedEntry(null)}
      />
    </AdminPageFrame>
  );
}

export { AuditLogPage as Component };
