import { useI18n } from "@myoxus/i18n";
import { Badge } from "@myoxus/ui-facade";

export type TemplateStatus =
  "Active" | "Disabled" | "Archived" | "ACTIVE" | "DISABLED" | "ARCHIVED";
export type TemplateSource = "Bundle" | "Builtin";
export type TemplateRevisionState =
  | "DRAFT"
  | "VALIDATED"
  | "PUBLISHED"
  | "DEPRECATED"
  | "ARCHIVED"
  | "Draft"
  | "Validated"
  | "Published"
  | "Deprecated"
  | "Archived";
export type TemplateSelectionMode =
  "PUBLISHED" | "PINNED_REVISION" | "Published" | "PinnedRevision";
export type TemplateProvisioningMode =
  | "SEED_ONCE"
  | "MANAGED_UNTIL_LOCAL_EDIT"
  | "MANUAL_UPDATE"
  | "SeedOnce"
  | "ManagedUntilLocalEdit"
  | "ManualUpdate";
export type TemplateJobState =
  "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type TemplateJobKind = "IMPORT" | "RECONCILE";
export type TemplateInstanceState =
  "OK" | "UPDATE_AVAILABLE" | "DETACHED" | "RETIRED" | "ERROR";

export function TemplateSourceBadge({
  source,
}: {
  source: TemplateSource | string;
}) {
  const i18n = useI18n();
  if (templateSourceKind(source) === "builtin") {
    return <Badge tone="warning">{templateSourceLabel(i18n, source)}</Badge>;
  }
  return <Badge tone="info">{templateSourceLabel(i18n, source)}</Badge>;
}

type I18nLike = {
  t: (key: string, args?: Record<string, unknown>) => string;
};

type TemplateStatusKind = "active" | "disabled" | "archived" | "unknown";
type TemplateSourceKind = "bundle" | "builtin" | "unknown";
type TemplateRevisionStateKind =
  "draft" | "validated" | "published" | "deprecated" | "archived" | "unknown";
type TemplateSelectionModeKind = "published" | "pinnedRevision" | "unknown";
type TemplateProvisioningModeKind =
  "seedOnce" | "managedUntilLocalEdit" | "manualUpdate" | "unknown";

function normalizedEnumToken(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function templateStatusKind(
  status: string | null | undefined,
): TemplateStatusKind {
  switch (
    String(status ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "active":
      return "active";
    case "disabled":
      return "disabled";
    case "archived":
      return "archived";
    default:
      return "unknown";
  }
}

export function templateSourceKind(
  source: string | null | undefined,
): TemplateSourceKind {
  switch (
    String(source ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "bundle":
      return "bundle";
    case "builtin":
      return "builtin";
    default:
      return "unknown";
  }
}

export function templateRevisionStateKind(
  state: string | null | undefined,
): TemplateRevisionStateKind {
  switch (normalizedEnumToken(state)) {
    case "draft":
      return "draft";
    case "validated":
      return "validated";
    case "published":
      return "published";
    case "deprecated":
      return "deprecated";
    case "archived":
      return "archived";
    default:
      return "unknown";
  }
}

export function templateSelectionModeKind(
  mode: string | null | undefined,
): TemplateSelectionModeKind {
  switch (normalizedEnumToken(mode)) {
    case "published":
      return "published";
    case "pinned_revision":
      return "pinnedRevision";
    default:
      return "unknown";
  }
}

export function templateProvisioningModeKind(
  mode: string | null | undefined,
): TemplateProvisioningModeKind {
  switch (normalizedEnumToken(mode)) {
    case "seed_once":
      return "seedOnce";
    case "managed_until_local_edit":
      return "managedUntilLocalEdit";
    case "manual_update":
      return "manualUpdate";
    default:
      return "unknown";
  }
}

export function templateStatusLabel(
  i18n: I18nLike,
  status: string | null | undefined,
) {
  switch (templateStatusKind(status)) {
    case "active":
      return i18n.t("admin.templates.badge.active");
    case "disabled":
      return i18n.t("admin.common.disabled");
    case "archived":
      return i18n.t("admin.templates.badge.archived");
    default:
      return String(status ?? "\u2014");
  }
}

export function templateSourceLabel(
  i18n: I18nLike,
  source: string | null | undefined,
) {
  switch (templateSourceKind(source)) {
    case "builtin":
      return i18n.t("admin.templates.source.builtin");
    case "bundle":
      return i18n.t("admin.templates.source.bundle");
    default:
      return String(source ?? "\u2014");
  }
}

export function templateSelectionModeLabel(
  i18n: I18nLike,
  mode: string | null | undefined,
) {
  switch (templateSelectionModeKind(mode)) {
    case "published":
      return i18n.t("admin.templates.badge.published");
    case "pinnedRevision":
      return i18n.t("admin.templates.badge.pinned");
    default:
      return String(mode ?? "\u2014");
  }
}

export function templateProvisioningModeLabel(
  i18n: I18nLike,
  mode: string | null | undefined,
) {
  switch (templateProvisioningModeKind(mode)) {
    case "seedOnce":
      return i18n.t("admin.templates.badge.seed-once");
    case "managedUntilLocalEdit":
      return i18n.t("admin.templates.badge.managed");
    case "manualUpdate":
      return i18n.t("admin.templates.badge.manual");
    default:
      return String(mode ?? "\u2014");
  }
}

export function TemplateStatusBadge({
  status,
}: {
  status: TemplateStatus | string;
}) {
  const i18n = useI18n();
  switch (templateStatusKind(status)) {
    case "active":
      return <Badge tone="success">{templateStatusLabel(i18n, status)}</Badge>;
    case "disabled":
      return <Badge tone="error">{templateStatusLabel(i18n, status)}</Badge>;
    case "archived":
      return <Badge tone="neutral">{templateStatusLabel(i18n, status)}</Badge>;
    default:
      return <Badge tone="neutral">{status}</Badge>;
  }
}

export function TemplateRevisionStateBadge({
  state,
}: {
  state: TemplateRevisionState;
}) {
  const i18n = useI18n();
  switch (templateRevisionStateKind(state)) {
    case "published":
      return (
        <Badge tone="success">
          {i18n.t("admin.templates.badge.published")}
        </Badge>
      );
    case "validated":
      return (
        <Badge tone="info">{i18n.t("admin.templates.badge.validated")}</Badge>
      );
    case "draft":
      return (
        <Badge tone="warning">{i18n.t("admin.templates.badge.draft")}</Badge>
      );
    case "deprecated":
      return (
        <Badge tone="error">{i18n.t("admin.templates.badge.deprecated")}</Badge>
      );
    case "archived":
      return (
        <Badge tone="neutral">{i18n.t("admin.templates.badge.archived")}</Badge>
      );
    default:
      return <Badge tone="neutral">{state}</Badge>;
  }
}

export function TemplateSelectionModeBadge({
  mode,
}: {
  mode: TemplateSelectionMode | string;
}) {
  const i18n = useI18n();
  switch (templateSelectionModeKind(mode)) {
    case "published":
      return (
        <Badge tone="success">{templateSelectionModeLabel(i18n, mode)}</Badge>
      );
    case "pinnedRevision":
      return (
        <Badge tone="warning">{templateSelectionModeLabel(i18n, mode)}</Badge>
      );
    default:
      return <Badge tone="neutral">{mode}</Badge>;
  }
}

export function TemplateProvisioningModeBadge({
  mode,
}: {
  mode: TemplateProvisioningMode | string;
}) {
  const i18n = useI18n();
  switch (templateProvisioningModeKind(mode)) {
    case "seedOnce":
      return (
        <Badge tone="info">{templateProvisioningModeLabel(i18n, mode)}</Badge>
      );
    case "managedUntilLocalEdit":
      return (
        <Badge tone="success">
          {templateProvisioningModeLabel(i18n, mode)}
        </Badge>
      );
    case "manualUpdate":
      return (
        <Badge tone="warning">
          {templateProvisioningModeLabel(i18n, mode)}
        </Badge>
      );
    default:
      return <Badge tone="neutral">{mode}</Badge>;
  }
}

export function TemplateEnabledBadge({ enabled }: { enabled: boolean }) {
  const i18n = useI18n();
  return enabled ? (
    <Badge tone="success">{i18n.t("admin.templates.badge.yes")}</Badge>
  ) : (
    <Badge tone="error">{i18n.t("admin.templates.badge.no")}</Badge>
  );
}

export function TemplateJobStateBadge({ state }: { state: TemplateJobState }) {
  const i18n = useI18n();
  switch (state) {
    case "COMPLETED":
      return (
        <Badge tone="success">
          {i18n.t("admin.templates.badge.completed")}
        </Badge>
      );
    case "RUNNING":
      return (
        <Badge tone="info">{i18n.t("admin.templates.badge.running")}</Badge>
      );
    case "PENDING":
      return (
        <Badge tone="warning">{i18n.t("admin.templates.badge.pending")}</Badge>
      );
    case "FAILED":
      return (
        <Badge tone="error">{i18n.t("admin.templates.badge.failed")}</Badge>
      );
    case "CANCELLED":
      return (
        <Badge tone="neutral">
          {i18n.t("admin.templates.badge.cancelled")}
        </Badge>
      );
    default:
      return <Badge tone="neutral">{state}</Badge>;
  }
}

export function TemplateJobKindBadge({ kind }: { kind: TemplateJobKind }) {
  const i18n = useI18n();
  return kind === "IMPORT" ? (
    <Badge tone="info">{i18n.t("admin.templates.badge.import")}</Badge>
  ) : (
    <Badge tone="warning">{i18n.t("admin.templates.badge.reconcile")}</Badge>
  );
}

export function TemplateInstanceStateBadge({
  state,
}: {
  state: TemplateInstanceState | string;
}) {
  const i18n = useI18n();
  switch (state) {
    case "OK":
      return <Badge tone="success">{i18n.t("admin.templates.badge.ok")}</Badge>;
    case "UPDATE_AVAILABLE":
      return (
        <Badge tone="info">
          {i18n.t("admin.templates.badge.update-available")}
        </Badge>
      );
    case "DETACHED":
      return (
        <Badge tone="neutral">{i18n.t("admin.templates.badge.detached")}</Badge>
      );
    case "RETIRED":
      return (
        <Badge tone="neutral">{i18n.t("admin.templates.badge.retired")}</Badge>
      );
    case "ERROR":
      return (
        <Badge tone="error">{i18n.t("admin.templates.badge.error")}</Badge>
      );
    default:
      return <Badge tone="neutral">{state}</Badge>;
  }
}
