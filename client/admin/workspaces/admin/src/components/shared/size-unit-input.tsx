/**
 * SizeUnitInput — a number input with an optional MB/GB unit selector.
 *
 * Props:
 *   value    — current value in MB (from server), or null for empty
 *   onChange — called with new value in MB
 *   allowGb  — when true shows MB/GB dropdown; when false shows plain MB label
 *   disabled — disables both input and select
 */
import { FormSelect, Group, NumberInput } from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

export interface SizeUnitInputProps {
  /** Current value in MB, or null when unset. */
  value: number | null;
  /** Called with the new value in MB whenever the input changes. */
  onChange: (mb: number) => void;
  /** Visible field descriptor used as the programmatic label. */
  ariaLabel?: string;
  /** Programmatic label for the unit picker when GB switching is enabled. */
  unitAriaLabel?: string;
  /**
   * When true, renders a MB/GB dropdown next to the input.
   * Use for large storage values (e.g. max mirror storage).
   * When false (default), renders a plain "MB" label.
   */
  allowGb?: boolean;
  disabled?: boolean;
}

type Unit = "MB" | "GB";

const MB_PER_GB = 1024;

/** Convert MB value to display value in the given unit. */
function toDisplay(mb: number | null, unit: Unit): string {
  if (mb === null) return "";
  if (unit === "GB") return String(mb / MB_PER_GB);
  return String(mb);
}

/** Convert display string + unit to MB. Returns NaN on invalid input. */
function toMb(display: string, unit: Unit): number {
  const n = parseFloat(display);
  if (Number.isNaN(n)) return NaN;
  return unit === "GB" ? n * MB_PER_GB : n;
}

export function SizeUnitInput({
  value,
  onChange,
  ariaLabel,
  unitAriaLabel,
  allowGb = false,
  disabled = false,
}: SizeUnitInputProps) {
  const [{ unit, displayValue }, setInput] = useState(() => ({
    unit: "MB" as Unit,
    displayValue: toDisplay(value, "MB"),
  }));

  // Sync display when value prop changes from outside (e.g. reset).
  // We keep the currently selected unit so the user's display preference is
  // preserved across server roundtrips within the same mount.
  useEffect(() => {
    setInput((current) => ({
      ...current,
      displayValue: toDisplay(value, current.unit),
    }));
  }, [value]);

  const handleInputChange = (input: string | number) => {
    const raw = String(input);
    setInput((current) => ({ ...current, displayValue: raw }));
    const mb = toMb(raw, unit);
    if (Number.isFinite(mb) && mb !== toMb(displayValue, unit)) {
      onChange(mb);
    }
  };

  const handleUnitChange = (nextUnit: Unit) => {
    // Re-derive display value in the new unit from the current MB value.
    const mb = toMb(displayValue, unit);
    setInput({
      unit: nextUnit,
      displayValue: Number.isFinite(mb) ? toDisplay(mb, nextUnit) : "",
    });
  };

  // Mantine formats numbers in a text input; retain the numeric field's
  // accessible spinbutton contract while exposing the displayed unit's value.
  const ariaValueNow =
    displayValue !== "" && Number.isFinite(Number(displayValue))
      ? Number(displayValue)
      : undefined;

  if (!allowGb) {
    return (
      <NumberInput
        role="spinbutton"
        aria-valuenow={ariaValueNow}
        aria-label={ariaLabel}
        value={displayValue}
        disabled={disabled}
        onChange={handleInputChange}
        suffix=" MB"
      />
    );
  }

  return (
    <Group grow wrap="nowrap">
      <NumberInput
        role="spinbutton"
        aria-valuenow={ariaValueNow}
        aria-label={ariaLabel}
        value={displayValue}
        disabled={disabled}
        onChange={handleInputChange}
      />
      <FormSelect
        aria-label={unitAriaLabel}
        value={unit}
        allowDeselect={false}
        onChange={(value) => {
          if (value === "MB" || value === "GB") handleUnitChange(value);
        }}
        disabled={disabled}
        data={[
          { value: "MB", label: "MB" },
          { value: "GB", label: "GB" },
        ]}
      />
    </Group>
  );
}
