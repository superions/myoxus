import { getThemeOptions } from "@myoxus/core/desktop/dialogs/setting/general-setting/appearance";
import { useI18n } from "@myoxus/i18n";
import {
  type MyoxusThemeMode,
  useMyoxusTheme,
} from "@myoxus/ui-facade/provider";
import { useMemo } from "react";

import { SettingDropdownSelect } from "../dropdown-select";
import { RowLayout } from "../row.layout";

export const ThemeSetting = () => {
  const t = useI18n();

  const options = useMemo(() => getThemeOptions(t), [t]);
  const { setTheme, theme } = useMyoxusTheme();

  return (
    <RowLayout label={t["com.myoxus.mobile.setting.appearance.theme"]()}>
      <SettingDropdownSelect
        options={options}
        value={theme}
        onChange={(value) => setTheme(value as MyoxusThemeMode)}
      />
    </RowLayout>
  );
};
