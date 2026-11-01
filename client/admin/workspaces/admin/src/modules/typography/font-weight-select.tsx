/**
 * Admin role control - FontWeightSelect.
 *
 * Renders the available numeric weights for a given family in a native select.
 * The list of weights is projected from the server-owned Theme DB font catalog,
 * so operators only see weights backed by catalogued font assets.
 */
import { FormSelect } from "@myoxus/ui-facade";
import { type ReactElement, useMemo } from "react";

import type { ThemeFontFamily } from "../theme/theme-contract";
import {
  findTypographyFontEntry,
  typographyFontEntriesFromCatalog,
  WEIGHT_LABELS,
} from "./api";

export function FontWeightSelect({
  family,
  value,
  onChange,
  disabled = false,
  fontFamilies,
  id,
}: {
  family: string;
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  fontFamilies: readonly ThemeFontFamily[];
  id?: string;
}): ReactElement {
  const availableWeights = useMemo(() => {
    const entries = typographyFontEntriesFromCatalog(fontFamilies);
    return findTypographyFontEntry(entries, family)?.weights ?? [];
  }, [family, fontFamilies]);

  const data = availableWeights.map((weight) => ({
    value: String(weight),
    label: `${weight} ${WEIGHT_LABELS[weight] ?? ""}`.trim(),
    disabled: false,
  }));
  if (!availableWeights.includes(value)) {
    // Changing family must not invent a weight or hide the current draft.
    data.unshift({
      value: String(value),
      label: `${value} ${WEIGHT_LABELS[value] ?? ""}`.trim(),
      disabled: true,
    });
  }

  return (
    <FormSelect
      id={id}
      data-testid="font-weight-select"
      value={String(value)}
      disabled={disabled || availableWeights.length === 0}
      data={data}
      onChange={(next) => {
        if (next !== null) onChange(Number(next));
      }}
    />
  );
}
