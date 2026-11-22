// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FootnoteDefinitionBlockModel } from "@virgultum/core/models";
import {
  localFootnotePresentation,
  setLocalFootnotePlacement,
} from "@virgultum/core/commands";
import {
  FootnoteHeader,
  FootnoteMarker,
} from "../../view-extensions/editor-view/footnote";
import { useRef, useState, useLayoutEffect } from "react";
import type { PageLine } from "./plain-page-model";
import { restorePageRange } from "./plain-page-input";
import * as Y from "yjs";

type Origin = {
  point: Y.RelativePosition;
  end: Y.RelativePosition;
  line: PageLine;
  definition: string;
};
const origins = new WeakMap<HTMLElement, Origin>();
const changed = "page-footnote-origin";
export function Marker({
  id,
  point,
  line,
  field,
}: {
  id: string;
  point: Y.RelativePosition;
  line: PageLine;
  field: HTMLElement;
}) {
  const store = line.model.store;
  const presentation = localFootnotePresentation(store).get(id);
  return (
    <sup>
      <FootnoteMarker
        {...presentation}
        missing={!presentation?.placement}
        navigate={() => {
          const root = field.closest<HTMLElement>("[data-page-renderer]");
          const header = root?.querySelector<HTMLElement>(
            `[data-page-footnote="${CSS.escape(id)}"]`,
          );
          const at = Y.createAbsolutePositionFromRelativePosition(
            point,
            store.spaceDoc,
          );
          if (!header || !root || !at || at.type !== line.text) return;
          origins.set(root, {
            line,
            definition: id,
            point,
            end: Y.createRelativePositionFromTypeIndex(
              line.text,
              at.index + 1,
              -1,
            ),
          });
          root.dispatchEvent(new Event(changed));
          header.scrollIntoView({ block: "center" });
          const model = store.getModelById(id);
          const findText = (m: typeof model): string | undefined =>
            m?.text &&
            root.querySelector(`[data-page-text="${CSS.escape(m.id)}"]`)
              ? m.id
              : m?.children.map(findText).find(Boolean);
          const first = findText(model);
          if (first) {
            const p = { id: first, offset: 0 };
            root
              .querySelector<HTMLElement>("[data-page-body]")
              ?.focus({ preventScroll: true });
            restorePageRange(root, { anchor: p, focus: p });
          } else header.focus({ preventScroll: true });
        }}
      />
    </sup>
  );
}
export default function Definition({
  model,
  readonly,
}: {
  model: FootnoteDefinitionBlockModel;
  readonly: boolean;
}) {
  const el = useRef<HTMLDivElement>(null),
    [, update] = useState(0);
  useLayoutEffect(() => {
    const root = el.current?.closest("[data-page-renderer]");
    const sync = () => update((n) => n + 1);
    root?.addEventListener(changed, sync);
    return () => root?.removeEventListener(changed, sync);
  }, []);
  const store = model.store,
    id = model.id;
  const lookup = () => {
    const root = el.current?.closest<HTMLElement>("[data-page-renderer]"),
      o = root && origins.get(root);
    if (
      !root ||
      !o ||
      o.definition !== id ||
      store.getModelById(o.line.model.id) !== o.line.model
    )
      return;
    const a = Y.createAbsolutePositionFromRelativePosition(
        o.point,
        store.spaceDoc,
      ),
      b = Y.createAbsolutePositionFromRelativePosition(o.end, store.spaceDoc);
    if (
      !a ||
      !b ||
      a.type !== o.line.text ||
      b.type !== o.line.text ||
      b.index !== a.index + 1 ||
      o.line.model.text?.sliceToDelta(a.index, b.index)[0]?.attributes?.footnote
        ?.definitionId !== id
    )
      return;
    return { root, line: o.line, from: a.index, to: b.index };
  };
  const presentation = localFootnotePresentation(store).get(id);
  return (
    <div
      ref={el}
      tabIndex={-1}
      data-page-footnote={id}
      data-block-id={id}
      contentEditable={false}
    >
      <FootnoteHeader
        titleId={`myoxus-note-heading-${id}`}
        {...presentation}
        readonly={readonly}
        canReturn={!!lookup()}
        returnToMarker={() => {
          const at = lookup();
          if (!at) return;
          const field = at.root.querySelector<HTMLElement>(
            `[data-page-text="${CSS.escape(at.line.model.id)}"]`,
          );
          field?.scrollIntoView({ block: "center" });
          at.root
            .querySelector<HTMLElement>("[data-page-body]")
            ?.focus({ preventScroll: true });
          restorePageRange(at.root, {
            anchor: { id: at.line.model.id, offset: at.from },
            focus: { id: at.line.model.id, offset: at.to },
          });
        }}
        changePlacement={(p) => {
          if (!readonly)
            setLocalFootnotePlacement(store, id, p, presentation?.placement);
        }}
        remove={() => {
          if (readonly || store.readonly || store.getModelById(id) !== model)
            return;
          store.captureSync();
          store.deleteBlock(model);
          store.captureSync();
        }}
      />
    </div>
  );
}
