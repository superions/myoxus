import type { I18n } from "@myoxus/core/modules/i18n";
import type { UserPreferencesService } from "@myoxus/core/modules/server";
import type { useI18n } from "@myoxus/i18n";
import { SettingsIcon } from "@myoxus/icons/react";
import { track } from "@myoxus/track";

import { registerMyoxusCommand } from "./registry";

export function registerMyoxusLanguageCommands({
  i18n,
  t,
  userPreferencesService,
}: {
  i18n: I18n;
  t: ReturnType<typeof useI18n>;
  userPreferencesService: UserPreferencesService;
}) {
  // Display Language
  const disposables = i18n.languageList.map((language) => {
    return registerMyoxusCommand({
      id: `affine:change-display-language-to-${language.name}`,
      label: `${t["com.myoxus.cmdk.display-language.to"]()} ${
        language.originalName
      }`,
      category: "myoxus:settings",
      icon: <SettingsIcon />,
      preconditionStrategy: () =>
        i18n.currentLanguage$.value.key !== language.key,
      run() {
        track.$.cmdk.settings.changeAppSetting({
          key: "language",
          value: language.name,
        });

        i18n.changeLanguage(language.key);
        void userPreferencesService.update({ locale: language.key });
      },
    });
  });

  return () => {
    disposables.forEach((dispose) => dispose());
  };
}
