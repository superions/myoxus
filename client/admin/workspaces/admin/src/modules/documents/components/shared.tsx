import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  Button,
  Input,
  Select,
  SettingsEmptyState,
  SettingsStatusText,
  SettingsSwitchRow,
  SettingsToolbar,
  Textarea,
} from "@myoxus/ui-facade";
import type { GraphQLError } from "graphql";
import type { ReactNode } from "react";

export function asJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

export function parseJsonField(value: string, fallback: unknown = {}) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed);
}

export function fieldError(error: GraphQLError | undefined, field: string) {
  const extensions = error?.extensions as
    | { fieldErrors?: Record<string, string>; fields?: Record<string, string> }
    | undefined;
  return (
    extensions?.fieldErrors?.[field] ?? extensions?.fields?.[field] ?? null
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <SettingsStatusText role="alert" tone="error">
      {children}
    </SettingsStatusText>
  );
}

export function EmptyState({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: string;
}) {
  return <SettingsEmptyState title={children} description={hint} />;
}

export function KeyBadge({ value }: { value: string }) {
  return <Badge>{value}</Badge>;
}

export function BooleanStatus({ value }: { value: boolean }) {
  const i18n = useI18n();
  return (
    <Badge tone={value ? "success" : "neutral"}>
      {i18n.t(value ? "admin.common.yes" : "admin.common.no")}
    </Badge>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  disabled,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Input
      id={id}
      label={label}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={onChange}
      error={error}
    />
  );
}

export function SelectField({
  id,
  label,
  value,
  values,
  optionLabels,
  onChange,
  error,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  values: string[];
  optionLabels?: Record<string, string>;
  onChange: (value: string) => void;
  error?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Select
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      data={values.map((item) => ({
        value: item,
        label: optionLabels?.[item] ?? item,
      }))}
      block
      error={error}
      disabled={disabled}
    />
  );
}

export function BooleanField({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsSwitchRow
      label={label}
      checked={checked}
      disabled={disabled}
      onChange={onCheckedChange}
      separated
    />
  );
}

export function JsonField({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: ReactNode;
}) {
  return (
    <Textarea
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      spellCheck={false}
      error={error}
    />
  );
}

export function FormActions({
  dirty,
  saving,
  onReset,
  saveTestId,
  canSave = true,
}: {
  dirty: boolean;
  saving?: boolean;
  onReset: () => void;
  saveTestId?: string;
  canSave?: boolean;
}) {
  const i18n = useI18n();
  return (
    <SettingsToolbar>
      <Button
        type="button"
        variant="plain"
        disabled={!dirty || saving}
        onClick={onReset}
      >
        {i18n.t("admin.actions.reset")}
      </Button>
      <Button
        type="submit"
        variant="primary"
        disabled={!dirty || saving || !canSave}
        data-testid={saveTestId}
      >
        {saving ? i18n.t("admin.common.saving") : i18n.t("admin.common.save")}
      </Button>
    </SettingsToolbar>
  );
}
