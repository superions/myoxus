import { type Framework } from "@myoxus/infra";

import { I18nProvider } from "./context";
import { I18n, type LanguageInfo } from "./entities/i18n";
import { I18nService } from "./services/i18n";

export function configureI18nModule(framework: Framework) {
  framework.service(I18nService).entity(I18n);
}

export { I18n, I18nProvider, I18nService, type LanguageInfo };
export {
  type DateInput,
  type DateFormatPreference,
  formatRegionalCalendarDate,
  formatRegionalDate,
  formatRegionalDateTime,
  formatRegionalTime,
  normalizeDateFormatPreference,
  normalizeTimeFormatPreference,
  type RegionalFormatPreferences,
  type TimeFormatPreference,
} from "./regional-format";
