/**
 * Shared helpers for the admin config UI.
 *
 * This module was historically the backing data for a generic "Settings" page
 * that rendered every server config module in a fallback accordion. That page
 * has since been fully replaced by dedicated per-domain pages (Accounts,
 * Git-Sync, Design, Storage, Performance, AI, Queue, System, …), each of
 * which imports `ALL_CONFIG_DESCRIPTORS` directly and renders its own curated
 * field layout.
 *
 * What remains here is:
 *   - `ALL_CONFIG_DESCRIPTORS` — the single source of truth for per-field
 *     display metadata (description/link/suffix), consumed by every
 *     dedicated page.
 *   - `ConfigDisplayMetadata` / `AppConfig` type definitions.
 *   - `MODULES_WITH_DEDICATED_PAGES` — the audit list used by tests and docs
 *     to prove every server module has a visible admin UI.
 *   - `IGNORED_MODULES` — explicit modules that intentionally have no Admin UI.
 *
 * Deployment-agnostic: every module that exists in the server config schema is
 * surfaced in the UI regardless of standalone/cloud. Cloud-only gates would
 * violate the "disabled features always visible" rule (cf. LRN-20260316-133).
 */
import CONFIG_DESCRIPTORS from "../../config.json";
type ConfigDisplayMetadata = {
  desc: string;
  link?: string;
  suffix?: string;
};

/** Config values are server-owned JSON; dedicated admin pages narrow per field. */
export type AppConfigValue = any;
export type AppConfig = Record<string, Record<string, AppConfigValue>>;

export const IGNORED_MODULES: (keyof AppConfig)[] = [];

/**
 * Modules that have their own dedicated admin pages. These are EXCLUDED from
 * the generic Settings page accordion to avoid duplication — they are fully
 * managed elsewhere (each entry lists the destination page as a comment).
 *
 * When you implement a new dedicated config page for a module:
 * 1. Add the module key here so it stops appearing in the Settings fallback accordion.
 * 2. Register the module's route in the admin router.
 * 3. Add a nav entry in `modules/nav/` pointing to the new page.
 *
 * Do NOT add a module here until its dedicated page is actually implemented and
 * reachable. Premature removal from Settings leaves the module's fields
 * inaccessible to operators.
 */
export const MODULES_WITH_DEDICATED_PAGES = new Set([
  "auth", // → Security page
  "oauth", // → Security page (OAuth tab)
  "storage", // → Storage page (Limits tab)
  "git_sync", // → Git Sync page
  "branding", // → Design page
  "cache", // → Performance page
  "http", // → Performance page
  "worker", // → Performance/Queue pages
  "redis", // → Performance page (Doc Cache & Compaction)
  "websocket", // → Performance page (WS Transport)
  "throttle", // → Performance page (Rate Limiting)
  "doc", // → Performance page (Document History)
  "doc_service", // → Performance page (Doc Service)
  "job", // → Queue page (Settings tab)
  "logging", // → Logging page (has its own GraphQL API)
  "templates", // → Templates page (shared template root)
  "template_registry", // → Templates page
  "pdf_export", // → PDF Export page (Settings tab)
  "document_versioning", // → PDF Export page (Settings tab)
  "server", // → System page
  "cors", // → Security page
  "client", // → System page (Frontend)
  "i18n", // → System page (Localization)
  "journal", // → System page (Localization)
  "calendar", // → System page (Localization)
  "crypto", // → System page (Overview)
  "flags", // → System page (Overview)
  "mail", // → System page (Mail/Notification)
  "captcha", // → Security page (Captcha)
  "telemetry", // → System page (Telemetry) — P123-NAV-01
  "metrics", // → System page (Metrics) — P123-NAV-01
  "copilot", // → AI page (Copilot)
  "transcription", // → AI page (Transcription)
  "indexer", // → AI page (Indexer)
  "mcp", // → AI page (MCP)
  "preview", // → Performance page (Previews tab)
]);

/**
 * Flat map of all static config field descriptors, indexed as
 * `ALL_CONFIG_DESCRIPTORS[module][fieldKey]`.
 *
 * These descriptors are compiled from `client/admin/workspaces/admin/src/config.json`
 * and contain only frontend-owned display metadata: translated descriptions,
 * links and suffixes.
 *
 * They are intentionally separate from the server-returned schema
 * (`useAppConfig().schema`), which carries type, bounds, sensitivity, write
 * policy and lifecycle metadata. Always combine both sources.
 *
 * Never use the descriptor as the sole source of truth for field availability —
 * the server schema is authoritative.
 */
export const ALL_CONFIG_DESCRIPTORS = CONFIG_DESCRIPTORS as Record<
  string,
  Record<string, ConfigDisplayMetadata>
>;
