import type { I18nString } from "@myoxus/i18n";

export interface QuickSearchOptions {
  label?: I18nString;
  placeholder?: I18nString;
  defaultQuery?: string;
  onOpenPage?: (query: string) => void;
}
