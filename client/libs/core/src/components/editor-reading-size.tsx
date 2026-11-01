// SPDX-License-Identifier: AGPL-3.0-or-later
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { Select } from "@myoxus/ui-facade";

/** Shared account preference control; selecting the theme clears the override. */
export function EditorReadingSizeSelect() {
  const t = useI18n();
  const editorSetting = useService(EditorSettingService).editorSetting;
  const size = useLiveData(editorSetting.settings$.selector((s) => s.fontSize));
  return (
    <Select
      aria-label={t[
        "com.myoxus.settings.editorSettings.general.font-size.title"
      ]()}
      data={[
        {
          value: "theme",
          label:
            t["com.myoxus.settings.editorSettings.general.font-size.theme"](),
        },
        ...Array.from({ length: 13 }, (_, index) => {
          const value = index + 12;
          return { value: String(value), label: `${value} px` };
        }),
      ]}
      value={size === null ? "theme" : String(size)}
      onChange={(value) =>
        editorSetting.set("fontSize", value === "theme" ? null : Number(value))
      }
    />
  );
}
