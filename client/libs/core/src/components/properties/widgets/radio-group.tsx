import { RadioGroup, type RadioProps } from "@myoxus/ui-facade";

export const PropertyRadioGroup = ({
  items,
  value,
  onChange,
  disabled,
}: Pick<RadioProps, "items" | "value" | "onChange" | "disabled" | "width">) => {
  return (
    <RadioGroup
      block
      value={value}
      onChange={onChange}
      items={items}
      disabled={disabled}
    />
  );
};
