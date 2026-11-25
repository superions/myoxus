// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared config-field dispatcher for Admin configuration pages
 * (Performance, Security, AI, System, Queue).
 *
 * Maps a resolved schema/descriptor control type to the concrete Facade-backed
 * field primitive in `./config-form-fields` while preserving native disclosure
 * draft state (`useAppConfig`) and sensitive `new-password` autofill guards.
 */
import type { ReactNode } from "react";

import {
  ConfigArrayField,
  ConfigBooleanField,
  ConfigCheckboxGroupField,
  ConfigColorField,
  type ConfigControlType,
  ConfigJsonField,
  ConfigMultiSelectField,
  ConfigNumberField,
  ConfigRadioSelectField,
  ConfigSelectField,
  ConfigTextField,
} from "./config-form-fields";

export type AdminConfigFieldDispatcherProps = {
  field: string;
  type: ConfigControlType;
  label?: string;
  desc?: string;
  defaultValue: unknown;
  onChange: (path: string, value: unknown) => void;
  databaseWritable?: boolean;
  restartRequired?: boolean;
  suppressYamlBanner?: boolean;
  error?: string;
  onErrorChange?: (field: string, error?: string) => void;
  sensitive?: boolean;
  immediateApply?: boolean;
  onSave?: (field: string, value: unknown) => Promise<void>;
  suffix?: string;
  min?: number;
  max?: number;
  feedback?: ReactNode;
  options?: string[];
  labels?: Record<string, string>;
};

export function AdminConfigFieldDispatcher({
  field,
  type,
  label,
  desc = "",
  defaultValue,
  onChange,
  databaseWritable,
  restartRequired,
  suppressYamlBanner,
  error,
  onErrorChange,
  sensitive,
  immediateApply,
  onSave,
  suffix,
  min,
  max,
  feedback,
  options,
  labels,
}: AdminConfigFieldDispatcherProps) {
  const commonProps = {
    field,
    label,
    desc,
    defaultValue,
    onChange,
    databaseWritable,
    restartRequired,
    suppressYamlBanner,
    error,
    onErrorChange,
  };

  switch (type) {
    case "Boolean":
      return (
        <ConfigBooleanField
          {...commonProps}
          immediateApply={Boolean(immediateApply)}
          onSave={immediateApply ? onSave : undefined}
        />
      );
    case "Number":
      return (
        <ConfigNumberField
          {...commonProps}
          suffix={suffix}
          min={min}
          max={max}
          feedback={feedback}
        />
      );
    case "Enum":
      return (
        <ConfigSelectField
          {...commonProps}
          options={options ?? []}
          labels={labels}
        />
      );
    case "RadioSelect":
      return (
        <ConfigRadioSelectField
          {...commonProps}
          options={options ?? []}
          labels={labels}
        />
      );
    case "CheckboxGroup":
      return (
        <ConfigCheckboxGroupField
          {...commonProps}
          options={options ?? []}
          labels={labels}
        />
      );
    case "Array":
      if (options?.length) {
        return (
          <ConfigMultiSelectField
            {...commonProps}
            options={options}
            labels={labels}
          />
        );
      }
      return <ConfigArrayField {...commonProps} />;
    case "JSON":
      return <ConfigJsonField {...commonProps} />;
    case "Color":
      return <ConfigColorField {...commonProps} />;
    case "String":
    default:
      return <ConfigTextField {...commonProps} sensitive={sensitive} />;
  }
}
