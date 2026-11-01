/**
 * Per-category diff cell renderer for audit log entries.
 *
 * User-category entries automatically redact sensitive fields
 * (passwordHash) before rendering, so credentials never appear
 * in plain text in the admin UI.
 */
import type { AdminAuditLogEntryType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  Group,
  MonoText,
  SettingsStatusText,
  Stack,
} from "@myoxus/ui-facade";

import { redactAuditValue } from "./audit-json-diff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function JsonValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <SettingsStatusText>null</SettingsStatusText>;
  }
  if (typeof value === "string") {
    return <MonoText>{value}</MonoText>;
  }
  return <MonoText>{JSON.stringify(value, null, 2)}</MonoText>;
}

function fieldSummary(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>).sort();
}

function humanizeFieldName(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function fieldLabel(field: string, t: (key: string) => string): string {
  const key = `admin.audit-log.field.${field}`;
  const label = t(key);
  return label === key ? humanizeFieldName(field) : label;
}

function valueKind(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") {
    const keys = fieldSummary(value);
    return keys.length === 0 ? "object" : `object(${keys.length})`;
  }
  return String(value);
}

function SummaryValue({
  value,
  t,
}: {
  value: unknown;
  t: (key: string) => string;
}) {
  const fields = fieldSummary(value);
  if (fields.length === 0) {
    return (
      <SettingsStatusText tone="active">{valueKind(value)}</SettingsStatusText>
    );
  }

  return (
    <Group align="center" wrap="wrap">
      {fields.slice(0, 4).map((field) => (
        <Badge key={field} tone="neutral">
          {fieldLabel(field, t)}
        </Badge>
      ))}
      {fields.length > 4 ? (
        <SettingsStatusText>+{fields.length - 4}</SettingsStatusText>
      ) : null}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Category-aware diff cell. Renders oldValue / newValue for any category
 * and additionally redacts sensitive fields for user-category entries.
 */
export function AuditRowDiffCell({
  entry,
  mode = "summary",
}: {
  entry: Pick<AdminAuditLogEntryType, "category" | "oldValue" | "newValue">;
  /**
   * Audit table rows must stay scannable. The full redacted JSON belongs to the
   * detail drawer; inline mode is reserved for unit tests or narrow diagnostic
   * surfaces that explicitly need the old verbose renderer.
   */
  mode?: "summary" | "inline";
}) {
  const i18n = useI18n();
  const isUser = entry.category === "user";

  const oldVal = isUser ? redactAuditValue(entry.oldValue) : entry.oldValue;
  const newVal = isUser ? redactAuditValue(entry.newValue) : entry.newValue;

  if (oldVal === null && newVal === null) {
    return <SettingsStatusText>—</SettingsStatusText>;
  }

  if (mode === "summary") {
    return (
      <Stack>
        {oldVal !== null && (
          <Group align="center" wrap="wrap">
            <SettingsStatusText>
              {i18n.t("admin.audit-log.diff.old")}
            </SettingsStatusText>
            <SummaryValue value={oldVal} t={i18n.t} />
          </Group>
        )}
        {newVal !== null && (
          <Group align="center" wrap="wrap">
            <SettingsStatusText>
              {i18n.t("admin.audit-log.diff.new")}
            </SettingsStatusText>
            <SummaryValue value={newVal} t={i18n.t} />
          </Group>
        )}
      </Stack>
    );
  }

  return (
    <Stack>
      {oldVal !== null && (
        <Group align="center" wrap="wrap">
          <SettingsStatusText>
            {i18n.t("admin.audit-log.diff.old")}
          </SettingsStatusText>
          <JsonValue value={oldVal} />
        </Group>
      )}
      {newVal !== null && (
        <Group align="center" wrap="wrap">
          <SettingsStatusText>
            {i18n.t("admin.audit-log.diff.new")}
          </SettingsStatusText>
          <JsonValue value={newVal} />
        </Group>
      )}
    </Stack>
  );
}
