/**
 * Selectable families come from the server-owned Theme DB catalog. Preview
 * fonts use the runtime CSS projection; this control injects no font faces.
 */
import { FormSelect } from "@myoxus/ui-facade";
import { type ReactElement, useId, useMemo } from "react";

import type { ThemeFontFamily } from "../theme/theme-contract";
import {
  findTypographyFontEntry,
  typographyFontEntriesFromCatalog,
  type TypographyFontFamilyEntry,
} from "./api";

export type FontFamilyEntry = TypographyFontFamilyEntry;

export function FontFamilySelect({
  value,
  onChange,
  id,
  disabled,
  filter,
  fontFamilies,
}: {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  disabled?: boolean;
  fontFamilies: readonly ThemeFontFamily[];
  /** Narrows selectable entries without hiding the server's current value. */
  filter?: (entry: FontFamilyEntry) => boolean;
}): ReactElement {
  const reactId = useId();
  const allEntries = useMemo(
    () => typographyFontEntriesFromCatalog(fontFamilies),
    [fontFamilies],
  );
  const entries = filter ? allEntries.filter(filter) : allEntries;
  const selected = findTypographyFontEntry(allEntries, value);
  const selectedName = selected?.name ?? value;
  const data = entries.map((entry) => ({
    value: entry.name,
    label: entry.name,
    disabled: false,
  }));
  if (!entries.some((entry) => entry.name === selectedName)) {
    // Preserve a filtered/retired persisted family for inspection, not selection.
    data.unshift({ value: selectedName, label: selectedName, disabled: true });
  }

  return (
    <FormSelect
      id={id ?? `font-family-${reactId}`}
      value={selectedName}
      disabled={disabled || entries.length === 0}
      searchable
      data={data}
      data-testid="font-family-trigger"
      onChange={onChange}
    />
  );
}
