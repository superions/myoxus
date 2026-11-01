// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Myoxus-owned Database Table clipboard helpers (P-DB-29B-B).
//
// Produces the TSV-ish text payload used by the Table surface for
// copy / cut / paste / fill operations and parses it back into cell
// values that already match the GraphQL mutation contract.
//
// The behavioural surface mirrors the legacy Database clipboard
// helpers that previously lived in the host module; only the
// callers in the active Table view import
// these names now, and the legacy adapter module is no longer on
// the active code path.

import {
  DatabaseFieldKind,
  type DatabaseRichTextCellValueInput,
} from "@myoxus/graphql";

import {
  formatCellValue,
  getSelectOptions,
  isDatabaseProjectionField,
  normalizeDatabaseCurrencyCellValue,
} from "../model";
import type { DatabaseField, DatabaseRowRecord } from "../types";
import { isDatabaseTableFieldReadonly } from "./labels";

/** Convert plain text into the canonical RichText document input. */
export function richTextDocumentFromPlainText(
  text: string,
): DatabaseRichTextCellValueInput["document"] {
  return {
    type: "doc",
    content: text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => ({
        type: "paragraph",
        ...(line ? { content: [{ type: "text", text: line }] } : {}),
      })),
  };
}

/**
 * Cell clipboard payload for a single field/row pair. The Table surface
 * uses this for the `copy` action on a single cell and the per-cell
 * `paste` step during a multi-cell fill.
 */
export function databaseTableCellClipboardText(
  row: DatabaseRowRecord,
  field: DatabaseField,
  locale: string,
  labels?: { checkboxTrue?: string },
): string {
  return formatCellValue(row, field, locale, labels);
}

/**
 * Returns true when the field can be written through the clipboard /
 * paste / fill actions. Mirrors the legacy `isDatabaseClipboardEditable`
 * rule: Title is editable, projection / read-only computed fields
 * (`Rollup`, `Formula`, created/updated metadata, `UniqueId`) are not.
 */
export function isDatabaseTableCellEditable(field: DatabaseField): boolean {
  if (field.fieldType === DatabaseFieldKind.Title) return true;
  // DocumentLink is edited through the permission-filtered picker; plain text
  // clipboard input must never be interpreted as an unchecked document id.
  if (field.fieldType === DatabaseFieldKind.DocumentLink) return false;
  if (isDatabaseTableFieldReadonly(field)) return false;
  return !isDatabaseProjectionField(field.fieldType);
}

/**
 * Parse a clipboard text payload into the canonical cell value shape
 * the GraphQL mutation expects. Behavioural parity with the legacy
 * `databaseParseClipboardValue` helper.
 */
export function databaseTableParseClipboardValue(
  field: DatabaseField,
  text: string,
): unknown {
  const value = text.trim();
  switch (field.fieldType) {
    case DatabaseFieldKind.Checkbox:
      return /^(1|true|yes|y|checked|x)$/i.test(value);
    case DatabaseFieldKind.Date:
    case DatabaseFieldKind.DateTime:
    case DatabaseFieldKind.Files:
      return value;
    case DatabaseFieldKind.RichText:
      return richTextDocumentFromPlainText(text);
    case DatabaseFieldKind.MultiSelect: {
      const options = getSelectOptions(field);
      const optionByLabel = new Map(
        options.map((option) => [option.name.toLocaleLowerCase(), option.id]),
      );
      const optionIds = new Set(options.map((option) => option.id));
      return value
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) =>
              optionIds.has(part)
                ? part
                : (optionByLabel.get(part.toLocaleLowerCase()) ?? part),
            )
        : [];
    }
    case DatabaseFieldKind.Number:
    case DatabaseFieldKind.Percent: {
      const normalized =
        field.fieldType === DatabaseFieldKind.Percent
          ? value.replace(/%$/, "").trim()
          : value;
      const parsed = Number.parseFloat(normalized.replace(",", "."));
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case DatabaseFieldKind.Currency: {
      const explicitCurrency = value.match(
        /^(?<prefix>[A-Z]{3})\s*(?<prefixAmount>[-+]?\d+(?:[.,]\d+)?)$|^(?<suffixAmount>[-+]?\d+(?:[.,]\d+)?)\s*(?<suffix>[A-Z]{3})$/i,
      );
      const amountText =
        explicitCurrency?.groups?.prefixAmount ??
        explicitCurrency?.groups?.suffixAmount ??
        value;
      const parsed = Number.parseFloat(amountText.replace(",", "."));
      return normalizeDatabaseCurrencyCellValue(
        {
          amount: Number.isFinite(parsed) ? parsed : 0,
          currencyCode:
            explicitCurrency?.groups?.prefix ??
            explicitCurrency?.groups?.suffix ??
            field.config.currency?.defaultCurrency ??
            "EUR",
        },
        field,
      );
    }
    case DatabaseFieldKind.Duration: {
      const explicitDuration = value.match(
        /^(?<amount>[-+]?\d+(?:[.,]\d+)?)\s*(?<unit>minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|day|d)?$/i,
      );
      const parsed = Number.parseFloat(
        (explicitDuration?.groups?.amount ?? value).replace(",", "."),
      );
      const unit = (explicitDuration?.groups?.unit ?? "min").toLowerCase();
      const factor = /^(days?|d)$/.test(unit)
        ? 1440
        : /^(hours?|hrs?|hr|h)$/.test(unit)
          ? 60
          : 1;
      return {
        minutes: Number.isFinite(parsed) ? Math.round(parsed * factor) : 0,
      };
    }
    case DatabaseFieldKind.Select:
    case DatabaseFieldKind.Status: {
      const options = getSelectOptions(field);
      return (
        options.find(
          (option) =>
            option.id === value ||
            option.name.toLocaleLowerCase() === value.toLocaleLowerCase(),
        )?.id ?? value
      );
    }
    case DatabaseFieldKind.Relation:
    case DatabaseFieldKind.Tags:
    case DatabaseFieldKind.Users:
      return value
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : [];
    case DatabaseFieldKind.Title:
    case DatabaseFieldKind.Text:
    case DatabaseFieldKind.Url:
    case DatabaseFieldKind.Email:
    case DatabaseFieldKind.Phone:
    case DatabaseFieldKind.User:
      return text;
    case DatabaseFieldKind.Rollup:
    case DatabaseFieldKind.Formula:
    case DatabaseFieldKind.UniqueId:
    case DatabaseFieldKind.CreatedTime:
    case DatabaseFieldKind.CreatedBy:
    case DatabaseFieldKind.UpdatedTime:
    case DatabaseFieldKind.UpdatedBy:
      throw new Error(`Database field type is read-only: ${field.fieldType}`);
    default:
      throw new Error(
        `Unsupported database clipboard field type: ${field.fieldType}`,
      );
  }
}
