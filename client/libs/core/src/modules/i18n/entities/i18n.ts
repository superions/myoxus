import { DebugLogger } from "@myoxus/debug";
import {
  getOrCreateI18n,
  i18nCompletenesses,
  type Language,
  SUPPORTED_LANGUAGES,
} from "@myoxus/i18n";
import { effect, Entity, fromPromise, LiveData } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { catchError, concatMap, EMPTY } from "rxjs";

export type LanguageInfo = {
  key: Language;
  name: string;
  originalName: string;
  completeness: number;
};

const logger = new DebugLogger("i18n");

function mapLanguageInfo(language: Language = "en"): LanguageInfo {
  const languageInfo = SUPPORTED_LANGUAGES[language];

  return {
    key: language,
    name: languageInfo.name,
    originalName: languageInfo.originalName,
    completeness: i18nCompletenesses[language],
  };
}

export class I18n extends Entity {
  private readonly i18n = getOrCreateI18n();

  get i18next() {
    return this.i18n;
  }

  readonly currentLanguageKey$ = new LiveData<Language>(
    (this.i18n.language as Language | undefined) ?? "en",
  );

  readonly currentLanguage$ = this.currentLanguageKey$
    .distinctUntilChanged()
    .map(mapLanguageInfo);

  /**
   * Admin-configured list of permitted locale codes.
   * `null` means "no restriction — show all supported locales".
   * Updated by the Server entity after fetching serverConfig.
   */
  readonly availableLocales$ = new LiveData<string[] | null>(null);

  /**
   * Reactive list of languages to show in the language selector.
   * Filtered to `availableLocales` when set by the admin; falls back to all
   * supported locales when `availableLocales$` is null or empty.
   */
  readonly languageList$: LiveData<LanguageInfo[]> = this.availableLocales$.map(
    (locales): LanguageInfo[] => {
      const allKeys = Object.keys(SUPPORTED_LANGUAGES) as Language[];
      if (!locales || locales.length === 0) {
        return allKeys.map(mapLanguageInfo);
      }
      return locales
        .filter((key): key is Language => key in SUPPORTED_LANGUAGES)
        .map((key) => mapLanguageInfo(key));
    },
  );

  /**
   * Synchronous accessor backed by `languageList$`.
   * Kept for backward-compat with non-reactive callers (command registration, etc.).
   * React components should use `useLiveData(i18n.languageList$)` instead.
   */
  get languageList(): LanguageInfo[] {
    return this.languageList$.value;
  }

  constructor() {
    super();
    this.i18n.on("languageChanged", (language: Language) => {
      document.documentElement.lang = language;
      this.currentLanguageKey$.value = language;
    });
  }

  init() {
    this.changeLanguage(this.currentLanguageKey$.value);
  }

  changeLanguage = effect(
    concatMap((language: string) =>
      fromPromise(() => this.i18n.changeLanguage(language)).pipe(
        catchError((error) => {
          notify({
            theme: "error",
            title: "Failed to change language",
            message: "Error occurs when loading language files",
          });

          logger.error("Failed to change language", error);

          return EMPTY;
        }),
      ),
    ),
  );
}
