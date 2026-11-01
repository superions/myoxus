// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  footnotePlacement,
  AnnotationSchema,
  type FootnoteDefinitionBlockModel,
  type FootnotePlacement,
  type TableBlockModel,
} from "@virgultum/model";
import { TextSelection, type BlockStdScope } from "@virgultum/std";
import {
  Text,
  type BlockModel,
  type BlockSnapshot,
  type Store,
  type DeltaOperation,
  type DeltaInsert,
} from "@virgultum/store";
import * as Y from "yjs";
import type { MyoxusTextAttributes } from "../types";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkGfm } from "../adapters/markdown/gfm";
import { normalizeFootnoteLabel } from "../adapters/markdown/footnotes";

export function localFootnoteDefinitions(store: Store) {
  const result: FootnoteDefinitionBlockModel[] = [];
  const visit = (model: BlockModel) => {
    if (
      model.flavour === "myoxus:footnote-definition" &&
      store.getParent(model)?.flavour === "myoxus:note"
    )
      result.push(model as FootnoteDefinitionBlockModel);
    model.children.forEach(visit);
  };
  if (store.root) visit(store.root);
  return result;
}
export type LocalFootnotePresentation = {
  placement: FootnotePlacement | undefined;
  number?: number;
  /** First main-body reference, independent of the definition's physical order. */
  order?: number;
};

/** Derive numbers from emitting body text, never from labels or stored counters.
 * Table order matches the native TS/Rust renderers. Legacy citations consume
 * one entry per delta run, as the deployed PDF path does, except in headings
 * whose legacy citation payload is rendered as ordinary heading text. */
export function localFootnotePresentation(store: Store) {
  return deriveLocalFootnotePresentation(store.root ? [store.root] : []);
}

/** The same reading-order projection for existing native snapshot exporters. */
export function localFootnoteSnapshotPresentation(roots: BlockSnapshot[]) {
  return deriveLocalFootnotePresentation(roots);
}

function deriveLocalFootnotePresentation(
  roots: (BlockModel | BlockSnapshot)[],
) {
  const definitions: (BlockModel | BlockSnapshot)[] = [];
  const collect = (
    node: BlockModel | BlockSnapshot,
    parent?: BlockModel | BlockSnapshot,
  ) => {
    if (
      node.flavour === "myoxus:footnote-definition" &&
      parent?.flavour === "myoxus:note"
    )
      definitions.push(node);
    node.children.forEach((child) => collect(child, node));
  };
  roots.forEach((node) => collect(node));
  const deltas = (value: unknown): DeltaOperation[] =>
    value instanceof Text
      ? value.toDelta()
      : value &&
          typeof value === "object" &&
          "$virgultum:internal:text$" in value &&
          value["$virgultum:internal:text$"] === true &&
          "delta" in value &&
          Array.isArray(value.delta)
        ? (value.delta as DeltaOperation[])
        : [];

  const result = new Map<string, LocalFootnotePresentation>(
    definitions.map((definition) => [
      definition.id,
      {
        placement: footnotePlacement(
          (definition.props as Record<string, unknown>).placement,
        ),
      },
    ]),
  );
  let footnotes = 0,
    endnotes = 0,
    order = 0;
  const inspect = (text: unknown, legacyEmits: boolean) => {
    for (const delta of deltas(text)) {
      const attributes = delta.attributes as MyoxusTextAttributes | undefined;
      const marker = attributes?.footnote as
        { definitionId?: string; reference?: unknown } | undefined;
      if (
        !marker ||
        AnnotationSchema.safeParse(attributes?.annotation).success ||
        attributes?.latex ||
        attributes?.reference ||
        attributes?.mention
      )
        continue;
      if (marker.definitionId !== undefined && marker.reference === undefined) {
        const target = result.get(marker.definitionId);
        if (!target?.placement || target.number !== undefined) continue;
        target.number =
          target.placement === "endnote" ? ++endnotes : ++footnotes;
        target.order = ++order;
      } else if (marker.reference !== undefined && legacyEmits) ++footnotes;
    }
  };
  const visit = (model: BlockModel | BlockSnapshot) => {
    if (
      [
        "myoxus:footnote-definition",
        "myoxus:code",
        "myoxus:annotation",
        "myoxus:surface",
      ].includes(model.flavour)
    )
      return;
    if (model.flavour === "myoxus:table") {
      const { rows, columns, cells } = model.props as TableBlockModel["props"];
      const ordered = <T extends { order: string }>(
        entries: Record<string, T>,
      ) =>
        Object.entries(entries).sort(([a, x], [b, y]) =>
          x.order < y.order
            ? -1
            : x.order > y.order
              ? 1
              : a < b
                ? -1
                : a > b
                  ? 1
                  : 0,
        );
      for (const [row] of ordered(rows))
        for (const [column] of ordered(columns)) {
          const text = cells[`${row}:${column}`]?.text;
          if (text) inspect(text, true);
        }
    } else if (model.flavour !== "myoxus:page") {
      const heading =
        model.flavour === "myoxus:paragraph" &&
        /^h[1-6]$/.test(String((model.props as Record<string, unknown>).type));
      inspect("store" in model ? model.text : model.props.text, !heading);
    }
    model.children.forEach(visit);
  };
  roots.forEach(visit);
  return result;
}

function modelTexts(model: BlockModel): Text[] {
  const props = model.props as Record<string, unknown>;
  return [
    model.text,
    props.title,
    ...Object.values(
      (props.cells ?? {}) as Record<string, { text?: Text }>,
    ).map((cell) => cell.text),
  ].filter((text): text is Text => text instanceof Text);
}
function labelOccupied(store: Store, label: string, except?: string) {
  const normalized = normalizeFootnoteLabel(label);
  let occupied = false;
  const visit = (model: BlockModel) => {
    const props = model.props as Record<string, unknown>;
    if (
      model.id !== except &&
      model.flavour === "myoxus:footnote-definition" &&
      normalizeFootnoteLabel(String(props.label)) === normalized
    )
      occupied = true;
    if (
      typeof props.footnoteIdentifier === "string" &&
      normalizeFootnoteLabel(props.footnoteIdentifier) === normalized
    )
      occupied = true;
    for (const text of modelTexts(model))
      for (const delta of text.toDelta()) {
        const footnote = delta.attributes?.footnote as
          { label?: string; definitionId?: string } | undefined;
        if (
          footnote?.label &&
          (!except || footnote.definitionId !== except) &&
          normalizeFootnoteLabel(footnote.label) === normalized
        )
          occupied = true;
      }
    model.children.forEach(visit);
  };
  if (store.root) visit(store.root);
  return occupied;
}
/** The existing Markdown parser owns label admission; no second label grammar. */
export function validLocalFootnoteLabel(label: string) {
  const ast = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(`[^${label}]: body\n\nreference[^${label}]`);
  const definition = ast.children[0];
  const paragraph = ast.children[1];
  return (
    ast.children.length === 2 &&
    definition?.type === "footnoteDefinition" &&
    (definition.label ?? definition.identifier) === label &&
    paragraph?.type === "paragraph" &&
    paragraph.children.length === 2 &&
    paragraph.children[1].type === "footnoteReference" &&
    normalizeFootnoteLabel(label).length > 0
  );
}
export function renameLocalFootnote(
  store: Store,
  id: string,
  label: string,
  expectedLabel: string,
) {
  const definition = store.getModelById(
    id,
  ) as FootnoteDefinitionBlockModel | null;
  if (
    store.readonly ||
    definition?.flavour !== "myoxus:footnote-definition" ||
    definition.props.label !== expectedLabel ||
    !validLocalFootnoteLabel(label) ||
    labelOccupied(store, label, id)
  )
    return false;
  if (label === expectedLabel) return true;
  store.captureSync();
  store.transact(() => {
    store.updateBlock(definition, { label });
    const visit = (model: BlockModel) => {
      for (const text of modelTexts(model)) {
        let offset = 0;
        for (const delta of text.toDelta()) {
          const size =
            typeof delta.insert === "string" ? delta.insert.length : 1;
          const footnote = delta.attributes?.footnote as
            { definitionId?: string } | undefined;
          if (footnote?.definitionId === id)
            text.format(offset, size, {
              footnote: { label, definitionId: id },
            });
          offset += size;
        }
      }
      model.children.forEach(visit);
    };
    if (store.root) visit(store.root);
  });
  store.captureSync();
  return true;
}
export function localFootnoteInsertionNote(store: Store, model: BlockModel) {
  let current: BlockModel | null = model;
  while (current) {
    if (current.flavour === "myoxus:footnote-definition") return null;
    if (current.flavour === "myoxus:note") return current;
    current = store.getParent(current);
  }
  return null;
}
/** A menu keeps only an ephemeral caret, resolving against the current parent. */
export function localFootnoteCaret(model: BlockModel, offset: number) {
  const text = model.text;
  if (!text) return () => undefined;
  const point = Y.createRelativePositionFromTypeIndex(text.yText, offset);
  return () => {
    const position = Y.createAbsolutePositionFromRelativePosition(
      point,
      model.store.spaceDoc,
    );
    return model.store.getModelById(model.id) === model &&
      position?.type === text.yText
      ? position.index
      : undefined;
  };
}
/** Navigation is ephemeral; relative positions follow ordinary parent edits. */
const origins = new WeakMap<
  BlockStdScope,
  {
    definitionId: string;
    modelId: string;
    text: Y.Text;
    point: Y.RelativePosition;
    end: Y.RelativePosition;
    restore?: (index: number, length: number) => boolean;
  }
>();
function selectText(
  std: BlockStdScope,
  model: BlockModel,
  index: number,
  length = 0,
) {
  std.event.active = true;
  std.selection.setGroup("note", [
    std.selection.create(TextSelection, {
      from: { blockId: model.id, index, length },
      to: null,
    }),
  ]);
  std.view.getBlock(model.id)?.scrollIntoView({ block: "center" });
}
export function navigateLocalFootnote(
  std: BlockStdScope,
  id: string,
  origin?: {
    model: BlockModel;
    index: number;
    text?: Y.Text;
    restore?: (index: number, length: number) => boolean;
  },
) {
  const definition = std.store.getModelById(id);
  if (definition?.flavour !== "myoxus:footnote-definition") return false;
  const previous = origins.get(std);
  const originText = origin?.text ?? origin?.model.text?.yText;
  if (origin && originText?.doc === std.store.spaceDoc)
    origins.set(std, {
      definitionId: id,
      modelId: origin.model.id,
      text: originText,
      restore: origin.restore,
      point: Y.createRelativePositionFromTypeIndex(originText, origin.index),
      // Opposite associations bracket this atomic embed. A deleted origin must
      // not resolve to the next adjacent reference to the same definition.
      end: Y.createRelativePositionFromTypeIndex(
        originText,
        origin.index + 1,
        -1,
      ),
    });
  if (previous && previous.definitionId !== id)
    std.view.getBlock(previous.definitionId)?.requestUpdate();
  const findText = (model: BlockModel): BlockModel | undefined =>
    model.text ? model : model.children.map(findText).find(Boolean);
  const body = definition.children.map(findText).find(Boolean);
  if (body) selectText(std, body, 0);
  const view = std.view.getBlock(id);
  view?.scrollIntoView({ block: "center" });
  if (view && !body) {
    view.tabIndex = -1;
    view.focus();
  }
  view?.requestUpdate();
  return true;
}
/** Resolve the exact originating embed before enabling a return control. */
function localFootnoteReturnOrigin(std: BlockStdScope, id: string) {
  const origin = origins.get(std);
  if (!origin || origin.definitionId !== id) return undefined;
  const model = std.store.getModelById(origin.modelId);
  if (!model || !modelTexts(model).some((text) => text.yText === origin.text))
    return undefined;
  const position = Y.createAbsolutePositionFromRelativePosition(
    origin.point,
    std.store.spaceDoc,
  );
  const end = Y.createAbsolutePositionFromRelativePosition(
    origin.end,
    std.store.spaceDoc,
  );
  if (
    !position ||
    position.type !== origin.text ||
    !end ||
    end.type !== origin.text ||
    end.index - position.index !== 1
  )
    return undefined;
  let offset = 0;
  const marker = (
    origin.text.toDelta() as DeltaInsert<Record<string, unknown>>[]
  ).find((delta) => {
    const start = offset;
    offset += typeof delta.insert === "string" ? delta.insert.length : 1;
    return (
      start <= position.index &&
      position.index < offset &&
      (delta.attributes?.footnote as { definitionId?: string } | undefined)
        ?.definitionId === id
    );
  });
  if (!marker) return undefined;
  return { origin, model, index: position.index };
}
export function canReturnLocalFootnote(std: BlockStdScope, id: string) {
  return localFootnoteReturnOrigin(std, id) !== undefined;
}
export function returnFromLocalFootnote(std: BlockStdScope, id: string) {
  const target = localFootnoteReturnOrigin(std, id);
  if (!target) return false;
  const { origin, model, index } = target;
  // Adjacent equal markers can coalesce into one Y.Text delta. The originating
  // inline embed occupies one character, not that delta's complete text run.
  const length = 1;
  if (origin.restore) return origin.restore(index, length);
  if (!model.text) return false;
  selectText(std, model, index, length);
  return true;
}
export function insertLocalFootnote(
  std: BlockStdScope,
  model: BlockModel,
  index: number,
  existingId?: string,
  placement: FootnotePlacement = "footnote",
) {
  const { store } = std;
  const note = localFootnoteInsertionNote(store, model);
  if (
    !store.schema.flavourSchemaMap.has("myoxus:footnote-definition") ||
    !store.schema.flavourSchemaMap.has("myoxus:paragraph") ||
    store.readonly ||
    store.getModelById(model.id) !== model ||
    !model.text ||
    !note ||
    index < 0 ||
    index > model.text.length
  )
    return null;
  const definition = existingId
    ? localFootnoteDefinitions(store).find((item) => item.id === existingId)
    : undefined;
  if (
    existingId &&
    (!definition || footnotePlacement(definition.props.placement) !== placement)
  )
    return null;
  let label = definition?.props.label ?? "1";
  if (!definition) {
    let number = 1;
    while (labelOccupied(store, String(number))) number++;
    label = String(number);
  }
  let id = definition?.id;
  store.captureSync();
  store.transact(() => {
    if (!id) {
      id = store.addBlock(
        "myoxus:footnote-definition",
        { label, placement },
        note,
      );
      // Reactive BlockModels materialize after the enclosing Yjs transaction.
      store.addBlock("myoxus:paragraph", { text: new Text() }, id);
    }
    model.text!.insert(" ", index, { footnote: { label, definitionId: id! } });
  });
  store.captureSync();
  void std.host.updateComplete.then(() =>
    navigateLocalFootnote(std, id!, { model, index }),
  );
  return id;
}

/** Change only placement, with one history entry and a stale-menu guard. */
export function setLocalFootnotePlacement(
  store: Store,
  id: string,
  placement: FootnotePlacement,
  expected: FootnotePlacement | undefined,
) {
  const definition = localFootnoteDefinitions(store).find(
    (item) => item.id === id,
  );
  if (
    store.readonly ||
    !definition ||
    !footnotePlacement(placement) ||
    footnotePlacement(definition.props.placement) !== expected
  )
    return false;
  if (expected === placement) return true;
  store.captureSync();
  store.transact(() => store.updateBlock(definition, { placement }));
  store.captureSync();
  return true;
}
