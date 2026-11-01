import { I18n } from "@myoxus/i18n";
import {
  type MermaidI18nOptions,
  setMermaidI18nTranslator,
} from "@virgultum/block-mermaid";

export function configureMermaidI18n() {
  setMermaidI18nTranslator((key: string, options?: MermaidI18nOptions) => {
    const translated = I18n.t(key, options);
    return translated === key ? undefined : translated;
  });
}
