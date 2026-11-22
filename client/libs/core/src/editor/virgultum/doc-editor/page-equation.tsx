// SPDX-License-Identifier: AGPL-3.0-or-later
import { autoUpdate } from "@floating-ui/dom";
import { useI18n } from "@myoxus/i18n";
import type { LatexBlockModel } from "@virgultum/core/models";
import katex from "katex";
import "katex/dist/katex.min.css";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { EditorEquation } from "../../view-extensions/editor-view/editor-chrome/equation-editor";
import type { PageLine } from "./plain-page-model";
import type { PageInlineObject } from "./page-inline-object";
import { restorePageRange } from "./plain-page-input";
import { createAbsolutePositionFromRelativePosition } from "yjs";
import { InlineContentTrigger } from "@myoxus/ui-facade";

export function InlineEquation({
  object,
  line,
  field,
  readonly,
}: {
  object: Extract<PageInlineObject, { kind: "latex" }>;
  line: PageLine;
  field: HTMLElement;
  readonly: boolean;
}) {
  const t = useI18n(),
    output = useRef<HTMLSpanElement>(null),
    [open, setOpen] = useState(false),
    [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState(object.source),
    store = line.model.store;
  useLayoutEffect(() => {
    const el = output.current!;
    if (!draft) {
      el.textContent = t["com.myoxus.editor.slash.equation"]();
      return;
    }
    try {
      katex.render(draft, el, { displayMode: false });
    } catch {
      el.textContent = t["com.myoxus.editor.equation.invalid"]();
    }
  }, [draft, t]);
  useLayoutEffect(() => {
    const target = output.current;
    if (!open || !anchor || !target) return;
    return autoUpdate(target, anchor, () => {
      const r = target.getBoundingClientRect();
      Object.assign(anchor.style, {
        position: "fixed",
        pointerEvents: "none",
        top: `${r.top}px`,
        left: `${r.left}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    });
  }, [open, anchor]);
  const getIndex = () => {
    if (!field.isConnected || store.getModelById(line.model.id) !== line.model)
      return;
    const at = createAbsolutePositionFromRelativePosition(
      object.start,
      store.spaceDoc,
    );
    if (
      !at ||
      at.type !== line.text ||
      line.model.text?.sliceToDelta(at.index, at.index + 1)[0]?.attributes
        ?.latex !== object.source
    )
      return;
    return at.index;
  };
  const restoreFocus = () => {
    const at = getIndex(),
      root = field.closest<HTMLElement>("[data-page-renderer]");
    if (at === undefined || !root) return;
    root
      .querySelector<HTMLElement>("[data-page-body]")
      ?.focus({ preventScroll: true });
    const p = { id: line.model.id, offset: at + 1 };
    restorePageRange(root, { anchor: p, focus: p });
  };
  const close = () => {
    const at = getIndex();
    setOpen(false);
    if (
      at === undefined ||
      readonly ||
      store.readonly ||
      store.hasFixedText(line.model) ||
      draft === object.source
    )
      return;
    restoreFocus();
    store.captureSync();
    store.transact(() => line.text.format(at, 1, { latex: draft }));
    store.captureSync();
  };
  return (
    <>
      {readonly ? (
        <span ref={output} />
      ) : (
        <InlineContentTrigger
          aria-label={t["com.myoxus.editor.slash.inline-equation"]()}
          onClick={() => setOpen(true)}
        >
          <span ref={output} />
        </InlineContentTrigger>
      )}
      {open && !readonly && (
        <EditorEquation
          controls={{ setAnchor, close, restoreFocus, position: "bottom" }}
          source={{ value: draft, change: setDraft }}
        />
      )}
    </>
  );
}

/** The formula source is the persisted scalar. KaTeX owns only its display
 * subtree; the popup never writes a DOM rendering back into the document. */
export default function PageEquation({
  model,
  readonly,
}: {
  model: LatexBlockModel;
  readonly: boolean;
}) {
  const t = useI18n(),
    block = useRef<HTMLDivElement>(null),
    output = useRef<HTMLDivElement>(null);
  const wasSelected = useRef(false);
  const [open, setOpen] = useState(false),
    [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const latex = model.props.latex;
  useLayoutEffect(() => {
    const el = output.current!;
    if (!latex) {
      el.textContent = t["com.myoxus.editor.slash.equation"]();
      return;
    }
    try {
      katex.render(latex, el, { displayMode: true });
    } catch {
      el.textContent = t["com.myoxus.editor.equation.invalid"]();
    }
  }, [latex, t]);
  useLayoutEffect(() => {
    const target = block.current;
    if (!open || !anchor || !target) return;
    return autoUpdate(target, anchor, () => {
      const r = target.getBoundingClientRect();
      Object.assign(anchor.style, {
        position: "fixed",
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        pointerEvents: "none",
      });
    });
  }, [open, anchor]);
  useLayoutEffect(() => {
    if (!open) return;
    model.store.captureSync();
    return () => model.store.captureSync();
  }, [model, open]);
  useLayoutEffect(() => {
    if (readonly) setOpen(false);
  }, [readonly]);
  const close = useCallback(() => setOpen(false), []);
  const restoreFocus = () => block.current?.focus({ preventScroll: true });
  return (
    <>
      <div
        ref={block}
        tabIndex={-1}
        contentEditable={false}
        data-page-equation={model.id}
        data-block-id={model.id}
        onPointerDown={() => {
          wasSelected.current = document.activeElement === block.current;
        }}
        onClick={() => {
          restoreFocus();
          if (!readonly && wasSelected.current) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !readonly) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <div ref={output} />
      </div>
      {open && !readonly && (
        <EditorEquation
          controls={{ close, setAnchor, restoreFocus, position: "bottom" }}
          source={{
            value: latex,
            change: (value) => {
              if (
                model.store.readonly ||
                model.store.getModelById(model.id) !== model ||
                model.props.latex !== latex
              )
                return;
              model.store.updateBlock(model, { latex: value });
            },
          }}
        />
      )}
    </>
  );
}
