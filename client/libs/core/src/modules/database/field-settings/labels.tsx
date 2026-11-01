// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseFieldKind, DatabaseFormulaResultType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";

export const DATABASE_CURRENCY_OPTIONS = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "CAD",
  "AUD",
  "JPY",
];

export type I18nShape = ReturnType<typeof useI18n>;

export function databaseFieldTypeLabel(t: I18nShape, kind: DatabaseFieldKind) {
  switch (kind) {
    case DatabaseFieldKind.Checkbox:
      return t["com.myoxus.database.field.type.checkbox"]();
    case DatabaseFieldKind.Date:
      return t["com.myoxus.database.field.type.date"]();
    case DatabaseFieldKind.DateTime:
      return t["com.myoxus.database.field.type.date-time"]();
    case DatabaseFieldKind.Files:
      return t["com.myoxus.database.field.type.files"]();
    case DatabaseFieldKind.UniqueId:
      return t["com.myoxus.database.field.type.unique-id"]();
    case DatabaseFieldKind.MultiSelect:
      return t["com.myoxus.database.field.type.multi-select"]();
    case DatabaseFieldKind.Tags:
      return t["Tags"]();
    case DatabaseFieldKind.Number:
      return t["com.myoxus.database.field.type.number"]();
    case DatabaseFieldKind.Percent:
      return t["com.myoxus.database.field.type.percent"]();
    case DatabaseFieldKind.Currency:
      return t["com.myoxus.database.field.type.currency"]();
    case DatabaseFieldKind.Duration:
      return t["com.myoxus.database.field.type.duration"]();
    case DatabaseFieldKind.Status:
      return t["com.myoxus.database.field.type.status"]();
    case DatabaseFieldKind.Select:
      return t["com.myoxus.database.field.type.select"]();
    case DatabaseFieldKind.Text:
      return t["com.myoxus.database.field.type.text"]();
    case DatabaseFieldKind.RichText:
      return t["com.myoxus.database.field.type.rich-text"]();
    case DatabaseFieldKind.Url:
      return t["com.myoxus.database.field.type.url"]();
    case DatabaseFieldKind.Email:
      return t["com.myoxus.database.field.type.email"]();
    case DatabaseFieldKind.Phone:
      return t["com.myoxus.database.field.type.phone"]();
    case DatabaseFieldKind.Title:
      return t["com.myoxus.database.field.type.title"]();
    case DatabaseFieldKind.User:
      return t["com.myoxus.database.field.type.user"]();
    case DatabaseFieldKind.Users:
      return t["com.myoxus.database.field.type.users"]();
    case DatabaseFieldKind.Relation:
      return t["com.myoxus.database.field.type.relation"]();
    case DatabaseFieldKind.Rollup:
      return t["com.myoxus.database.field.type.rollup"]();
    case DatabaseFieldKind.Formula:
      return t["com.myoxus.database.field.type.formula"]();
    case DatabaseFieldKind.CreatedTime:
      return t["com.myoxus.database.field.type.created-time"]();
    case DatabaseFieldKind.CreatedBy:
      return t["com.myoxus.database.field.type.created-by"]();
    case DatabaseFieldKind.UpdatedTime:
      return t["com.myoxus.database.field.type.updated-time"]();
    case DatabaseFieldKind.UpdatedBy:
      return t["com.myoxus.database.field.type.updated-by"]();
    default:
      return kind;
  }
}

export function databaseFormulaResultTypeLabel(
  t: I18nShape,
  resultType: DatabaseFormulaResultType,
) {
  switch (resultType) {
    case DatabaseFormulaResultType.Checkbox:
      return t["com.myoxus.database.formula.result.checkbox"]();
    case DatabaseFormulaResultType.Date:
      return t["com.myoxus.database.formula.result.date"]();
    case DatabaseFormulaResultType.Number:
      return t["com.myoxus.database.formula.result.number"]();
    case DatabaseFormulaResultType.Text:
      return t["com.myoxus.database.formula.result.text"]();
    default:
      return resultType;
  }
}

export function extractFormulaDependencyNames(expression: string) {
  const dependencies = new Set<string>();
  const fieldReferencePattern = /\[([^\]]+)\]/g;
  for (const match of expression.matchAll(fieldReferencePattern)) {
    const name = match[1]?.trim();
    if (name) dependencies.add(name);
  }
  return [...dependencies];
}
