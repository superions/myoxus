import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { I18nextProvider } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { type PropsWithChildren, useEffect } from "react";

import { I18nService } from "./services/i18n";

export function I18nProvider({ children }: PropsWithChildren) {
  const i18n = useService(I18nService).i18n;
  const { preferences } = useUserPreferences();

  useEffect(() => {
    i18n.init();
  }, [i18n]);

  useEffect(() => {
    const locale = preferences?.effectiveValues.locale;
    if (locale && locale !== i18n.currentLanguageKey$.value) {
      i18n.changeLanguage(locale);
    }
  }, [i18n, preferences?.effectiveValues.locale]);

  return <I18nextProvider i18n={i18n.i18next}>{children}</I18nextProvider>;
}
