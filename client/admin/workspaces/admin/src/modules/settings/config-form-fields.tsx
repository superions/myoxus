// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Explicit Admin config form primitives.
 *
 * This module replaces the former generic config form field renderer with named field
 * components. Pages choose the concrete control deliberately; this file only
 * owns repeated config chrome such as copy, YAML-only, restart and validation
 * display.
 */
import { useI18n } from "@myoxus/i18n";
import { InfoIcon } from "@myoxus/icons/react";
import {
  Badge,
  Checkbox,
  ErrorMessage,
  FormSelect,
  Input,
  MultiSelect,
  NumberInput,
  PasswordInput,
  RadioGroup,
  SettingsControlList,
  SettingsField,
  SettingsInlineControl,
  SettingsStatusText,
  SettingsSwitchRow,
  TagsInput,
  Textarea,
} from "@myoxus/ui-facade";
import {
  type JSX,
  type Ref,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type ConfigControlType =
  | "String"
  | "Number"
  | "Boolean"
  | "JSON"
  | "Color"
  | "Enum"
  | "RadioSelect"
  | "CheckboxGroup"
  | "Array";

export type ConfigFieldBaseProps = {
  field: string;
  label?: string;
  desc?: string;
  defaultValue: unknown;
  onChange: (field: string, value: unknown) => void;
  disabled?: boolean;
  error?: string;
  onErrorChange?: (field: string, error?: string) => void;
  databaseWritable?: boolean;
  /** Effective source provenance shown independently from write policy. */
  provenance?: string;
  restartRequired?: boolean;
  /** Server-derived lifecycle feedback stays with its consuming control. */
  feedback?: ReactNode;
  suppressYamlBanner?: boolean;
  inline?: boolean;
};

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MASKED_CONFIG_VALUE = "***REDACTED***";

function isValidHexColor(value: string) {
  return HEX_COLOR_PATTERN.test(value.trim());
}

function splitConfigCopy(copy: string): {
  title: string;
  description?: string;
} {
  const trimmed = copy.trim();
  if (!trimmed) return { title: "" };

  // Do not split abbreviated examples such as "z. B." or "e. g." into labels.
  const sentenceBoundary = /(?<=[\p{L}\p{N}]{3})[.!?]\s+(?=[A-ZÄÖÜÀ-Ý])/u.exec(
    trimmed,
  );
  if (!sentenceBoundary?.index) return { title: trimmed };

  const titleEnd = sentenceBoundary.index + 1;
  const title = trimmed.slice(0, titleEnd).trim();
  const description = trimmed.slice(titleEnd).trim();
  return description ? { title, description } : { title };
}

function humanizeConfigFieldPath(field: string): string {
  const key = field.split("/").at(-1) ?? field;
  const words = key
    .replace(/[._-]+/gu, " ")
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .trim();
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : field;
}

function resolveConfigCopyPart(
  raw: string | null | undefined,
  i18n: ReturnType<typeof useI18n>,
): string | undefined {
  if (!raw) return undefined;
  return raw.startsWith("admin.") || raw.startsWith("com.myoxus.")
    ? i18n.t(raw)
    : raw;
}

export function buildConfigFieldCopy({
  label,
  desc,
  field,
  i18n,
}: {
  label?: string;
  desc?: string;
  field: string;
  i18n: ReturnType<typeof useI18n>;
}): {
  title: string;
  description?: string;
} {
  const resolvedLabel = resolveConfigCopyPart(label, i18n);
  const resolvedDesc = resolveConfigCopyPart(desc, i18n);

  if (resolvedLabel) {
    const description =
      resolvedDesc && resolvedDesc !== resolvedLabel ? resolvedDesc : undefined;
    return { title: resolvedLabel, description };
  }

  return splitConfigCopy(resolvedDesc ?? humanizeConfigFieldPath(field));
}

export function YamlOnlyBanner(): JSX.Element {
  const i18n = useI18n();
  return (
    <SettingsStatusText>
      <InfoIcon aria-hidden />
      {i18n.t("admin.config.yaml_only_desc")}
    </SettingsStatusText>
  );
}

function useConfigFieldChrome({
  field,
  label,
  desc,
  error,
  onErrorChange,
  databaseWritable,
  disabled,
}: ConfigFieldBaseProps) {
  const i18n = useI18n();
  const copy = buildConfigFieldCopy({ label, desc, field, i18n });
  const [validationError, setValidationError] = useState<string>();
  const mergedError = error ?? validationError;

  useEffect(() => {
    onErrorChange?.(field, mergedError);
    return () => {
      onErrorChange?.(field, undefined);
    };
  }, [field, mergedError, onErrorChange]);

  return {
    i18n,
    copy,
    mergedError,
    setValidationError,
    isYamlOnly: databaseWritable === false,
    resolvedDisabled: Boolean(disabled || databaseWritable === false),
  };
}

function FieldFrame({
  field,
  copy,
  inline,
  disabled,
  restartRequired,
  isYamlOnly,
  suppressYamlBanner,
  provenance,
  feedback,
  error,
  children,
}: {
  field: string;
  copy: { title: string; description?: string };
  inline?: boolean;
  disabled?: boolean;
  restartRequired?: boolean;
  isYamlOnly?: boolean;
  suppressYamlBanner?: boolean;
  provenance?: string;
  feedback?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  const i18n = useI18n();
  const label = (
    <>
      {copy.title}
      {restartRequired ? (
        <Badge tone="warning">{i18n.t("admin.config.restart_required")}</Badge>
      ) : null}
    </>
  );

  return (
    <SettingsField
      label={label}
      description={copy.description}
      inline={inline}
      disabled={disabled}
      data-testid={`config-field-${field}`}
    >
      {children}
      {feedback}
      {isYamlOnly && !suppressYamlBanner ? <YamlOnlyBanner /> : null}
      {!isYamlOnly && disabled && provenance ? (
        <SettingsStatusText>
          <InfoIcon aria-hidden />
          {i18n.t("admin.config.provenance.read-only", {
            source: provenance,
          })}
        </SettingsStatusText>
      ) : null}
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
    </SettingsField>
  );
}

export function ConfigTextField({
  maxLength,
  pattern,
  placeholder,
  sensitive,
  protectedInputRef,
  ...props
}: ConfigFieldBaseProps & {
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  sensitive?: boolean;
  /** Uncontrolled protected input: read through this ref only on submission. */
  protectedInputRef?: Ref<HTMLInputElement>;
}) {
  const {
    i18n,
    copy,
    mergedError,
    setValidationError,
    isYamlOnly,
    resolvedDisabled,
  } = useConfigFieldChrome(props);

  const validate = useCallback(
    (value: string) => {
      if (maxLength !== undefined && value.length > maxLength) {
        return i18n.t("admin.config.validation.maxLength", { max: maxLength });
      }
      if (pattern && value.length > 0) {
        try {
          if (!new RegExp(pattern).test(value)) {
            return i18n.t("admin.config.validation.pattern", { pattern });
          }
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    [i18n, maxLength, pattern],
  );

  const handleChange = (value: string) => {
    setValidationError(validate(value));
    props.onChange(props.field, value);
  };

  const Control = sensitive ? PasswordInput : Input;
  const masked = sensitive && props.defaultValue === MASKED_CONFIG_VALUE;

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      inline={props.inline ?? false}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      error={mergedError}
    >
      <Control
        // These credentials configure a service; browser login autofill must not edit them.
        autoComplete={sensitive ? "new-password" : "off"}
        aria-label={copy.title}
        {...(sensitive && protectedInputRef
          ? { ref: protectedInputRef, defaultValue: "" }
          : {
              value:
                masked ||
                props.defaultValue === undefined ||
                props.defaultValue === null
                  ? ""
                  : String(props.defaultValue),
            })}
        placeholder={
          masked
            ? i18n.t("admin.config.sensitive.configuredPlaceholder")
            : placeholder
        }
        disabled={resolvedDisabled}
        status={mergedError ? "error" : "default"}
        onChange={handleChange}
      />
    </FieldFrame>
  );
}

export function ConfigNumberField({
  suffix,
  min,
  max,
  placeholder,
  ...props
}: ConfigFieldBaseProps & {
  suffix?: string;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  const {
    i18n,
    copy,
    mergedError,
    setValidationError,
    isYamlOnly,
    resolvedDisabled,
  } = useConfigFieldChrome(props);

  const validate = useCallback(
    (value: number | undefined) => {
      if (value === undefined) return undefined;
      if (min !== undefined && value < min) {
        return i18n.t("admin.config.validation.minValue", { min });
      }
      if (max !== undefined && value > max) {
        return i18n.t("admin.config.validation.maxValue", { max });
      }
      return undefined;
    },
    [i18n, max, min],
  );

  const handleChange = (next: string | number) => {
    const rawParsed = next === "" ? undefined : Number(next);
    const parsed =
      rawParsed !== undefined && Number.isNaN(rawParsed)
        ? undefined
        : rawParsed;
    setValidationError(validate(parsed));
    props.onChange(props.field, parsed);
  };

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      inline={props.inline ?? false}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      feedback={props.feedback}
      error={mergedError}
    >
      <NumberInput
        aria-label={copy.title}
        value={
          typeof props.defaultValue === "number" ||
          typeof props.defaultValue === "string"
            ? props.defaultValue
            : ""
        }
        placeholder={placeholder}
        disabled={resolvedDisabled}
        error={Boolean(mergedError)}
        min={min}
        max={max}
        clampBehavior="none"
        suffix={suffix ? ` ${suffix}` : undefined}
        onChange={handleChange}
      />
    </FieldFrame>
  );
}

export function ConfigBooleanField({
  immediateApply,
  onSave,
  ...props
}: ConfigFieldBaseProps & {
  immediateApply?: boolean;
  onSave?: (field: string, value: boolean) => Promise<void>;
}) {
  const { i18n, copy, mergedError, isYamlOnly, resolvedDisabled } =
    useConfigFieldChrome(props);
  const immediateSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    return () => {
      if (immediateSaveTimerRef.current) {
        clearTimeout(immediateSaveTimerRef.current);
      }
    };
  }, []);

  const handleChange = (checked: boolean) => {
    props.onChange(props.field, checked);
    if (!immediateApply || !onSave) return;
    if (immediateSaveTimerRef.current) {
      clearTimeout(immediateSaveTimerRef.current);
    }
    immediateSaveTimerRef.current = setTimeout(() => {
      onSave(props.field, checked).catch((err) => {
        console.error("Failed to save config:", err);
      });
    }, 300);
  };

  return (
    <div data-testid={`config-field-${props.field}`}>
      <SettingsSwitchRow
        rowTestId={`config-switch-row-${props.field}`}
        label={
          <>
            {copy.title}
            {props.restartRequired ? (
              <Badge tone="warning">
                {i18n.t("admin.config.restart_required")}
              </Badge>
            ) : null}
          </>
        }
        description={copy.description}
        checked={Boolean(props.defaultValue)}
        disabled={resolvedDisabled}
        separated
        aria-label={copy.title}
        onChange={handleChange}
      />
      {isYamlOnly && !props.suppressYamlBanner ? <YamlOnlyBanner /> : null}
      {mergedError ? <ErrorMessage>{mergedError}</ErrorMessage> : null}
    </div>
  );
}

export function ConfigJsonField(props: ConfigFieldBaseProps) {
  const {
    i18n,
    copy,
    mergedError,
    setValidationError,
    isYamlOnly,
    resolvedDisabled,
  } = useConfigFieldChrome(props);
  const fallbackText = useMemo(
    () =>
      typeof props.defaultValue === "string"
        ? props.defaultValue
        : JSON.stringify(props.defaultValue ?? null),
    [props.defaultValue],
  );
  const [text, setText] = useState(fallbackText);

  useEffect(() => {
    setText(fallbackText);
  }, [fallbackText]);

  const handleChange = (nextText: string) => {
    setText(nextText);
    try {
      const value = JSON.parse(nextText);
      setValidationError(undefined);
      props.onChange(props.field, value);
    } catch {
      setValidationError(i18n.t("admin.config.validation.invalidJson"));
      props.onChange(props.field, nextText);
    }
  };

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      error={mergedError}
    >
      <Textarea
        aria-label={copy.title}
        value={text}
        disabled={resolvedDisabled}
        onChange={handleChange}
        error={mergedError ? true : undefined}
      />
    </FieldFrame>
  );
}

export function ConfigSelectField({
  options,
  labels,
  placeholder,
  ...props
}: ConfigFieldBaseProps & {
  options: string[];
  labels?: Record<string, string>;
  placeholder?: string;
}) {
  const { i18n, copy, mergedError, isYamlOnly, resolvedDisabled } =
    useConfigFieldChrome(props);
  const data = options.map((option) => {
    const raw = labels?.[option] ?? option;
    return {
      value: option,
      label:
        raw.startsWith("admin.") || raw.startsWith("com.myoxus.")
          ? i18n.t(raw)
          : raw,
    };
  });

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      inline={props.inline ?? false}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      error={mergedError}
    >
      <FormSelect
        aria-label={copy.title}
        value={
          typeof props.defaultValue === "string"
            ? props.defaultValue
            : undefined
        }
        disabled={resolvedDisabled}
        placeholder={placeholder ?? i18n.t("admin.config.input.select-option")}
        data={data}
        onChange={(value) => props.onChange(props.field, value)}
      />
    </FieldFrame>
  );
}

export function ConfigMultiSelectField({
  options,
  labels,
  placeholder,
  ...props
}: ConfigFieldBaseProps & {
  options: string[];
  labels?: Record<string, string>;
  placeholder?: string;
}) {
  const { i18n, copy, mergedError, isYamlOnly, resolvedDisabled } =
    useConfigFieldChrome(props);
  const value = Array.isArray(props.defaultValue)
    ? props.defaultValue.map(String)
    : [];
  const data = options.map((option) => {
    const raw = labels?.[option] ?? option;
    return {
      value: option,
      label:
        raw.startsWith("admin.") || raw.startsWith("com.myoxus.")
          ? i18n.t(raw)
          : raw,
    };
  });

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      error={mergedError}
    >
      <MultiSelect
        aria-label={copy.title}
        value={value}
        disabled={resolvedDisabled}
        controlMaxWidth="100%"
        placeholder={placeholder ?? i18n.t("admin.config.input.select-option")}
        data={data}
        onChange={(next) => props.onChange(props.field, next)}
      />
    </FieldFrame>
  );
}

function parseArrayItems(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to comma split.
    }
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function ConfigArrayField(props: ConfigFieldBaseProps) {
  const { field, onChange } = props;
  const { i18n, copy, mergedError, isYamlOnly, resolvedDisabled } =
    useConfigFieldChrome(props);
  const [items, setItems] = useState<string[]>(() =>
    parseArrayItems(props.defaultValue),
  );
  useEffect(() => {
    setItems(parseArrayItems(props.defaultValue));
  }, [props.defaultValue]);

  const commit = useCallback(
    (next: string[]) => {
      setItems(next);
      onChange(field, next);
    },
    [field, onChange],
  );

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      error={mergedError}
    >
      <TagsInput
        aria-label={copy.title}
        value={items}
        disabled={resolvedDisabled}
        error={Boolean(mergedError)}
        placeholder={i18n.t("admin.config.input.add-item")}
        isDuplicate={(candidate, values) => values.includes(candidate)}
        onChange={commit}
      />
    </FieldFrame>
  );
}

export function ConfigCheckboxGroupField({
  options,
  labels,
  ...props
}: ConfigFieldBaseProps & {
  options: string[];
  labels?: Record<string, string>;
}) {
  const { copy, mergedError, isYamlOnly, resolvedDisabled } =
    useConfigFieldChrome(props);
  const selected = Array.isArray(props.defaultValue)
    ? props.defaultValue.map(String)
    : [];

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      error={mergedError}
    >
      <SettingsControlList role="group" aria-label={copy.title}>
        {options.map((option) => (
          <Checkbox
            key={option}
            checked={selected.includes(option)}
            disabled={resolvedDisabled}
            label={labels?.[option] ?? option}
            onChange={(_event, checked) => {
              props.onChange(
                props.field,
                checked
                  ? [...selected, option]
                  : selected.filter((value) => value !== option),
              );
            }}
          />
        ))}
      </SettingsControlList>
    </FieldFrame>
  );
}

export function ConfigRadioSelectField({
  options,
  labels,
  ...props
}: ConfigFieldBaseProps & {
  options: string[];
  labels?: Record<string, string>;
}) {
  const { copy, mergedError, isYamlOnly, resolvedDisabled } =
    useConfigFieldChrome(props);
  const current = Array.isArray(props.defaultValue)
    ? String(props.defaultValue[0])
    : typeof props.defaultValue === "string"
      ? props.defaultValue
      : undefined;

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      error={mergedError}
    >
      <SettingsControlList role="group" aria-label={copy.title}>
        <RadioGroup
          value={current}
          disabled={resolvedDisabled}
          onChange={(value) => props.onChange(props.field, value)}
          items={options.map((option) => ({
            value: option,
            label: labels?.[option] ?? option,
            disabled: resolvedDisabled,
          }))}
        />
      </SettingsControlList>
    </FieldFrame>
  );
}

export function ConfigColorField({
  fallbackColor,
  ...props
}: ConfigFieldBaseProps & { fallbackColor?: string }) {
  const {
    i18n,
    copy,
    mergedError,
    setValidationError,
    isYamlOnly,
    resolvedDisabled,
  } = useConfigFieldChrome(props);
  const fallbackText =
    typeof props.defaultValue === "string"
      ? props.defaultValue
      : (fallbackColor ?? "");
  const [text, setText] = useState(fallbackText);

  useEffect(() => {
    setText(fallbackText);
    setValidationError(undefined);
  }, [fallbackText, setValidationError]);

  const pickerValue = useMemo(() => {
    if (isValidHexColor(text)) return text;
    if (fallbackColor && isValidHexColor(fallbackColor)) return fallbackColor;
    return null;
  }, [fallbackColor, text]);

  const handleTextChange = (next: string) => {
    setText(next);
    if (isValidHexColor(next)) {
      setValidationError(undefined);
      props.onChange(props.field, next);
    } else {
      setValidationError(i18n.t("admin.config.validation.invalidColor"));
      props.onChange(props.field, next);
    }
  };

  return (
    <FieldFrame
      field={props.field}
      copy={copy}
      inline={props.inline ?? true}
      disabled={resolvedDisabled}
      restartRequired={props.restartRequired}
      isYamlOnly={isYamlOnly}
      suppressYamlBanner={props.suppressYamlBanner}
      provenance={props.provenance}
      error={mergedError}
    >
      <SettingsInlineControl>
        {pickerValue ? (
          <Input
            aria-label={i18n.t("admin.config.input.color-picker")}
            type="color"
            value={pickerValue}
            disabled={resolvedDisabled}
            status={mergedError ? "error" : "default"}
            onChange={(next) => {
              setText(next);
              setValidationError(undefined);
              props.onChange(props.field, next);
            }}
          />
        ) : null}
        <Input
          aria-label={copy.title}
          type="text"
          value={text}
          disabled={resolvedDisabled}
          placeholder={i18n.t("admin.config.input.color-placeholder")}
          status={mergedError ? "error" : "default"}
          onChange={handleTextChange}
        />
      </SettingsInlineControl>
    </FieldFrame>
  );
}
