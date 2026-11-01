import { useI18n } from "@myoxus/i18n";

import { Button, SettingsRow, SettingsSection } from "../../primitives";

export const Preferences = () => {
  const t = useI18n();
  return (
    <SettingsSection
      title={t["com.myoxus.settings.editorSettings.preferences"]()}
    >
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.preferences.export.title"
        ]()}
        desc={t[
          "com.myoxus.settings.editorSettings.preferences.export.description"
        ]()}
      >
        <Button>
          {t["com.myoxus.settings.editorSettings.preferences.export.action"]()}
        </Button>
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.preferences.import.title"
        ]()}
        desc={t[
          "com.myoxus.settings.editorSettings.preferences.import.description"
        ]()}
      >
        <Button>
          {t["com.myoxus.settings.editorSettings.preferences.import.action"]()}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
};
