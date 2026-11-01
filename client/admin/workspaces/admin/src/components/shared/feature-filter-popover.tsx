// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FeatureType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Checkbox,
  FieldLabel,
  Popover,
  PopoverContent,
  PopoverTarget,
  SettingsControlList,
  SettingsControlRow,
  SettingsToolbar,
} from "@myoxus/ui-facade";

export function FeatureFilterPopover({
  selectedFeatures,
  availableFeatures,
  onChange,
  buttonLabel,
  disabled = false,
}: {
  selectedFeatures: FeatureType[];
  availableFeatures: FeatureType[];
  onChange: (features: FeatureType[]) => void;
  buttonLabel?: string;
  disabled?: boolean;
}) {
  const i18n = useI18n();
  const label =
    buttonLabel ?? i18n.t("admin.organization.members.filter.feature");
  const triggerLabel = selectedFeatures.length
    ? `${label} (${selectedFeatures.length})`
    : label;

  return (
    <Popover opened={disabled ? false : undefined} position="bottom-start">
      <PopoverTarget>
        <Button variant="secondary" disabled={disabled}>
          {triggerLabel}
        </Button>
      </PopoverTarget>
      <PopoverContent>
        <SettingsControlList>
          <FieldLabel>{i18n.t("admin.shared.feature-filter.title")}</FieldLabel>
          {availableFeatures.map((feature) => {
            const selected = selectedFeatures.includes(feature);
            return (
              <SettingsControlRow
                key={feature}
                label={feature}
                title={feature}
                control={
                  <Checkbox
                    aria-label={feature}
                    checked={selected}
                    disabled={disabled}
                    onChange={(_, checked) =>
                      onChange(
                        checked
                          ? Array.from(new Set([...selectedFeatures, feature]))
                          : selectedFeatures.filter(
                              (candidate) => candidate !== feature,
                            ),
                      )
                    }
                  />
                }
              />
            );
          })}
        </SettingsControlList>
        <SettingsToolbar>
          <Button
            variant="plain"
            disabled={disabled || selectedFeatures.length === 0}
            onClick={() => onChange([])}
          >
            {i18n.t("admin.actions.clear")}
          </Button>
        </SettingsToolbar>
      </PopoverContent>
    </Popover>
  );
}
