import {
  type EditorI18nMessage,
  type EditorI18nService,
} from "@virgultum/shared/services";
import type { TemplateResult } from "lit";

export interface FilterableListItem<Props = unknown> {
  name: string;
  label?: string | EditorI18nMessage;
  icon?: TemplateResult;
  aliases?: string[];
  props?: Props;
}

export interface FilterableListOptions<Props = unknown> {
  placeholder?: string | EditorI18nMessage;
  i18n?: EditorI18nService;
  items: FilterableListItem<Props>[];
  active?: (item: FilterableListItem) => boolean;
  onSelect: (item: FilterableListItem) => void;
}
