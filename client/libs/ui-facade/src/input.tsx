// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type ColorInputProps as MantineColorInputProps,
  type TextareaProps,
  Textarea as MantineTextarea,
  type NumberInputProps,
  NumberInput as MantineNumberInput,
  Text,
  Fieldset as MantineFieldset,
  Stack,
  Box,
  ColorInput as MantineColorInput,
  ColorPicker as MantineColorPicker,
  type ColorPickerProps as MantineColorPickerProps,
  PasswordInput as MantinePasswordInput,
  TextInput,
  type TextInputProps,
} from "@mantine/core";
import {
  type CSSProperties,
  forwardRef,
  type ForwardedRef,
  type ComponentProps,
  type ReactNode,
  type FocusEvent,
  type KeyboardEventHandler,
  useState,
} from "react";
import { cssVar } from "@myoxus/theme";
import { joinClassName } from "./helpers/class-name";
import { type RoleBoxProps } from "./helpers/ui-role";
import { ErrorMessage } from "./feedback";
import { useI18n } from "@myoxus/i18n";

export type MyoxusInputProps = Omit<
  TextInputProps,
  "onChange" | "onBlur" | "size"
> & {
  "data-myoxus-ui-role"?: string;
  [key: `data-${string}`]: unknown;
  onChange?: (value: string) => void;
  onBlur?: (ev: FocusEvent<HTMLInputElement>) => void;
  onEnter?: (value: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  inputStyle?: CSSProperties;
  inputClassName?: string;
  preFix?: ReactNode;
  endFix?: ReactNode;
  status?: "error" | "success" | "warning" | "default";
  size?: "default" | "large" | "extraLarge";
  noBorder?: boolean;
  autoSelect?: boolean;
  debounce?: number;
  mono?: boolean;
  block?: boolean;
};

export function createInputKeyDownHandler(
  onKeyDown: KeyboardEventHandler<HTMLInputElement> | undefined,
  onEnter: ((value: string) => void) | undefined,
): KeyboardEventHandler<HTMLInputElement> {
  return (event) => {
    onKeyDown?.(event);
    if (event.key === "Enter") {
      onEnter?.(event.currentTarget.value);
    }
  };
}

export const Input = forwardRef(function Input(
  {
    "data-myoxus-ui-role": uiRole,
    onChange,
    onEnter,
    onKeyDown,
    inputStyle,
    inputClassName,
    preFix,
    endFix,
    status = "default",
    size = "default",
    noBorder = false,
    autoSelect,
    debounce: _debounce,
    mono = false,
    block = false,
    error,
    style,
    onFocus,
    ...props
  }: MyoxusInputProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  const handleKeyDown = createInputKeyDownHandler(onKeyDown, onEnter);
  return (
    <TextInput
      {...props}
      ref={ref}
      leftSection={preFix}
      rightSection={endFix}
      size={size === "extraLarge" ? "lg" : size === "large" ? "md" : "sm"}
      error={error ?? (status === "error" ? true : undefined)}
      style={{
        width: block ? "100%" : undefined,
        ...style,
      }}
      data-myoxus-ui-role={uiRole ?? "settings-input"}
      classNames={{
        input: inputClassName,
      }}
      onChange={(event) => onChange?.(event.currentTarget.value)}
      onKeyDown={handleKeyDown}
      onFocus={(event) => {
        if (autoSelect) event.currentTarget.select();
        onFocus?.(event);
      }}
      styles={{
        input: {
          width: block ? "100%" : undefined,
          ...(noBorder
            ? {
                background: "transparent",
                borderColor: "transparent",
                boxShadow: "none",
              }
            : null),
          fontFamily: mono ? "var(--mantine-font-family-monospace)" : undefined,
          ...inputStyle,
        },
      }}
    />
  );
});

export const RowInput = Input;
export type RowInputProps = MyoxusInputProps;
export const MyoxusTextInput = Input;
export const SearchInput = Input;

export type MyoxusPasswordInputProps = Omit<
  ComponentProps<typeof MantinePasswordInput>,
  "onChange" | "onBlur" | "size"
> & {
  onChange?: (value: string) => void;
  onEnter?: (value: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  inputStyle?: CSSProperties;
  preFix?: ReactNode;
  endFix?: ReactNode;
  status?: "error" | "success" | "warning" | "default";
  size?: "default" | "large" | "extraLarge";
  noBorder?: boolean;
  autoSelect?: boolean;
  debounce?: number;
};

export const PasswordInput = forwardRef(function PasswordInput(
  {
    onChange,
    onEnter,
    onKeyDown,
    inputStyle,
    preFix,
    endFix,
    status = "default",
    size = "default",
    autoSelect,
    debounce: _debounce,
    onFocus,
    type: _type,
    visible,
    defaultVisible,
    onVisibilityChange,
    visibilityToggleButtonProps,
    error,
    ...props
  }: MyoxusPasswordInputProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  const i18n = useI18n();
  const [internalVisible, setInternalVisible] = useState(
    Boolean(defaultVisible),
  );
  const passwordVisible = visible ?? internalVisible;
  const resolvedError = error ?? status === "error";
  const handleKeyDown = createInputKeyDownHandler(onKeyDown, onEnter);
  const handleVisibilityChange = (next: boolean) => {
    if (visible === undefined) {
      setInternalVisible(next);
    }
    onVisibilityChange?.(next);
  };
  return (
    <MantinePasswordInput
      {...props}
      ref={ref}
      leftSection={preFix}
      rightSection={endFix}
      size={size === "extraLarge" ? "lg" : size === "large" ? "md" : "sm"}
      error={resolvedError}
      aria-invalid={props["aria-invalid"] ?? (resolvedError ? true : undefined)}
      data-myoxus-ui-role="auth-password-input"
      visible={passwordVisible}
      onVisibilityChange={handleVisibilityChange}
      visibilityToggleButtonProps={{
        ...visibilityToggleButtonProps,
        "aria-label": passwordVisible
          ? i18n.t("common.hide")
          : i18n.t("common.show"),
      }}
      onChange={(event) => onChange?.(event.currentTarget.value)}
      onKeyDown={handleKeyDown}
      onFocus={(event) => {
        if (autoSelect) event.currentTarget.select();
        onFocus?.(event);
      }}
      styles={{
        input: inputStyle,
      }}
    />
  );
});

export type PasswordInputProps = MyoxusPasswordInputProps;

/** Native picker for compact color triggers whose value belongs inside the popup. */
export const ColorPicker = forwardRef<HTMLDivElement, MantineColorPickerProps>(
  function ColorPicker(props, ref) {
    return (
      <MantineColorPicker
        {...props}
        ref={ref}
        data-myoxus-ui-role="color-picker"
      />
    );
  },
);

export type ColorInputProps = Omit<
  MyoxusInputProps,
  | "classNames"
  | "defaultValue"
  | "onChange"
  | "styles"
  | "type"
  | "value"
  | "vars"
> & {
  popoverProps?: MantineColorInputProps["popoverProps"];
  format?: MantineColorInputProps["format"];
  swatches?: MantineColorInputProps["swatches"];
  withPicker?: MantineColorInputProps["withPicker"];
  withEyeDropper?: MantineColorInputProps["withEyeDropper"];
  disallowInput?: MantineColorInputProps["disallowInput"];
  onChangeEnd?: MantineColorInputProps["onChangeEnd"];
  allowEmpty?: boolean;
  /** Source-backed fields may preserve native CSS values outside the picker format. */
  fixOnBlur?: boolean;
  defaultValue?: string;
  onChange?: (value: string) => void;
  value?: string;
};

export const ColorInput = forwardRef(function ColorInput(
  {
    allowEmpty = false,
    popoverProps,
    autoSelect,
    block = false,
    debounce: _debounce,
    endFix,
    error,
    fixOnBlur,
    inputClassName,
    inputStyle,
    mono = false,
    noBorder = false,
    onChange,
    onEnter,
    onFocus,
    onKeyDown,
    preFix,
    size = "default",
    status = "default",
    style,
    ...props
  }: ColorInputProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  const handleKeyDown = createInputKeyDownHandler(onKeyDown, onEnter);
  const resolvedSize =
    size === "extraLarge" ? "lg" : size === "large" ? "md" : "sm";
  const [pickerOpened, setPickerOpened] = useState(false);
  const rootStyle = {
    width: block ? "100%" : undefined,
    ...style,
  };
  const sharedInputStyle = {
    ...(block ? { width: "100%" } : null),
    ...(noBorder
      ? {
          background: "transparent",
          borderColor: "transparent",
          boxShadow: "none",
        }
      : null),
    ...(mono ? { fontFamily: "var(--mantine-font-family-monospace)" } : null),
    ...inputStyle,
  };
  const handleFocus = (event: FocusEvent<HTMLInputElement>) => {
    if (autoSelect) event.currentTarget.select();
    onFocus?.(event);
  };
  if (allowEmpty) {
    return (
      <MantineColorInput
        {...props}
        fixOnBlur={fixOnBlur}
        classNames={{ input: inputClassName }}
        data-myoxus-ui-role="form-color-input"
        error={error ?? (status === "error" ? true : undefined)}
        leftSection={preFix}
        onChange={onChange}
        onFocus={(event) => {
          setPickerOpened(!props.readOnly && !props.disabled);
          handleFocus(event);
        }}
        onBlur={(event) => {
          setPickerOpened(false);
          props.onBlur?.(event);
        }}
        onClick={(event) => {
          setPickerOpened(!props.readOnly && !props.disabled);
          props.onClick?.(event);
        }}
        onKeyDown={(event) => {
          // Mantine keeps focus in the input, outside its picker dropdown.
          // Close that child first without dismissing an enclosing editor form.
          if (event.key === "Escape" && pickerOpened) {
            event.preventDefault();
            event.stopPropagation();
            setPickerOpened(false);
          } else handleKeyDown(event);
        }}
        popoverProps={{
          ...popoverProps,
          opened: pickerOpened,
          onChange: (open) => {
            setPickerOpened(open);
            popoverProps?.onChange?.(open);
          },
        }}
        ref={ref}
        rightSection={endFix}
        size={resolvedSize}
        style={rootStyle}
        styles={{ input: sharedInputStyle }}
      />
    );
  }
  return (
    <TextInput
      {...props}
      classNames={{ input: inputClassName }}
      data-myoxus-ui-role="form-color-input"
      error={error ?? (status === "error" ? true : undefined)}
      leftSection={preFix}
      onChange={(event) => onChange?.(event.currentTarget.value)}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      ref={ref}
      rightSection={endFix}
      size={resolvedSize}
      style={rootStyle}
      styles={{
        input: {
          width: "var(--mantine-spacing-xl)",
          height: "var(--mantine-spacing-xl)",
          minHeight: "var(--mantine-spacing-xl)",
          padding: 0,
          border: 0,
          borderRadius: "var(--mantine-radius-sm)",
          background: "transparent",
          cursor: "pointer",
          ...sharedInputStyle,
        },
      }}
      type="color"
    />
  );
});

export type MyoxusTextareaProps = Omit<TextareaProps, "onChange"> & {
  onChange?: (value: string) => void;
  inputStyle?: CSSProperties;
  mono?: boolean;
  presentation?: "caption";
};

// Authored captions keep their document placement, rather than form-control chrome.
const captionInputStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  borderRadius: 0,
  padding: 0,
  minHeight: 0,
  textAlign: "center",
  color: cssVar("iconColor"),
  fontFamily: "inherit",
  fontSize: "var(--myoxus-font-sm)",
  lineHeight: "inherit",
};

export const Textarea = forwardRef(function Textarea(
  {
    onChange,
    inputStyle,
    mono = false,
    presentation,
    ...props
  }: MyoxusTextareaProps,
  ref: ForwardedRef<HTMLTextAreaElement>,
) {
  return (
    <MantineTextarea
      mt={presentation === "caption" ? "xs" : undefined}
      {...props}
      ref={ref}
      data-myoxus-ui-role={mono ? "form-textarea:mono" : "form-textarea"}
      onChange={(event) => onChange?.(event.currentTarget.value)}
      styles={{
        input: {
          color: cssVar("textPrimaryColor"),
          fontFamily: mono ? "var(--mantine-font-family-monospace)" : undefined,
          ...(presentation === "caption" ? captionInputStyle : {}),
          ...inputStyle,
        },
      }}
    />
  );
});

export const MyoxusTextarea = Textarea;

export type MyoxusNumberInputProps = Omit<NumberInputProps, "onChange"> & {
  onChange?: (value: string | number) => void;
};

export const NumberInput = forwardRef(function NumberInput(
  { onChange, classNames, ...props }: MyoxusNumberInputProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  // Mantine NumberInput renders internal stepper buttons; classifying them here
  // keeps visual contracts from treating upstream controls as anonymous raw UI.
  const mergedClassNames =
    typeof classNames === "function"
      ? classNames
      : {
          ...classNames,
          control: joinClassName(
            "myoxus-ui-number-input-control",
            classNames?.control,
          ),
        };

  return (
    <MantineNumberInput
      {...props}
      ref={ref}
      data-myoxus-ui-role="form-number-input"
      classNames={mergedClassNames}
      onChange={(value) => onChange?.(value)}
    />
  );
});

export const MyoxusNumberInput = NumberInput;

export function FieldLabel({
  children,
  className,
  htmlFor,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps & { htmlFor?: string }) {
  return (
    <Text
      component={htmlFor ? "label" : "span"}
      htmlFor={htmlFor}
      className={className}
      data-testid={dataTestId}
      style={{
        color: cssVar("textSecondaryColor"),
        ...style,
      }}
      data-myoxus-ui-role="form-field-label"
    >
      {children}
    </Text>
  );
}

export function FieldError({ children, className, style }: RoleBoxProps) {
  return (
    <ErrorMessage className={className} style={style}>
      {children}
    </ErrorMessage>
  );
}

/**
 * Native Mantine Fieldset for semantically disabling a complete form section.
 * Use `variant="unstyled"` when the fieldset owns behavior only and must not
 * introduce another bordered surface inside an existing Card or panel.
 */
export function FormFieldset(props: ComponentProps<typeof MantineFieldset>) {
  return <MantineFieldset {...props} />;
}

export function FormRow({
  label,
  labelFor,
  error,
  help,
  children,
  className,
  style,
  ...htmlProps
}: RoleBoxProps & {
  label?: ReactNode;
  labelFor?: string;
  error?: ReactNode;
  help?: ReactNode;
}) {
  return (
    <Stack
      {...htmlProps}
      className={className}
      gap={"var(--mantine-spacing-xs)"}
      style={style}
      data-myoxus-ui-role="form-row"
    >
      {label ? <FieldLabel htmlFor={labelFor}>{label}</FieldLabel> : null}
      {children}
      {help ? (
        <Text
          style={{
            color: cssVar("textSecondaryColor"),
          }}
          data-myoxus-ui-role="form-field-help"
        >
          {help}
        </Text>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Stack>
  );
}

export function Label({
  children,
  className,
  style,
  htmlFor,
  leftSection,
  required = false,
  requiredLabel = "required",
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
}: RoleBoxProps & {
  htmlFor?: string;
  leftSection?: ReactNode;
  required?: boolean;
  requiredLabel?: string;
}) {
  return (
    <Box
      component="label"
      htmlFor={htmlFor}
      className={className}
      data-testid={dataTestId}
      style={{
        color: cssVar("textSecondaryColor"),
        ...style,
      }}
      data-myoxus-ui-role={uiRole ?? "form-field-label"}
    >
      {leftSection}
      {children}
      {required ? (
        <Box
          component="span"
          aria-label={requiredLabel}
          style={{
            marginInlineStart: "var(--mantine-spacing-2xs)",
            color: cssVar("errorColor"),
          }}
          data-myoxus-ui-role="form-field-required-mark"
        >
          *
        </Box>
      ) : null}
    </Box>
  );
}
