// SPDX-License-Identifier: AGPL-3.0-or-later

import { nanoid, type Store, type Transformer } from "@virgultum/store";
import {
  cloneTextWithDocumentFieldIdentities,
  DocumentFieldSchema,
  validateDocumentFieldRun,
  type DocumentField,
  type MyoxusTextAttributes,
} from "@virgultum/shared/types";
import type { DeltaInsert } from "@virgultum/store";
import { normalizeDocumentField } from "../../template-doc/services/template-inputs";
import {
  normalizeTableHeaderRows,
  type TableBlockModel,
  type TableRow,
} from "@virgultum/model";

import { TemplateInstantiationError } from "../../template-doc/services/template-instantiation-error";
import {
  templateDeltaText,
  templateVariableRanges,
} from "./template-variables";

export type TemplateRecord = Readonly<Record<string, string>>;
export type TemplateVariable =
  string | readonly string[] | readonly TemplateRecord[];
export type TemplateVariables = Readonly<Record<string, TemplateVariable>>;
type Snapshot = NonNullable<ReturnType<Transformer["sliceToSnapshot"]>>;

export const MEMBER_REPEAT_SOURCE = "workspace.members";
const FIELD_NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/i;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const compareTableOrder = (
  leftOrder: string,
  leftId: string,
  rightOrder: string,
  rightId: string,
) =>
  leftOrder < rightOrder
    ? -1
    : leftOrder > rightOrder
      ? 1
      : leftId < rightId
        ? -1
        : leftId > rightId
          ? 1
          : 0;
const invalid = (): never => {
  throw new TemplateInstantiationError("repeat-invalid");
};

/** Same ingress bounds as the server; never truncate a member inventory. */
export function templateRecordCollection(
  value: TemplateVariable | undefined,
): readonly TemplateRecord[] {
  if (!Array.isArray(value) || !value.length || value.length > 500)
    return invalid();
  for (const record of value) {
    if (!record || typeof record !== "object" || Array.isArray(record))
      return invalid();
    const fields = Object.entries(record);
    if (fields.length > 100) return invalid();
    for (const [key, field] of fields) {
      if (
        !FIELD_NAME.test(key) ||
        bytes(key) > 128 ||
        typeof field !== "string" ||
        bytes(field) > 8 * 1024
      )
        return invalid();
    }
  }
  return value as readonly TemplateRecord[];
}

export function memberRepeatFields(
  binding: unknown,
  texts: readonly string[],
  collect = false,
): Set<string> {
  if (
    !binding ||
    typeof binding !== "object" ||
    !("source" in binding) ||
    !("alias" in binding) ||
    binding.source !== MEMBER_REPEAT_SOURCE ||
    binding.alias !== "member"
  )
    return invalid();
  const fields = new Set<string>();
  for (const text of texts) {
    for (const { name } of templateVariableRanges(
      text,
      collect ? () => {} : undefined,
    )) {
      if (name.startsWith("member.")) {
        if (name !== "member.name" && name !== "member.email") return invalid();
        fields.add(name.slice("member.".length));
      }
    }
  }
  if (!fields.size) return invalid();
  return fields;
}

export type TemplateTextLocation = {
  blockId: string;
  kind: "title" | "text" | "cell";
  rowId?: string;
  columnId?: string;
};
export type TemplateTextUnit = TemplateTextLocation & {
  text: string;
  scoped: boolean;
};
export type TemplateNativeDiagnostic = TemplateTextLocation & {
  reason: "invalid-syntax" | "repeat-invalid";
  start: number;
  length: number;
};

/** Inspection data only; metadata has no source answer or required-input prompt. */
export type TemplateNativeFieldInspection = TemplateTextLocation & {
  start: number;
  length: number;
  field?: DocumentField;
  captured: boolean;
  state: "invalid" | "input-unset" | "input-filled" | "metadata";
  complete: boolean;
};

/** Inspection and application share one native traversal and repeat validation.
 * Collecting mode reports invalid units without expanding or mutating them.
 */
export function inspectTemplateSnapshot(
  snapshot: Snapshot,
  title?: string,
  collect = false,
  titleBlockId = "",
) {
  const required = new Set<string>();
  const repeats: Set<string>[] = [];
  const units: TemplateTextUnit[] = [];
  const diagnostics: TemplateNativeDiagnostic[] = [];
  const nativeFields: TemplateNativeFieldInspection[] = [];
  const fieldIds = new Set<string>();
  const fieldsOf = (
    value: unknown,
    location: TemplateTextLocation,
    allowed: boolean,
  ) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("delta" in value) ||
      !Array.isArray(value.delta)
    )
      return;
    let start = 0;
    let previous: TemplateNativeFieldInspection | undefined;
    for (const run of value.delta as DeltaInsert<MyoxusTextAttributes>[]) {
      const length = typeof run.insert === "string" ? run.insert.length : 1;
      if (
        run.attributes &&
        ("documentField" in run.attributes ||
          "documentFieldCaptured" in run.attributes)
      ) {
        let field: DocumentField | undefined;
        let valid = allowed;
        try {
          validateDocumentFieldRun(run);
          field = DocumentFieldSchema.parse(run.attributes.documentField);
          field = normalizeDocumentField(field);
        } catch {
          valid = false;
        }
        const captured = run.attributes.documentFieldCaptured === true;
        if (
          valid &&
          field &&
          captured &&
          previous?.captured &&
          JSON.stringify(previous.field) === JSON.stringify(field) &&
          previous.start + previous.length === start
        ) {
          previous.length += length;
          start += length;
          continue;
        }
        if (field && fieldIds.has(field.id)) valid = false;
        if (field) fieldIds.add(field.id);
        const unset =
          field?.type === "input" &&
          (field.value === null || field.value.length === 0);
        const inspection: TemplateNativeFieldInspection = {
          blockId: location.blockId,
          kind: location.kind,
          rowId: location.rowId,
          columnId: location.columnId,
          start,
          length,
          field,
          captured,
          state: !valid
            ? "invalid"
            : field?.type === "metadata"
              ? "metadata"
              : unset
                ? "input-unset"
                : "input-filled",
          complete:
            valid &&
            (field?.type !== "input" || !field.definition.required || !unset),
        };
        nativeFields.push(inspection);
        previous = inspection;
        if (!valid && !collect)
          throw new TemplateInstantiationError("invalid-syntax");
      } else previous = undefined;
      start += length;
    }
  };
  const textOf = (value: unknown): string => {
    if (
      !value ||
      typeof value !== "object" ||
      !("delta" in value) ||
      !Array.isArray(value.delta)
    )
      return "";
    return templateDeltaText(value.delta);
  };
  const report = (
    location: TemplateTextLocation,
    reason: TemplateNativeDiagnostic["reason"],
    start = 0,
    length = 0,
  ) => {
    if (!collect) throw new TemplateInstantiationError(reason);
    diagnostics.push({ ...location, reason, start, length });
  };
  const read = (unit: TemplateTextUnit) => {
    units.push(unit);
    let ranges: ReturnType<typeof templateVariableRanges>;
    try {
      ranges = templateVariableRanges(
        unit.text,
        collect
          ? (start, length) => report(unit, "invalid-syntax", start, length)
          : undefined,
      );
    } catch (error) {
      if (!(error instanceof TemplateInstantiationError)) throw error;
      report(unit, "invalid-syntax", error.range?.start, error.range?.length);
      return;
    }
    for (const range of [...ranges].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const name = range.name;
      if (
        name === MEMBER_REPEAT_SOURCE ||
        (name.startsWith("member.") && !unit.scoped)
      ) {
        report(unit, "repeat-invalid", range.start, range.length);
      }
      if (!name.startsWith("member.")) required.add(name);
    }
  };
  const unit = (
    binding: unknown,
    locations: (TemplateTextLocation & { text: string })[],
  ) => {
    if (binding !== undefined) {
      try {
        repeats.push(
          memberRepeatFields(
            binding,
            locations.map((unit) => unit.text),
            collect,
          ),
        );
        required.add(MEMBER_REPEAT_SOURCE);
      } catch (error) {
        if (!(error instanceof TemplateInstantiationError)) throw error;
        report(locations[0], "repeat-invalid", 0, locations[0].text.length);
      }
    }
    locations.forEach((location) =>
      read({ ...location, scoped: binding !== undefined }),
    );
  };
  const walk = (blocks: Snapshot["content"], parent: string | undefined) => {
    for (const block of blocks) {
      const location = {
        blockId: block.id,
        kind: "text" as const,
        text: textOf(block.props.text),
      };
      const binding = block.props.repeat;
      fieldsOf(
        block.props.text,
        location,
        [
          "myoxus:paragraph",
          "myoxus:list",
          "myoxus:callout",
          "myoxus:footnote-definition",
        ].includes(block.flavour),
      );
      fieldsOf(
        block.props.title,
        { blockId: block.id, kind: "title" },
        block.flavour === "myoxus:callout",
      );
      if (
        binding !== undefined &&
        (!parent ||
          !["myoxus:paragraph", "myoxus:list"].includes(block.flavour) ||
          block.children.length)
      ) {
        report(location, "repeat-invalid", 0, location.text.length);
      }
      unit(binding, [location]);
      if (block.flavour === "myoxus:table") {
        const rows = (block.props.rows ?? {}) as Record<
          string,
          { rowId: string; order: string; repeat?: unknown }
        >;
        const columns = (block.props.columns ?? {}) as Record<string, unknown>;
        const cells = (block.props.cells ?? {}) as Record<
          string,
          { text?: unknown }
        >;
        const sortedRows = Object.entries(rows).sort(
          ([leftId, a], [rightId, b]) =>
            compareTableOrder(a.order, leftId, b.order, rightId),
        );
        const headerRows = Object.hasOwn(block.props, "headerRows")
          ? normalizeTableHeaderRows(block.props.headerRows, sortedRows.length)
          : 0;
        for (const [index, [id, row]] of sortedRows.entries()) {
          const locations = Object.keys(columns).map((column) => ({
            blockId: block.id,
            kind: "cell" as const,
            rowId: id,
            columnId: column,
            text: textOf(cells[`${id}:${column}`]?.text),
          }));
          for (const location of locations)
            fieldsOf(cells[`${id}:${location.columnId}`]?.text, location, true);
          const anchor = locations[0] ?? { ...location, rowId: id };
          if (
            row.repeat !== undefined &&
            (index < headerRows ||
              row.rowId !== id ||
              !row.order ||
              !locations.length ||
              block.children.length ||
              Object.keys(columns).some((column) => {
                const text = cells[`${id}:${column}`]?.text;
                return (
                  !text ||
                  typeof text !== "object" ||
                  !("delta" in text) ||
                  !Array.isArray(text.delta)
                );
              }))
          )
            report(anchor, "repeat-invalid", 0, anchor.text.length);
          // An invalid empty row still has an actionable table anchor.
          unit(row.repeat, locations.length ? locations : [anchor]);
        }
        for (const [key, cell] of Object.entries(cells)) {
          const [rowId, columnId, extra] = key.split(":");
          if (!rows[rowId] || !columns[columnId] || extra !== undefined)
            fieldsOf(
              cell.text,
              { blockId: block.id, kind: "cell", rowId, columnId },
              false,
            );
          if (!rows[rowId] || !columns[columnId] || extra !== undefined)
            read({
              blockId: block.id,
              kind: "cell",
              rowId,
              columnId,
              text: textOf(cell.text),
              scoped: false,
            });
        }
      }
      walk(block.children, block.flavour);
    }
  };
  walk(snapshot.content, "myoxus:page");
  if (title !== undefined)
    read({ blockId: titleBlockId, kind: "title", text: title, scoped: false });
  return { required, repeats, units, diagnostics, nativeFields };
}

export function validateTemplateRepeats(
  repeats: readonly ReadonlySet<string>[],
  variables: TemplateVariables,
) {
  if (!repeats.length) return;
  const records = templateRecordCollection(variables[MEMBER_REPEAT_SOURCE]);
  for (const fields of repeats)
    for (const record of records)
      for (const field of fields) {
        if (!Object.hasOwn(record, field) || !record[field].trim()) invalid();
      }
}

export const scalarTemplateVariables = (
  variables: TemplateVariables,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(variables).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/** The existing operation owns the write/rollback fence. Copy precedes creation
 * metadata, then each native text is substituted once with global AND scoped
 * values; brace-bearing member data can never become a second expression.
 */
export function expandAndApplyTemplateUnits(
  doc: Store,
  variables: TemplateVariables,
  apply: (text: unknown, values: Readonly<Record<string, string>>) => void,
) {
  const globals = scalarTemplateVariables(variables);
  const scopes = () =>
    templateRecordCollection(variables[MEMBER_REPEAT_SOURCE]).map((record) => ({
      ...globals,
      ...Object.fromEntries(
        Object.entries(record).map(([key, value]) => [`member.${key}`, value]),
      ),
    }));
  // Validate positional header constraints before the first target mutation.
  // Snapshot preflight owns the normal path; this second guard protects direct
  // callers and a copied target that changed before expansion.
  for (const model of doc.getAllModels()) {
    if (model.flavour !== "myoxus:table") continue;
    const table = model as TableBlockModel;
    const rows = Object.values(table.props.rows).sort((a, b) =>
      compareTableOrder(a.order, a.rowId, b.order, b.rowId),
    );
    if (table.props.headerRows === undefined) continue;
    const headerRows = normalizeTableHeaderRows(
      table.props.headerRows,
      rows.length,
    );
    if (rows.slice(0, headerRows).some((row) => row.repeat !== undefined))
      invalid();
  }
  for (const model of doc.getAllModels()) {
    const modelProps = model.props as Record<string, unknown>;
    if (modelProps.repeat !== undefined) {
      memberRepeatFields(modelProps.repeat, [model.text?.toString() ?? ""]);
      const parent = doc.getParent(model);
      if (
        !parent ||
        model.children.length ||
        !["myoxus:paragraph", "myoxus:list"].includes(model.flavour)
      )
        invalid();
      let index = parent!.children.indexOf(model);
      if (index < 0) invalid();
      for (const values of scopes()) {
        const props = Object.fromEntries(
          model.keys.map((key) => [key, modelProps[key]]),
        );
        delete props.repeat;
        props.text = cloneTextWithDocumentFieldIdentities(model.text!, nanoid);
        const id = doc.addBlock(model.flavour, props, parent!, index++);
        apply(doc.getModelById(id)!.text, values);
      }
      doc.deleteBlock(model);
      continue;
    }
    if (model.flavour === "myoxus:table") {
      // Flat table props update synchronously; their row/cell rewrite can share
      // one native transaction. Do not wrap normal block creation this way:
      // SyncController projects newly added block models after transaction end.
      doc.spaceDoc.transact(() => {
        const table = model as TableBlockModel;
        const rows = Object.values(table.props.rows).sort((a, b) =>
          a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
        );
        const columns = Object.keys(table.props.columns);
        const handled = new Set<string>();
        const expandedRows: TableRow[] = [];
        let expanded = false;
        for (const row of rows) {
          if (row.repeat === undefined) {
            expandedRows.push(row);
            continue;
          }
          expanded = true;
          memberRepeatFields(
            row.repeat,
            columns.map(
              (column) =>
                table.props.cells[`${row.rowId}:${column}`]?.text.toString() ??
                "",
            ),
          );
          for (const values of scopes()) {
            const fieldIds = new Map<string, string>();
            const rowId = nanoid();
            const clone: TableRow = { ...row, rowId };
            delete clone.repeat;
            expandedRows.push(clone);
            table.props.rows[rowId] = clone;
            for (const column of columns) {
              const source = table.props.cells[`${row.rowId}:${column}`];
              if (!source) invalid();
              const key = `${rowId}:${column}`;
              table.props.cells[key] = {
                ...source,
                text: cloneTextWithDocumentFieldIdentities(
                  source.text,
                  nanoid,
                  fieldIds,
                ),
              };
              handled.add(key);
              apply(table.props.cells[key].text, values);
            }
          }
          delete table.props.rows[row.rowId];
          for (const column of columns)
            delete table.props.cells[`${row.rowId}:${column}`];
        }
        // Normalize only an expanded table, preserving its complete row order.
        // a0 + fixed-width decimal rank + nonzero tail is a valid base-62
        // fractional key; native editing can insert between these ranks later.
        if (expanded)
          expandedRows.forEach((row, index) => {
            table.props.rows[row.rowId] = {
              ...row,
              order: `a0${String(index).padStart(10, "0")}1`,
            };
          });
        for (const [key, cell] of Object.entries(table.props.cells))
          if (!handled.has(key)) apply(cell.text, globals);
      }, doc.spaceDoc.clientID);
      continue;
    }
    const text = model.text?.toString().trim() ?? "";
    const ranges = templateVariableRanges(text);
    const listKey =
      ranges.length === 1 &&
      ranges[0].start === 0 &&
      ranges[0].length === text.length
        ? ranges[0].name
        : undefined;
    const list = listKey ? variables[listKey] : undefined;
    if (
      model.flavour === "myoxus:list" &&
      Array.isArray(list) &&
      list.every((value) => typeof value === "string")
    ) {
      if (
        list.length > 500 ||
        list.some((value) => bytes(value) > 8 * 1024) ||
        model.children.length
      )
        invalid();
      const parent = doc.getParent(model);
      if (!parent) invalid();
      let index = parent!.children.indexOf(model);
      for (const value of list.length ? list : [""]) {
        const props = Object.fromEntries(
          model.keys.map((key) => [key, modelProps[key]]),
        );
        props.text = model.text!.clone();
        const id = doc.addBlock(model.flavour, props, parent!, index++);
        apply(doc.getModelById(id)!.text, { ...globals, [listKey!]: value });
      }
      doc.deleteBlock(model);
    } else apply(model.text, globals);
  }
}
