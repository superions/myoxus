import { DebugLogger } from "@myoxus/debug";
import i18next, { type BackendModule, type i18n } from "i18next";
import { initReactI18next } from "react-i18next";

import type { MyoxusI18nFunctions } from "./i18n.gen";
import { type Language, SUPPORTED_LANGUAGES } from "./resources";

const logger = new DebugLogger("i18n");

const FALLBACK_LNG: Language = "en";

/**
 * Detect the best initial language from the browser environment.
 * Checks navigator.language/languages, falls back to 'en'.
 */
function detectInitialLanguage(): Language {
  if (typeof navigator === "undefined") return FALLBACK_LNG;

  // Account locale is projected after bootstrap. Until then, use the browser
  // language without creating a second persistent source of truth.
  const candidates = navigator.languages?.length
    ? [...navigator.languages]
    : [navigator.language];
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (SUPPORTED_LANGUAGES[normalized as Language]) {
      return normalized as Language;
    }
    const base = normalized.split("-")[0];
    if (SUPPORTED_LANGUAGES[base as Language]) {
      return base as Language;
    }
  }
  return FALLBACK_LNG;
}

let _instance: i18n | null = null;
export const getOrCreateI18n = (): i18n => {
  if (!_instance) {
    const detectedLng = detectInitialLanguage();
    _instance = i18next.createInstance();
    _instance
      .use(initReactI18next)
      .use({
        type: "backend",
        init: () => {},
        read: (lng: Language, _ns: string, callback) => {
          const resource = SUPPORTED_LANGUAGES[lng].resource;
          if (typeof resource === "function") {
            resource()
              .then((data) => {
                logger.info(`Loaded i18n ${lng} resource`);
                callback(null, data.default);
              })
              .catch((err) => {
                logger.error(`Failed to load i18n ${lng} resource`, err);
                callback(null, null);
              });
          } else {
            callback(null, resource);
          }
        },
      } as BackendModule)
      .init({
        lng: detectedLng,
        fallbackLng: (code) => {
          // always fallback to english
          const fallbacks: string[] = [FALLBACK_LNG];
          if (!code) {
            return fallbacks;
          }
          const [langPart = code] = code.split("-");

          // fallback xx-YY to xx, e.g. es-AR to es
          // fallback zh-Hant to zh-Hans
          if (langPart === "cn") {
            fallbacks.push("zh-Hans");
          } else if (
            langPart !== code &&
            SUPPORTED_LANGUAGES[code as Language]
          ) {
            fallbacks.unshift(langPart);
          }

          return fallbacks;
        },
        supportedLngs: Object.keys(SUPPORTED_LANGUAGES),
        debug: false,
        partialBundledLanguages: true,
        resources: {
          // Only bundle English synchronously (it's the only directly imported resource).
          // All other languages are loaded on-demand by the backend module above.
          // DO NOT add async resources here — they are functions, not objects.
          [FALLBACK_LNG]: {
            translation: SUPPORTED_LANGUAGES[FALLBACK_LNG].resource,
          },
        },
        interpolation: {
          escapeValue: false, // not needed for react as it escapes by default
        },
        react: {
          useSuspense: false,
        },
      })
      .then(() => logger.info("i18n initialized"))
      .catch(() => {});
  }

  return _instance;
};

declare module "i18next" {
  interface CustomTypeOptions {
    // NOTE(@forehalo):
    //   DO NOT ENABLE THIS
    //   This could bring typecheck for <Trans /> component,
    //   but it will make typecheck of whole codebase so laggy!
    //   check [./react.ts]
    // resources: {
    //   translation: LanguageResource;
    // };
  }
}

export type I18nFuncs = MyoxusI18nFunctions;
type KnownI18nKey = keyof I18nFuncs;

export type I18nString =
  KnownI18nKey | string | { i18nKey: string; options?: Record<string, any> };

type I18nOptions = Record<string, any>;

export function isI18nString(value: unknown): value is I18nString {
  if (typeof value === "string") {
    return true;
  }

  if (typeof value === "object" && value !== null) {
    return "i18nKey" in value;
  }

  return false;
}

export function createI18nWrapper(getI18nFn: () => i18n) {
  const I18nMethod = {
    t(
      key: I18nString,
      optionsOrDefault?: I18nOptions | string,
      options?: I18nOptions,
    ) {
      let defaultValue: string | undefined;
      let translateOptions: I18nOptions | undefined;

      if (typeof optionsOrDefault === "string") {
        defaultValue = optionsOrDefault;
        translateOptions = options;
      } else {
        translateOptions = optionsOrDefault;
      }

      if (typeof key === "object" && "i18nKey" in key) {
        translateOptions = key.options;
        key = key.i18nKey as string;
      }

      const i18n = getI18nFn();
      if (i18n.exists(key)) {
        return i18n.t(
          key,
          defaultValue
            ? { ...translateOptions, defaultValue }
            : translateOptions,
        );
      } else {
        // unknown translate key 'xxx.xxx' returns its fallback or itself
        return defaultValue ?? key;
      }
    },
    get language() {
      const i18n = getI18nFn();
      return i18n.language;
    },
    changeLanguage(lng?: string | undefined) {
      const i18n = getI18nFn();
      return i18n.changeLanguage(lng);
    },
    get on() {
      const i18n = getI18nFn();
      return i18n.on.bind(i18n);
    },
    get off() {
      const i18n = getI18nFn();
      return i18n.off.bind(i18n);
    },
  };

  return new Proxy(I18nMethod, {
    get(self, key: string) {
      if (key in self) {
        // @ts-expect-error allow
        return self[key];
      }

      return I18nMethod.t.bind(null, key);
    },
    has(self, key: string) {
      if (key in self) {
        return true;
      }
      const i18n = getI18nFn();
      if (i18n.exists(key)) {
        return true;
      }
      return false;
    },
  }) as typeof I18nMethod &
    MyoxusI18nFunctions & { [unknownKey: string]: () => string };
}

/**
 * I18n['com.myoxus.xxx']({ arg1: 'hello' }) -> '中文 hello'
 */
export const I18n = createI18nWrapper(getOrCreateI18n);
export type I18nInstance = typeof I18n;
