// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared audit-label projection for Admin primary UI.
 *
 * Raw event keys are useful diagnostics, but they should not be the primary
 * label in lists, cards or drawer headers. Keep the key in titles/details and
 * render a localized or humanized label wherever admins scan activity.
 */
export function humanizeAuditToken(token: string) {
  return token
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function humanizeEventKey(eventKey: string) {
  return eventKey
    .split(".")
    .filter(Boolean)
    .map(humanizeAuditToken)
    .join(" · ");
}

export function eventLabel(eventKey: string, t: (key: string) => string) {
  const key = `admin.audit-log.event-key.${eventKey.replaceAll(".", "__")}`;
  const label = t(key);
  return label === key ? humanizeEventKey(eventKey) : label;
}

function shortCredentialId(value: string) {
  return value.length > 18
    ? `${value.slice(0, 8)}...${value.slice(-6)}`
    : value;
}

const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function shortAuditId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

/**
 * Resolve a readable target label for audit log tables.
 * Falls back to a localized target type + shortened ID when the server omits
 * a label or sends a raw UUID as the label.
 */
export function auditTargetLabel(
  target:
    | {
        id: string;
        type: string;
        label?: string | null;
      }
    | null
    | undefined,
  t: (key: string) => string,
  emptyLabel = "-",
) {
  if (!target) return emptyLabel;
  const explicitLabel = target.label?.trim();
  if (explicitLabel && !UUID_LIKE_RE.test(explicitLabel)) return explicitLabel;

  const typeKey = `admin.audit-log.filter.targetType.${target.type}`;
  const typeLabel = t(typeKey);
  const readableType =
    typeLabel === typeKey ? humanizeEventKey(target.type) : typeLabel;
  return `${readableType} · ${shortAuditId(target.id)}`;
}

export function auditActorLabel(
  actor:
    | {
        label?: string | null;
        kind?: string | null;
        credentialType?: string | null;
        credentialId?: string | null;
      }
    | null
    | undefined,
  t: (key: string) => string,
) {
  if (!actor) return t("admin.audit-log.systemChange");

  const base =
    actor.label?.trim() ||
    (actor.kind === "system"
      ? t("admin.audit-log.systemChange")
      : t(`admin.audit-log.actor.kind.${actor.kind || "user"}`));

  if (actor.kind !== "api_key" || !actor.credentialId) {
    return base;
  }

  const credentialTypeKey = `admin.audit-log.filter.targetType.${actor.credentialType || "mcp_api_key"}`;
  const credentialType = t(credentialTypeKey);
  return `${base} · ${credentialType === credentialTypeKey ? "API key" : credentialType} ${shortCredentialId(actor.credentialId)}`;
}
