// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { autoUpdate } from "@floating-ui/dom";
import { useLayoutEffect, useState } from "react";
import { copyTextToClipboard } from "@virgultum/core/primitives/utils";
import { normalizeUrl, isValidUrl } from "@virgultum/core/utils/url";
import type {
  EditorSelectionState,
  SelectionAction,
} from "@virgultum/core/services";
import type { PageLine } from "./plain-page-model";
import {
  resolveBookmark,
  restorePageRange,
  type PageBookmark,
  type PageIntent,
} from "./plain-page-input";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import { EditorLinkEditor } from "../../view-extensions/editor-view/editor-chrome/link-editor";

export type LinkAnchor = {
  el: HTMLAnchorElement;
  line: PageLine;
  text: string;
  url: string;
  range: PageBookmark;
};
export default function LinkMenu({
  anchor: a,
  readonly,
  dismiss,
  handoff,
}: {
  anchor: LinkAnchor;
  readonly: boolean;
  dismiss: () => void;
  handoff: (r: PageBookmark, i: PageIntent) => void;
}) {
  const t = useI18n(),
    [editing, setEditing] = useState(false),
    [position, setPosition] = useState<HTMLElement | null>(null),
    [floating, setFloating] = useState<HTMLElement | null>(null);
  const store = a.line.model.store;
  const current = () => {
    const r = resolveBookmark(store, a.range);
    if (!r || r.anchor.id !== a.line.model.id || r.focus.id !== a.line.model.id)
      return;
    const run = a.line.model.text?.sliceToDelta(
      r.anchor.offset,
      r.focus.offset,
    );
    const visible = run?.filter((op) => op.insert?.length);
    if (
      visible?.length !== 1 ||
      visible[0].insert !== a.text ||
      visible[0].attributes?.link !== a.url
    )
      return;
    return {
      r,
      start: r.anchor.offset,
      end: r.focus.offset,
      attributes: visible[0].attributes,
    };
  };
  useLayoutEffect(() => {
    if (!a.el.isConnected || !current()) {
      dismiss();
      return;
    }
    if (!position) return;
    const abort = new AbortController(),
      opts = { signal: abort.signal };
    const cancel = (e: Event) => {
      if (
        e.target instanceof Node &&
        !a.el.contains(e.target) &&
        !floating?.contains(e.target) &&
        !(
          e.target instanceof Element &&
          e.target.closest("[data-range-sync-exclude],[role=menu]")
        )
      )
        dismiss();
    };
    document.addEventListener("pointerdown", cancel, opts);
    const positioner = autoUpdate(a.el, position, () => {
      if (!a.el.isConnected) {
        dismiss();
        return;
      }
      const r = a.el.getBoundingClientRect();
      Object.assign(position.style, {
        position: "fixed",
        pointerEvents: "none",
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    });
    return () => {
      abort.abort();
      positioner();
    };
  }, [a, position, floating, dismiss]);
  const apply = (
    op: "replace" | "unlink" | "delete",
    value?: string,
    label?: string,
  ) => {
    const at = current();
    if (!at || readonly || store.readonly || store.hasFixedText(a.line.model))
      return;
    const root = a.el.closest<HTMLElement>("[data-page-renderer]");
    let length = at.end - at.start;
    store.captureSync();
    store.transact(() => {
      if (op === "unlink") a.line.text.format(at.start, length, { link: null });
      else {
        a.line.text.delete(at.start, length);
        length = 0;
        if (op === "replace" && value) {
          const text = label || value;
          a.line.text.insert(at.start, text, { ...at.attributes, link: value });
          length = text.length;
        }
      }
    });
    store.captureSync();
    dismiss();
    if (root)
      requestAnimationFrame(() => {
        if (root.isConnected) {
          root
            .querySelector<HTMLElement>("[data-page-body]")
            ?.focus({ preventScroll: true });
          restorePageRange(root, {
            anchor: { id: a.line.model.id, offset: at.start },
            focus: { id: a.line.model.id, offset: at.start + length },
          });
        }
      });
  };
  const url = normalizeUrl(a.url);
  if (editing)
    return (
      <EditorLinkEditor
        controls={{
          editing: true,
          url,
          text: a.text,
          close: dismiss,
          setAnchor: setPosition,
          isValidUrl,
          confirm: (s, text) => {
            if (isValidUrl(s.trim()))
              apply("replace", normalizeUrl(s.trim()), text);
          },
        }}
      />
    );
  const action = (
    id: string,
    label: string,
    icon: SelectionAction["icon"],
    run: () => void,
  ): SelectionAction => ({ id, label, icon, run, disabled: false });
  const primary: SelectionAction[] = [
    {
      ...action("a.preview", url, "LinkIcon", () =>
        window.open(url, "_blank", "noopener,noreferrer"),
      ),
      showLabel: true,
    },
    action(
      "copy-link",
      t["com.myoxus.editor.toolbar.copy-link"](),
      "CopyIcon",
      () => {
        void copyTextToClipboard(url);
        dismiss();
      },
    ),
  ];
  if (!readonly) {
    primary.push(
      action(
        "edit",
        t["com.myoxus.editor.toolbar.edit-description"](),
        "EditIcon",
        () => setEditing(true),
      ),
    );
    if (
      !BUILD_CONFIG.isElectron &&
      /^https?:/.test(url) &&
      a.line.model.parent
    ) {
      let allowed = false;
      try {
        const schemas = store.schema.flavourSchemaMap;
        store.schema.validateSchema(
          schemas.get("myoxus:bookmark")!,
          schemas.get(a.line.model.parent.flavour)!,
        );
        allowed = true;
      } catch {}
      if (allowed)
        primary.push(
          action(
            "c.conversions",
            t["com.myoxus.editor.toolbar.inline-view"](),
            "LinkIcon",
            () => {
              if (current())
                handoff(a.range, {
                  kind: "link-command",
                  action: "convert",
                  button: 0,
                  url: a.url,
                });
            },
          ),
        );
    }
  }
  const state: EditorSelectionState = {
    open: true,
    key: a.line.model.id,
    placement: "top",
    primary,
    more: readonly
      ? []
      : [
          action(
            "b.remove-link",
            t["com.myoxus.database.rich-text.unlink"](),
            "UnlinkIcon",
            () => apply("unlink"),
          ),
          {
            ...action("c.delete", t.Delete(), "DeleteIcon", () =>
              apply("delete"),
            ),
            variant: "destructive",
          },
        ],
  };
  return (
    <EditorSelectionToolbar
      controls={{
        getSnapshot: () => state,
        subscribe: () => () => {},
        setAnchor: setPosition,
        setFloating,
        activate: () => {},
        dismiss,
      }}
    />
  );
}
