// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseStarterTemplateCategory,
  DatabaseViewKind,
} from "@myoxus/graphql";
import type { useI18n } from "@myoxus/i18n";

type I18nShape = ReturnType<typeof useI18n>;

export function starterTemplateCopy(
  t: I18nShape,
  key: string,
  fallback: string,
) {
  return t.t(key, fallback);
}

export function starterTemplateProfileLabel(
  t: I18nShape,
  category: DatabaseStarterTemplateCategory,
) {
  return category === DatabaseStarterTemplateCategory.Project
    ? t["com.myoxus.database.template.profile.project"]()
    : t["com.myoxus.database.template.profile.database"]();
}

export function databaseViewKindLabel(
  t: I18nShape,
  viewKind: DatabaseViewKind,
) {
  switch (viewKind) {
    case DatabaseViewKind.Calendar:
      return t["com.myoxus.database.view.calendar"]();
    case DatabaseViewKind.Gallery:
      return t["com.myoxus.database.view.gallery"]();
    case DatabaseViewKind.Gantt:
      return t["com.myoxus.database.view.gantt"]();
    case DatabaseViewKind.Kanban:
      return t["com.myoxus.database.view.kanban"]();
    case DatabaseViewKind.List:
      return t["com.myoxus.database.view.list"]();
    case DatabaseViewKind.Progress:
      return t["com.myoxus.common.progress"]();
    case DatabaseViewKind.Table:
      return t["com.myoxus.database.view.table"]();
    case DatabaseViewKind.Timeline:
      return t["com.myoxus.database.view.timeline"]();
    default:
      return viewKind;
  }
}
