// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared contract for the active organization-unit type catalog.
 *
 * The database intentionally seeds every preset package. The active catalog is
 * only an authoring filter stored in `organization.metadata.unit_type_catalog`;
 * it never deletes, deactivates or migrates server-side preset rows.
 */

export const UNIT_TYPE_CATALOG_METADATA_KEY = "unit_type_catalog";

export const UNIT_TYPE_CATALOGS = [
  {
    id: "all",
    prefix: null,
    tone: "neutral",
    nameKey: "admin.organization.unit-types.catalog.all.name",
    descriptionKey: "admin.organization.unit-types.catalog.all.desc",
  },
  {
    id: "default",
    prefix: "",
    tone: "warning",
    nameKey: "admin.organization.unit-types.package.default.name",
    descriptionKey: "admin.organization.unit-types.package.default.desc",
  },
  {
    id: "kvg",
    prefix: "kvg.",
    tone: "info",
    nameKey: "admin.organization.unit-types.package.large-municipal.name",
    descriptionKey:
      "admin.organization.unit-types.package.large-municipal.desc",
  },
  {
    id: "kvk",
    prefix: "kvk.",
    tone: "success",
    nameKey: "admin.organization.unit-types.package.small-municipal.name",
    descriptionKey:
      "admin.organization.unit-types.package.small-municipal.desc",
  },
  {
    id: "wt",
    prefix: "wt.",
    tone: "warning",
    nameKey: "admin.organization.unit-types.package.business-deep.name",
    descriptionKey: "admin.organization.unit-types.package.business-deep.desc",
  },
  {
    id: "mx",
    prefix: "mx.",
    tone: "error",
    nameKey: "admin.organization.unit-types.package.matrix.name",
    descriptionKey: "admin.organization.unit-types.package.matrix.desc",
  },
] as const;

export type UnitTypeCatalogId = (typeof UNIT_TYPE_CATALOGS)[number]["id"];

export type UnitTypeCatalogSelection = {
  schema_version: 1;
  id: UnitTypeCatalogId;
  updated_at?: string;
};

type UnitTypeLike = {
  id: string;
  key: string;
  isActive: boolean;
  isPreset: boolean;
};

const KNOWN_PRESET_PREFIXES = UNIT_TYPE_CATALOGS.flatMap((catalog) =>
  catalog.prefix ? [catalog.prefix] : [],
);

export const DEFAULT_UNIT_TYPE_CATALOG_SELECTION: UnitTypeCatalogSelection = {
  schema_version: 1,
  id: "all",
};

export function unitTypeCatalogById(id: UnitTypeCatalogId) {
  return UNIT_TYPE_CATALOGS.find((catalog) => catalog.id === id);
}

export function normalizeUnitTypeCatalogId(value: unknown): UnitTypeCatalogId {
  return UNIT_TYPE_CATALOGS.some((catalog) => catalog.id === value)
    ? (value as UnitTypeCatalogId)
    : DEFAULT_UNIT_TYPE_CATALOG_SELECTION.id;
}

export function getUnitTypeCatalogSelection(
  metadata: unknown,
): UnitTypeCatalogSelection {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return DEFAULT_UNIT_TYPE_CATALOG_SELECTION;
  }
  const raw = (metadata as Record<string, unknown>)[
    UNIT_TYPE_CATALOG_METADATA_KEY
  ];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_UNIT_TYPE_CATALOG_SELECTION;
  }

  const id = normalizeUnitTypeCatalogId(
    (raw as Record<string, unknown>).id ??
      // Accept earlier review drafts while normalizing writes to `id`.
      (raw as Record<string, unknown>).package,
  );
  return {
    schema_version: 1,
    id,
    updated_at:
      typeof (raw as Record<string, unknown>).updated_at === "string"
        ? ((raw as Record<string, unknown>).updated_at as string)
        : undefined,
  };
}

export function withUnitTypeCatalogSelection(
  metadata: unknown,
  id: UnitTypeCatalogId,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  return {
    ...base,
    [UNIT_TYPE_CATALOG_METADATA_KEY]: {
      schema_version: 1,
      id,
      updated_at: new Date().toISOString(),
    } satisfies UnitTypeCatalogSelection,
  };
}

export function catalogIdForUnitTypeKey(key: string): UnitTypeCatalogId {
  const prefixed = UNIT_TYPE_CATALOGS.find(
    (catalog) => catalog.prefix && key.startsWith(catalog.prefix),
  );
  if (prefixed) return prefixed.id;
  // A preset without a known package prefix belongs to the generic default
  // catalog seeded by 0107.
  return "default";
}

export function isDefaultCatalogTypeKey(key: string) {
  return !KNOWN_PRESET_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isTypeVisibleForCatalog(
  type: UnitTypeLike,
  selection: UnitTypeCatalogSelection,
) {
  if (!type.isActive) return false;
  if (selection.id === "all") return true;
  if (!type.isPreset) return false;
  const catalog = unitTypeCatalogById(selection.id);
  if (!catalog) return true;
  if (catalog.prefix === "") return isDefaultCatalogTypeKey(type.key);
  return !!catalog.prefix && type.key.startsWith(catalog.prefix);
}

export function filterUnitTypesForAuthoring<T extends UnitTypeLike>(
  types: T[],
  selection: UnitTypeCatalogSelection,
  currentTypeId?: string | null,
) {
  const visible = types.filter((type) =>
    isTypeVisibleForCatalog(type, selection),
  );
  if (!currentTypeId || visible.some((type) => type.id === currentTypeId)) {
    return visible;
  }
  const current = types.find((type) => type.id === currentTypeId);
  return current ? [...visible, current] : visible;
}

export function countTypesForCatalog<T extends UnitTypeLike>(
  types: T[],
  id: UnitTypeCatalogId,
) {
  return types.filter((type) =>
    isTypeVisibleForCatalog(type, { schema_version: 1, id }),
  ).length;
}
