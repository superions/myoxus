import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useMemo } from "react";

import { type RadioItem, SettingsRow, SettingsSection } from "../../primitives";
import { EditorRadioGroup } from "./menu";

export const Page = () => {
  const t = useI18n();
  const editorSetting = useService(EditorSettingService).editorSetting;
  const settings = useLiveData(editorSetting.settings$);

  const radioItems = useMemo<RadioItem[]>(
    () => [
      {
        value: "standard",
        label:
          t[
            "com.myoxus.settings.editorSettings.page.default-page-width.standard"
          ](),
        testId: "standard-width-trigger",
      },
      {
        value: "fullWidth",
        label:
          t[
            "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
          ](),
        testId: "full-width-trigger",
      },
    ],
    [t],
  );

  const handleFullWidthLayoutChange = useCallback(
    (value: string) => {
      const checked = value === "fullWidth";
      editorSetting.set("fullWidthLayout", checked);
    },
    [editorSetting],
  );
  return (
    <SettingsSection
      title={t["com.myoxus.settings.editorSettings.page.full-width.title"]()}
      description={t[
        "com.myoxus.settings.editorSettings.page.full-width.description"
      ]()}
      testId="editor-settings-section-page"
    >
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.page.default-page-width.title"
        ]()}
        desc={t[
          "com.myoxus.settings.editorSettings.page.default-page-width.description"
        ]()}
      >
        <EditorRadioGroup
          items={radioItems}
          value={settings.fullWidthLayout ? "fullWidth" : "standard"}
          onChange={handleFullWidthLayoutChange}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
