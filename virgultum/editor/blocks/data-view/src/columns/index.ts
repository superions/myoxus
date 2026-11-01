import type { PropertyMetaConfig } from "@virgultum/data-view";
import { propertyPresets } from "@virgultum/data-view/property-presets";

type QueryBlockPropertyMeta = PropertyMetaConfig<string, any, any, any>;

export const queryBlockColumns: QueryBlockPropertyMeta[] = [
  propertyPresets.datePropertyConfig,
  propertyPresets.numberPropertyConfig,
  propertyPresets.progressPropertyConfig,
  propertyPresets.selectPropertyConfig,
  propertyPresets.multiSelectPropertyConfig,
  propertyPresets.checkboxPropertyConfig,
];
export const queryBlockAllColumnMap = Object.fromEntries(
  queryBlockColumns.map((property) => [property.type, property]),
) as Record<string, QueryBlockPropertyMeta>;
