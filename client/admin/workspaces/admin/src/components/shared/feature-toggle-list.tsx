// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FeatureType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Checkbox,
  SettingsControlEmpty,
  SettingsControlList,
  SettingsControlRow,
} from "@myoxus/ui-facade";

export function FeatureToggleList({
  features,
  selected,
  onChange,
}: {
  features: FeatureType[];
  selected: FeatureType[];
  onChange: (features: FeatureType[]) => void;
}) {
  const i18n = useI18n();

  if (features.length === 0) {
    return (
      <SettingsControlEmpty>
        {i18n.t("admin.shared.feature-toggle.empty")}
      </SettingsControlEmpty>
    );
  }

  return (
    <SettingsControlList>
      {features.map((feature) => {
        const enabled = selected.includes(feature);
        return (
          <SettingsControlRow
            key={feature}
            label={feature}
            title={feature}
            controlPosition="left"
            control={
              <Checkbox
                aria-label={feature}
                checked={enabled}
                onChange={(_, checked) =>
                  onChange(
                    checked
                      ? Array.from(new Set([...selected, feature]))
                      : selected.filter((candidate) => candidate !== feature),
                  )
                }
              />
            }
          />
        );
      })}
    </SettingsControlList>
  );
}
