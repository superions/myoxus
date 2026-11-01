import { useI18n } from "@myoxus/i18n";

import { SettingGroup } from "../group";
import { ReadingSizeSetting } from "./reading-size";
import { LanguageSetting } from "./language";
import { ThemeSetting } from "./theme";

export const AppearanceGroup = () => {
  const t = useI18n();
  return (
    <SettingGroup title={t["com.myoxus.mobile.setting.appearance.title"]()}>
      <ThemeSetting />
      <ReadingSizeSetting />
      <LanguageSetting />
    </SettingGroup>
  );
};
