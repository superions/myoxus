/**
 * @vitest-environment node
 */
/**
 * Static guard against duplicate action strings in admin.<modul>.* keys.
 *
 * Invariants:
 *   inv_p_ar_0_i18n_vocab_no_module_duplicates_actions
 *     — No `admin.<modul>.*` key may end in one of the verbs reserved for the
 *       generic `admin.actions.*` vocabulary (P-AR-0-i18n-vocab). When a
 *       module needs e.g. a "Save" button, it MUST reuse `admin.actions.save`
 *       instead of declaring its own `admin.<modul>.save`.
 *
 *   inv_p_ar_0_i18n_vocab_no_module_duplicates_state
 *     — Same rule for `admin.state.*` (loading/empty/error/…).
 *
 *   inv_p_ar_0_i18n_vocab_no_module_duplicates_confirm
 *     — Rule for the unambiguous compound tokens of `admin.confirm.*`
 *       (`action-irreversible`, `delete-confirm`). The plain tokens
 *       `title`/`yes`/`no` are intentionally excluded from this check because
 *       they collide with semantically different module usage (page titles,
 *       boolean badges) — these are governed by the modul-specific naming
 *       convention from § 8.1.
 *
 *   inv_p_ar_0_i18n_vocab_generic_keys_present
 *     — Smoke check that the 27 generic keys themselves exist in en.json.
 *
 * Rationale: the redesigned admin frontend (admin-redesign-concept § 8) has a
 * single shared vocabulary of generic actions, states, and confirm prompts.
 * Module-local re-declarations cause translation drift across locales and
 * break the design system's microcopy invariants.
 *
 * If you legitimately need a module-specific variant, add the offending key
 * to the WHITELIST below with a one-line justification. The initial
 * WHITELIST captures the pre-redesign baseline; entries are removed as the
 * migration packages (P-AR-2-11/13/3-01) replace them with the generic vocab.
 */
import { describe, expect, test } from "vitest";

const BASE = "../../../i18n/src/resources";

async function loadEnLocale(): Promise<Record<string, string>> {
  const m = await import(`${BASE}/en.json`);
  return (m.default ?? m) as Record<string, string>;
}

// Generic vocabulary tokens — last segment of admin.actions.*, admin.state.*,
// admin.confirm.*. Kept in sync with P-AR-0-i18n-vocab manually (a runtime
// re-derivation would mask drift).
const ACTION_TOKENS = [
  "save",
  "cancel",
  "delete",
  "delete-confirm",
  "edit",
  "create",
  "search",
  "reset",
  "apply",
  "discard",
  "copy",
  "export",
  "import",
  "refresh",
] as const;

const STATE_TOKENS = [
  "unsaved-changes",
  "saved",
  "required-field",
  "loading",
  "empty",
  "no-results",
  "error",
  "success",
  "processing",
] as const;

// Only unambiguous compound tokens — `title`/`yes`/`no` are excluded because
// page titles and boolean badges legitimately use them outside confirm
// dialogs (see file-header rationale). `delete-confirm` belongs to
// ACTION_TOKENS above (lives at admin.actions.delete-confirm).
const CONFIRM_TOKENS = ["action-irreversible"] as const;

// Hardcoded list of all 27 generic keys defined by P-AR-0-i18n-vocab —
// used by the presence smoke check.
const REQUIRED_GENERIC_KEYS = [
  "admin.actions.apply",
  "admin.actions.cancel",
  "admin.actions.copy",
  "admin.actions.create",
  "admin.actions.delete",
  "admin.actions.delete-confirm",
  "admin.actions.discard",
  "admin.actions.edit",
  "admin.actions.export",
  "admin.actions.import",
  "admin.actions.refresh",
  "admin.actions.reset",
  "admin.actions.save",
  "admin.actions.search",
  "admin.state.empty",
  "admin.state.error",
  "admin.state.loading",
  "admin.state.no-results",
  "admin.state.processing",
  "admin.state.required-field",
  "admin.state.saved",
  "admin.state.success",
  "admin.state.unsaved-changes",
  "admin.confirm.action-irreversible",
  "admin.confirm.no",
  "admin.confirm.title",
  "admin.confirm.yes",
] as const;

/**
 * Whitelist of module-specific keys that legitimately re-use a generic token,
 * or that are pre-redesign legacy keys awaiting migration.
 *
 * Categories:
 *   - admin.common.*                — legacy generic block, superseded by the
 *                                     new admin.actions / admin.state /
 *                                     admin.confirm namespaces (migrated in
 *                                     P-AR-2-11).
 *   - module legacy save/saved/etc. — replaced as each module is redesigned
 *                                     (P-AR-2-11/13/3-01).
 *   - module-local *.action.{verb}  — labels with contextual nuance (kept as
 *                                     legitimate overrides for now).
 *
 * Add a new entry only with a one-line justification. Removing entries as
 * migration progresses is encouraged and required by P-AR-2-11/13/3-01.
 */
const WHITELIST: ReadonlySet<string> = new Set<string>([
  // Legacy admin.common.* block — superseded by admin.actions.*/state.*
  // (P-AR-2-11 will delete these once all call-sites are migrated).
  "admin.common.cancel",
  "admin.common.create",
  "admin.common.delete",
  "admin.common.discard",
  "admin.common.edit",
  "admin.common.loading",
  "admin.common.no-results",
  "admin.common.refresh",
  "admin.common.save",
  "admin.common.search",
  // Shared empty-state copy has domain nuance beyond generic admin.state.empty.
  "admin.shared.feature-toggle.empty",
  // Pre-redesign module-specific action/state strings — migrated module by
  // module in P-AR-2-11 (accounts/organization), P-AR-2-13 (workspaces),
  // P-AR-3-01 (templates/pdf/documents/...).
  "admin.accounts.export",
  "admin.accounts.import",
  "admin.accounts.notify.saved",
  "admin.accounts.table.status.processing",
  "admin.accounts.table.status.success",
  "admin.audit-log.detail.copy",
  "admin.audit-log.empty",
  "admin.audit-log.filter.reset",
  "admin.config.saved",
  "admin.dashboard.refresh",
  "admin.dashboard.status.error",
  "admin.dashboard.status.success",
  "admin.design.color.reset",
  "admin.documents.metadata-fields.empty",
  "admin.documents.audit.empty",
  "admin.documents.loading",
  "admin.documents.status.empty",
  "admin.documents.types.empty",
  "admin.documents.value-lists.empty",
  "admin.documents.versioning.empty",
  "admin.git-sync.profiles.status.success",
  "admin.git-sync.ssh-host-keys.delete",
  "admin.git-sync.ssh-host-keys.empty",
  "admin.logging.reset",
  "admin.organization.export.refresh",
  "admin.organization.import.apply",
  "admin.organization.overview.loading",
  "admin.organization.overview.reset",
  "admin.organization.overview.save",
  "admin.organization.overview.saved",
  "admin.organization.policy.loading",
  "admin.organization.policy.save",
  "admin.organization.policy.saved",
  "admin.organization.units.create",
  "admin.organization.unit-types.create",
  "admin.pdf-brand.colors.saved",
  "admin.pdf-brand.logo.delete-confirm",
  "admin.pdf-brand.text.saved",
  "admin.pdf-export.action.delete",
  "admin.pdf-export.assignment.search",
  "admin.pdf-export.delete.success",
  "admin.pdf-export.detail.tab.edit",
  "admin.pdf-export.edit.success",
  "admin.pdf-export.filter.reset",
  "admin.pdf-export.filter.search",
  "admin.pdf-export.jobs.empty",
  "admin.pdf-export.list.empty",
  "admin.pdf-export.settings.empty",
  "admin.pdf-export.upload.success",
  "admin.pdf-fonts.action.delete",
  "admin.pdf-fonts.approve.success",
  "admin.pdf-fonts.delete.success",
  "admin.pdf-fonts.filter.reset",
  "admin.pdf-fonts.filter.search",
  "admin.pdf-fonts.list.empty",
  "admin.pdf-fonts.reject.success",
  "admin.pdf-fonts.upload.success",
  "admin.pdf-icc.action.delete",
  "admin.pdf-icc.delete.success",
  "admin.pdf-icc.list.empty",
  "admin.pdf-icc.upload.success",
  "admin.pdf-jobs.action.cancel",
  "admin.pdf-jobs.action.refresh",
  "admin.pdf-jobs.cancel.success",
  "admin.pdf-jobs.detail.error",
  "admin.pdf-settings.doc-versioning.save",
  "admin.pdf-settings.doc-versioning.workspace.save",
  "admin.pdf-settings.global.reset",
  "admin.pdf-settings.global.save",
  "admin.pdf-settings.workspace.save",
  "admin.queue.detail.table.error",
  "admin.queue.refresh",
  "admin.system.metrics.categories.empty",
  "admin.system.metrics.live.loading",
  "admin.system.telemetry.categories.empty",
  "admin.system.telemetry.live.loading",
  "admin.templates.action.assign.success",
  "admin.templates.action.export",
  "admin.templates.action.export.success",
  "admin.templates.action.publish.success",
  "admin.templates.action.remove.success",
  "admin.templates.archive.empty",
  "admin.templates.badge.error",
  "admin.templates.badge.import",
  "admin.templates.catalog.filter.no-results",
  "admin.templates.default-policies.col.apply",
  "admin.templates.default-policies.empty",
  "admin.templates.default-policies.toast.saved",
  "admin.templates.import.toast.success",
  "admin.templates.jobs.empty",
  "admin.templates.jobs.refresh",
  "admin.templates.tab.import",
  "admin.templates.versions.export",
  "admin.workspace.delete",
  "admin.workspaces.actions.edit",
  "admin.workspaces.edit",
  "admin.workspaces.orphaned-page.delete",
  "admin.configChanges.empty",
  "admin.templates.action.driftScan.success",
  // Confirms that a template update was applied, not the generic Success state.
  "admin.templates.assignments.manual-update.success",
  // Reports the actual number of imported guide children, rather than a generic state.
  "admin.templates.import.package.success",
  // Confirms creation of another ordinary reader copy, preserving earlier copies.
  "admin.templates.assignments.guide-copy.success",
  // Uploads and applies a TLS file; this is more specific than generic Apply.
  "admin.security.tls.apply",
  // Reports completed file I/O with a required restart-status check, not Saved.
  "admin.security.tls.saved",
]);

interface Violation {
  key: string;
  reservedToken: string;
  reservedNamespace: "actions" | "state" | "confirm";
}

function findViolations(
  keys: string[],
  tokens: readonly string[],
  reservedNamespace: "actions" | "state" | "confirm",
): Violation[] {
  const tokenSet = new Set(tokens);
  const violations: Violation[] = [];
  for (const key of keys) {
    if (!key.startsWith("admin.")) continue;
    // Skip generic keys themselves
    if (
      key.startsWith("admin.actions.") ||
      key.startsWith("admin.state.") ||
      key.startsWith("admin.confirm.")
    ) {
      continue;
    }
    if (WHITELIST.has(key)) continue;
    const lastSegment = key.split(".").pop()!;
    if (tokenSet.has(lastSegment)) {
      violations.push({ key, reservedToken: lastSegment, reservedNamespace });
    }
  }
  return violations;
}

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return "";
  return violations
    .slice(0, 10)
    .map(
      (v) =>
        `  - "${v.key}" duplicates admin.${v.reservedNamespace}.${v.reservedToken}`,
    )
    .join("\n");
}

describe("admin i18n — no module-specific duplicates of generic vocab", () => {
  test("inv_p_ar_0_i18n_vocab_no_module_duplicates_actions", async () => {
    const en = await loadEnLocale();
    const violations = findViolations(
      Object.keys(en),
      ACTION_TOKENS,
      "actions",
    );
    expect(
      violations,
      `Found ${violations.length} module-specific keys that duplicate ` +
        `admin.actions.* vocabulary. Reuse the generic key or add to WHITELIST ` +
        `with justification:\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  test("inv_p_ar_0_i18n_vocab_no_module_duplicates_state", async () => {
    const en = await loadEnLocale();
    const violations = findViolations(Object.keys(en), STATE_TOKENS, "state");
    expect(
      violations,
      `Found ${violations.length} module-specific keys that duplicate ` +
        `admin.state.* vocabulary. Reuse the generic key or add to WHITELIST ` +
        `with justification:\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  test("inv_p_ar_0_i18n_vocab_no_module_duplicates_confirm", async () => {
    const en = await loadEnLocale();
    const violations = findViolations(
      Object.keys(en),
      CONFIRM_TOKENS,
      "confirm",
    );
    expect(
      violations,
      `Found ${violations.length} module-specific keys that duplicate ` +
        `admin.confirm.* vocabulary. Reuse the generic key or add to WHITELIST ` +
        `with justification:\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  test("inv_p_ar_0_i18n_vocab_generic_keys_present", async () => {
    const en = await loadEnLocale();
    const missing = REQUIRED_GENERIC_KEYS.filter((k) => !(k in en));
    expect(
      missing,
      `en.json is missing ${missing.length} generic admin keys: ` +
        missing.slice(0, 5).join(", "),
    ).toEqual([]);
    expect(REQUIRED_GENERIC_KEYS.length).toBe(27);
  });
});
