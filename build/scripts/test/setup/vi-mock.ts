import { vi } from "vitest";

// Global i18n mock — loads REAL English translations so tests can assert on
// actual visible text instead of opaque i18n key strings.
vi.mock("@myoxus/i18n", async () => {
  const en: Record<string, string> =
    await import("../../../../client/libs/i18n/src/resources/en.json").then(
      (m) => m.default ?? m,
    );
  // Real SUPPORTED_LANGUAGES and i18nCompletenesses needed by I18n entity internals
  const { SUPPORTED_LANGUAGES } =
    await import("../../../../client/libs/i18n/src/resources/index");
  const completenesses =
    await import("../../../../client/libs/i18n/src/i18n-completenesses.json").then(
      (m) => m.default ?? m,
    );

  // Locale-loader coverage belongs to i18n's date-locale-coverage and
  // captcha-widget-coverage specs. Loading every locale in every component
  // mock repeats that contract and defeats production's lazy locale loading.

  /** Resolve interpolation placeholders: {{name}} → options.name */
  const interpolate = (text: string, options?: Record<string, any>): string => {
    if (!options) return text;
    let result = text;
    Object.entries(options).forEach(([k, v]) => {
      result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
    });
    return result;
  };

  const t = (key: string, options?: Record<string, any>): string => {
    // Handle basic plural forms: try _one/_other suffixed keys first
    if (options && typeof options.count === "number") {
      const pluralSuffix = options.count === 1 ? "_one" : "_other";
      const pluralKey = `${key}${pluralSuffix}`;
      if (en[pluralKey]) {
        return interpolate(en[pluralKey], options);
      }
    }

    let text = en[key];
    if (!text) return key; // fallback to key for missing translations
    return interpolate(text, options);
  };

  const i18nInstance = {
    t,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
    use: () => ({}),
    init: () => Promise.resolve(),
    on: () => {},
  };

  return {
    useI18n: () => {
      const methods = {
        t,
        exists: (key: string) => key in en,
        language: "en",
        changeLanguage: () => Promise.resolve(),
        on: () => {},
      };
      return new Proxy(methods, {
        get(target: any, prop: string) {
          if (prop in target) return target[prop];
          return () => prop;
        },
        has(_target: any, _prop: string) {
          return true;
        },
      });
    },
    Trans: ({ children }: any) => children,
    I18nextProvider: ({ children }: any) => children,
    getOrCreateI18n: () => i18nInstance,
    I18n: new Proxy(
      {},
      {
        get(_target: any, prop: string) {
          if (prop === "t") return t;
          if (prop === "exists") return (key: string) => key in en;
          if (prop === "language") return "en";
          if (prop === "changeLanguage") return () => Promise.resolve();
          return () => prop;
        },
      },
    ),
    // Expose real data objects required by I18n entity internals
    SUPPORTED_LANGUAGES,
    i18nCompletenesses: completenesses,
  };
});

if (typeof window !== "undefined" && HTMLCanvasElement) {
  // @ts-expect-error allow vitest global mock
  HTMLCanvasElement.prototype.getContext = () => {
    return {
      fillRect: vi.fn(),
      // Semantic renderer consumers need measurement; desktop QA owns pixels.
      font: "",
      measureText: (text: string) => ({ width: text.length * 7 }),
    };
  };
}
