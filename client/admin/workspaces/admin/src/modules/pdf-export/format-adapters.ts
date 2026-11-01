/**
 * @file PDF export module — view-model adapters.
 *
 * Translates raw GraphQL projections into UI-ready view models. The
 * adapters are pure functions: every component receives the same
 * deterministic shape regardless of which backend version surfaced the
 * row. Keep all "what does this enum mean to a human?" logic here, not
 * in components.
 */
import type { PdfTemplateSource } from "./badges";

/**
 * Raw projection of `pdfTemplates` returned by the server. Mirrors the
 * `PdfTemplateAdminType` SimpleObject in
 * `crates/api/src/graphql/pdf_template_admin.rs`.
 */
export interface PdfTemplateRaw {
  id: string;
  slug: string;
  name: string;
  version: string;
  schemaVersion: string;
  manifest: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: string;
  deletedAt: string | null;
}

/**
 * View-model used by the list/detail components. The `description`,
 * `category`, and `capabilities` fields are pulled out of the manifest
 * JSON so render code does not need to peek into a free-form blob.
 */
export interface PdfTemplateViewModel {
  id: string;
  slug: string;
  name: string;
  version: string;
  schemaVersion: string;
  description: string | null;
  category: string | null;
  source: PdfTemplateSource;
  capabilities: Record<string, unknown>;
  provenance: {
    licenseSpdx: string;
    copyrightNotice: string;
    sourceUrl: string;
    sourceRevision: string;
    notice: string | null;
  } | null;
  manifest: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  deletedAt: string | null;
  isDeleted: boolean;
}

const EMPTY_OBJECT: Record<string, unknown> = Object.freeze({});

/**
 * Read a string field from the manifest, defending against missing /
 * non-string values. Returns `null` when the field is absent or not a
 * string — never throws.
 */
function manifestString(
  manifest: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!manifest) return null;
  const value = manifest[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Read the manifest's `capabilities` object, defending against missing /
 * non-object values. Returns a frozen empty object when the field is
 * absent or not an object — never throws.
 */
function manifestCapabilities(
  manifest: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!manifest) return EMPTY_OBJECT;
  const value = manifest["capabilities"];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return EMPTY_OBJECT;
}

function manifestProvenance(
  manifest: Record<string, unknown> | null | undefined,
): PdfTemplateViewModel["provenance"] {
  const value = manifest?.["provenance"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provenance = value as Record<string, unknown>;
  const licenseSpdx = manifestString(provenance, "license_spdx");
  const copyrightNotice = manifestString(provenance, "copyright_notice");
  const sourceUrl = manifestString(provenance, "source_url");
  const sourceRevision = manifestString(provenance, "source_revision");
  if (!licenseSpdx || !copyrightNotice || !sourceUrl || !sourceRevision) {
    return null;
  }
  return {
    licenseSpdx,
    copyrightNotice,
    sourceUrl,
    sourceRevision,
    notice: manifestString(provenance, "notice"),
  };
}

/**
 * Adapt a raw `pdfTemplates` row into the view model used by the list +
 * detail components. Tolerates legacy rows where the manifest may be
 * partial — the adapter never throws and always returns a stable shape.
 */
export function adaptPdfTemplate(raw: PdfTemplateRaw): PdfTemplateViewModel {
  const manifest = (raw.manifest as Record<string, unknown> | null) ?? null;
  const description = manifestString(manifest, "description");
  const category = manifestString(manifest, "category");
  const capabilities = manifestCapabilities(manifest);
  const provenance = manifestProvenance(manifest);
  // System-seeded templates (default, report, letter) carry no createdBy
  // because the seeder runs before any admin user exists. Operator
  // uploads always carry a non-null createdBy.
  const source: PdfTemplateSource = raw.createdBy === null ? "system" : "admin";
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    version: raw.version,
    schemaVersion: raw.schemaVersion,
    description,
    category,
    source,
    capabilities,
    provenance,
    manifest: manifest ?? EMPTY_OBJECT,
    createdBy: raw.createdBy,
    createdAt: raw.createdAt,
    deletedAt: raw.deletedAt,
    isDeleted: raw.deletedAt !== null,
  };
}

/**
 * Lossless view of an uploaded ICC profile.
 */
export interface PdfIccProfileViewModel {
  id: string;
  name: string;
  profileType: "sRGB" | "CMYK";
  sha256: string;
  uploadedBy: string | null;
  uploadedAt: string;
  isSystem: boolean;
}

export function adaptPdfIccProfile(raw: {
  id: string;
  name: string;
  profileType: "sRGB" | "CMYK";
  sha256: string;
  uploadedBy: string | null;
  uploadedAt: string;
}): PdfIccProfileViewModel {
  return {
    id: raw.id,
    name: raw.name,
    profileType: raw.profileType,
    sha256: raw.sha256,
    uploadedBy: raw.uploadedBy,
    uploadedAt: raw.uploadedAt,
    isSystem: raw.uploadedBy === null,
  };
}
