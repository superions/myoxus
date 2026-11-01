import { Select } from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useMemo } from "react";

interface DropdownItem<V extends string> {
  label?: ReactNode;
  value: V;
  testId?: string;
  [key: string]: unknown;
}
export interface SettingDropdownSelectProps<
  V extends string,
  E extends boolean | undefined,
> {
  "aria-label"?: string;
  "data-testid"?: string;
  className?: string;
  disabled?: boolean;
  options?: Array<DropdownItem<V>>;
  value?: V;
  onChange?: (
    v: E extends true ? DropdownItem<V>["value"] : DropdownItem<V>,
  ) => void;
  emitValue?: E;
}

export const SettingDropdownSelect = <
  V extends string = string,
  E extends boolean | undefined = true,
>({
  options = [],
  value,
  emitValue = true,
  onChange,
  "aria-label": ariaLabel,
  "data-testid": dataTestId,
  className,
  disabled,
}: SettingDropdownSelectProps<V, E>) => {
  const selectData = useMemo(
    () =>
      options.map((option) => ({
        value: option.value,
        label:
          typeof option.label === "string"
            ? option.label
            : String(option.value),
      })),
    [options],
  );

  const handleChange = useCallback(
    (nextValue: string) => {
      const opt = options.find((option) => option.value === nextValue);
      if (emitValue) {
        onChange?.(nextValue as any);
      } else {
        onChange?.(opt as any);
      }
    },
    [emitValue, onChange, options],
  );

  return (
    <Select
      aria-label={ariaLabel}
      data-testid={dataTestId ?? "dropdown-select-trigger"}
      className={className}
      disabled={disabled}
      value={value}
      data={selectData}
      onChange={handleChange}
      block
      data-myoxus-ui-role="mobile-setting-select"
    />
  );
};
