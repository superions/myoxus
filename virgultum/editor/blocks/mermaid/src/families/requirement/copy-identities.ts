// SPDX-License-Identifier: AGPL-3.0-or-later
import { nextRequirementSourceKey } from "../../engine/requirement/index.js";
import {
  parseMermaidVisualFamilyData,
  serializeMermaidVisualFamilyData,
  createMermaidVisualFamilyData,
} from "../runtime/gfx-family-data.js";
import { requirementRecordBindings } from "./readback.js";

/** Normal whole-owner clipboard keeps Source bytes and owner-local aliases.
 * Only persisted occurrence bindings and their concrete consumers are renewed. */
export function remapCopiedRequirementIdentities(
  _source: string,
  familyData: string,
) {
  const data = parseMermaidVisualFamilyData(familyData);
  if (data?.family !== "requirement") return null;
  const records = requirementRecordBindings({ familyData: data } as Parameters<
    typeof requirementRecordBindings
  >[0]);
  const identityMap = new Map(
    records.map((record) => [record.key, nextRequirementSourceKey()]),
  );
  const remap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remap);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        (key === "sourceKey" || key === "key") && typeof entry === "string"
          ? (identityMap.get(entry) ?? entry)
          : key === "propertyKeys" && entry && typeof entry === "object"
            ? Object.fromEntries(
                Object.entries(entry).map(([property, keys]) => [
                  property,
                  Array.isArray(keys)
                    ? keys.map((key) => identityMap.get(key) ?? key)
                    : keys,
                ]),
              )
            : remap(entry),
      ]),
    );
  };
  const remapData = (value: unknown) => {
    const parsed = parseMermaidVisualFamilyData(value);
    return parsed?.family === "requirement"
      ? serializeMermaidVisualFamilyData(
          createMermaidVisualFamilyData(
            "requirement",
            remap(parsed.payload) as Record<string, unknown>,
          ),
        )
      : value;
  };
  return {
    identityMap,
    familyData: remapData(familyData) as string,
    remapElement: (props: Readonly<Record<string, unknown>>) => {
      const next: Record<string, unknown> = {};
      if (typeof props.mermaidDetailSourceKey === "string")
        next.mermaidDetailSourceKey =
          identityMap.get(props.mermaidDetailSourceKey) ??
          props.mermaidDetailSourceKey;
      for (const key of ["mermaidNodeFamilyData", "mermaidEdgeFamilyData"])
        if (props[key] !== undefined) next[key] = remapData(props[key]);
      return next;
    },
  };
}
