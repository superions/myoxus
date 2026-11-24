// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { useService, useLiveData } from "@myoxus/infra";
import { TemplateDocService } from "../../../modules/template-doc";
import { notify } from "@myoxus/ui-facade";
import { configureEditorI18n } from "../editor-i18n";
import { DefaultEditorI18nService } from "@virgultum/core/services";
import { autoUpdate } from "@floating-ui/dom";
import type { TableBlockModel } from "@virgultum/core/models";
import type { SelectionAction } from "@virgultum/core/services";
import {
  TableDataManager,
  tableMenuActions,
  type TableAreaSelection,
  type TableMenuTarget,
  DefaultColumnWidth,
  ColumnMinWidth,
  ColumnMaxWidth,
  TableCellPadding,
  tableContainer,
  tableWrapper,
  cellContainerStyle,
  columnOptionsCellStyle,
  rowOptionsCellStyle,
  columnRightIndicatorStyle,
} from "@virgultum/content/page-table";
import {
  useRef,
  useMemo,
  useState,
  useLayoutEffect,
  type ClipboardEvent,
} from "react";
import * as Y from "yjs";
import { EditorTableControl } from "../../view-extensions/editor-view/editor-chrome/table-control";
import { EditorActionMenu } from "../../view-extensions/editor-view/editor-chrome/action-menu";
import type { PageIntent } from "./plain-page-input";
import { bindPageTextarea } from "./page-textarea";

type Address = { row: string; column: string };
type Rectangle = { first: Address; last: Address };
type Menu = {
  anchor: HTMLElement;
  at: Address;
  target: TableMenuTarget;
  cells: ReturnType<TableDataManager["getCellsBySelection"]>;
};
function same(a: Address, b: Address) {
  return a.row === b.row && a.column === b.column;
}

/** Bind a textarea to the existing cell Y.Text. Relative endpoints protect the
 * selection and composed replacement when a peer inserts before the caret. */
function CellText({
  text,
  readonly,
  id,
  model,
}: {
  text: Y.Text;
  readonly: boolean;
  id: Address;
  model: TableBlockModel;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(
    () =>
      bindPageTextarea(
        ref.current!,
        text,
        model.store,
        () =>
          model.store.getModelById(model.id) === model &&
          model.props.cells[`${id.row}:${id.column}`]?.text.yText === text,
      ),
    [text, model, id.row, id.column],
  );
  return (
    <textarea
      rows={1}
      data-cell-input=""
      data-row={id.row}
      data-column={id.column}
      ref={ref}
      readOnly={readonly}
      defaultValue={text.toString()}
    />
  );
}

export default function PageTable({
  model,
  readonly,
  handoff,
  detached = false,
  readCell,
}: {
  model: TableBlockModel;
  readonly: boolean;
  handoff: (intent: PageIntent) => void;
  detached?: boolean;
  readCell?: (
    model: TableBlockModel,
    text: Y.Text,
  ) => import("react").ReactNode;
}) {
  const t = useI18n(),
    store = model.store;
  const manager = useMemo(() => new TableDataManager(model), [model]);
  const list = useService(TemplateDocService).list;
  const template = useLiveData(
    useMemo(
      () => (readonly ? undefined : list.isTemplate$(store.id)),
      [readonly, list, store.id],
    ),
  );
  const i18n = useMemo(
    () => new DefaultEditorI18nService(configureEditorI18n()),
    [],
  );
  const rows = manager.rows$.value,
    cols = manager.columns$.value;
  const parent = useRef<HTMLDivElement>(null),
    drag = useRef<Address | null>(null);
  // Only IDs survive reload. Cell contents and editor history stay in the Store.
  const storageKey = detached
    ? null
    : `myoxus:page-table-selection:${store.workspace.id}:${store.id}`;
  const [selection, select] = useState<Rectangle | null>(() => {
      try {
        if (!storageKey) return null;
        const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        if (
          saved?.id === model.id &&
          [saved.first, saved.last].every(
            (p) =>
              p &&
              Object.hasOwn(model.props.rows, p.row) &&
              Object.hasOwn(model.props.columns, p.column),
          )
        )
          return { first: saved.first, last: saved.last };
      } catch {
        /* Storage can be unavailable in a restricted browser context. */
      }
      return null;
    }),
    [hover, setHover] = useState<Address | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null),
    [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuOwner = useRef(menu);
  menuOwner.current = menu;
  const area = (
    s: Rectangle | null = selection,
  ): TableAreaSelection | undefined => {
    if (!s) return;
    const [a, b] = [s.first.row, s.last.row].map((id) =>
      rows.findIndex((r) => r.rowId === id),
    );
    const [c, d] = [s.first.column, s.last.column].map((id) =>
      cols.findIndex((col) => col.columnId === id),
    );
    if (Math.min(a, b, c, d) < 0) return;
    return {
      type: "area",
      rowStartIndex: Math.min(a, b),
      rowEndIndex: Math.max(a, b),
      columnStartIndex: Math.min(c, d),
      columnEndIndex: Math.max(c, d),
    };
  };
  const editable = () =>
    !readonly &&
    !store.readonly &&
    store.getModelById(model.id) === model &&
    !!parent.current?.isConnected;
  const input = (id: Address) =>
    parent.current?.querySelector<HTMLTextAreaElement>(
      `textarea[data-row="${CSS.escape(id.row)}"][data-column="${CSS.escape(id.column)}"]`,
    );
  const focus = (id: Address) => {
    const el = input(id) ?? parent.current?.querySelector("textarea");
    el?.focus({ preventScroll: true });
  };
  const selected = area(),
    multi = selection && !same(selection.first, selection.last);
  useLayoutEffect(() => {
    if (!selection) return;
    try {
      if (storageKey)
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ id: model.id, ...selection }),
        );
    } catch {
      /* Optional navigation state. */
    }
    const leave = (e: PointerEvent) => {
      if (
        e.target instanceof Element &&
        !parent.current?.contains(e.target) &&
        !e.target.closest('[role="menu"],[role="menuitem"]')
      ) {
        select(null);
        try {
          if (
            storageKey &&
            JSON.parse(sessionStorage.getItem(storageKey) ?? "null")?.id ===
              model.id
          )
            sessionStorage.removeItem(storageKey);
        } catch {
          /* Optional navigation state. */
        }
      }
    };
    document.addEventListener("pointerdown", leave, true);
    return () => document.removeEventListener("pointerdown", leave, true);
  }, [model, storageKey, selection]);
  const includes = (r: number, c: number) =>
    !!selected &&
    r >= selected.rowStartIndex &&
    r <= selected.rowEndIndex &&
    c >= selected.columnStartIndex &&
    c <= selected.columnEndIndex;
  useLayoutEffect(() => {
    if (!menu || !anchor || !menu.anchor.isConnected) return;
    return autoUpdate(menu.anchor, anchor, () => {
      const rect = menu.anchor.getBoundingClientRect();
      Object.assign(anchor.style, {
        position: "fixed",
        pointerEvents: "none",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    });
  }, [menu, anchor]);
  const transfer = (
    at: Address,
    extras: Pick<Extract<PageIntent, { kind: "table-cell" }>, "menu" | "paste">,
  ) => {
    const el = input(at);
    const text = manager.getCell(at.row, at.column)?.text.yText;
    if (!el || !text || !editable()) return;
    handoff({
      kind: "table-cell",
      id: model.id,
      ...at,
      from: Y.createRelativePositionFromTypeIndex(text, el.selectionStart, -1),
      to: Y.createRelativePositionFromTypeIndex(text, el.selectionEnd, -1),
      ...extras,
    });
  };
  const paste = (data: DataTransfer, at: Address) => {
    if (!editable()) return;
    const html = data.getData("text/html");
    const parsed = html
      ? new DOMParser().parseFromString(html, "text/html")
      : null;
    if (parsed?.querySelector("[data-virgultum-snapshot]") && !multi) {
      const copy = new DataTransfer();
      for (const key of data.types)
        if (key !== "Files") copy.setData(key, data.getData(key));
      transfer(at, { paste: copy });
      return true;
    }
    if (!selected || !multi) return false;
    const table = parsed?.querySelector("table");
    manager.pasteArea(
      selected,
      table
        ? Array.from(table.rows, (row) =>
            Array.from(row.cells, (c) => c.textContent ?? ""),
          )
        : data
            .getData("text/plain")
            .split(/\r?\n/)
            .map((line) => line.split("\t")),
    );
    return true;
  };
  const copy = (e: ClipboardEvent, isCut: boolean) => {
    if (!multi || !selected) return;
    e.preventDefault();
    const captured = manager.captureArea(selected);
    const table = document.createElement("table");
    for (const values of captured.values) {
      const row = table.insertRow();
      for (const val of values) row.insertCell().textContent = val;
    }
    e.clipboardData.setData(
      "text/plain",
      captured.values.map((r) => r.join("\t")).join("\n"),
    );
    e.clipboardData.setData("text/html", table.outerHTML);
    if (isCut && editable()) captured.clearIfCurrent();
  };
  const show = (at: Address, target: TableMenuTarget, anchor: HTMLElement) => {
    if (!editable()) return;
    if (template && target.kind !== "column") {
      transfer(at, { menu: target.kind });
      return;
    }
    if (target.kind !== "cell" || !multi) select({ first: at, last: at });
    setMenu({
      at,
      target,
      anchor,
      cells:
        target.kind === "cell" ? manager.getCellsBySelection(target.area) : [],
    });
  };
  const commands = () => {
    if (!menu) return [];
    const live = () =>
      editable() &&
      menuOwner.current === menu &&
      menu.anchor.isConnected &&
      !!input(menu.at);
    const dismiss = () => {
      setMenu(null);
      queueMicrotask(() => focus(menu.at));
    };
    const wrap = (action: SelectionAction): SelectionAction => ({
      ...action,
      actions: action.actions?.map(wrap),
      control:
        action.control?.type === "menu"
          ? { ...action.control, items: action.control.items.map(wrap) }
          : action.control,
      run: action.run
        ? async (el, event) => {
            if (!live() || action.disabled) return;
            try {
              store.captureSync();
              await action.run!(el, event);
            } finally {
              store.captureSync();
              dismiss();
            }
          }
        : undefined,
    });
    const requested =
      menu.target.kind === "cell" ? menu.target.area : undefined;
    const captured = menu.cells;
    const currentArea = () => {
      if (!live() || !requested) return;
      const now = manager.getCellsBySelection(requested);
      return now.length === captured.length &&
        now.every((v, i) => v === captured[i])
        ? requested
        : undefined;
    };
    return tableMenuActions(
      {
        dataManager: manager,
        selectionController: {
          doCopyOrCut: (s, cut) => {
            const cap = manager.captureArea(s);
            void navigator.clipboard
              .writeText(cap.values.map((r) => r.join("\t")).join("\n"))
              .then(() => {
                if (cut && live()) cap.clearIfCurrent();
              })
              .catch(console.error);
          },
          doPaste: (value, s) =>
            manager.pasteArea(
              s,
              value.split(/\r?\n/).map((row) => row.split("\t")),
            ),
        },
        pasteFailed: () =>
          notify.error({ title: t["com.myoxus.editor.table.paste"]() }),
        notifyHeaderRepeatConflict: () =>
          notify.warning({
            title: t["com.myoxus.editor.table.header-repeat-conflict"](),
          }),
        rowRepeatActions: () => [],
        textProtectionActions: () => [],
        templateVariableActions: () => [
          {
            id: "document-fields",
            label: t["com.myoxus.editor.field.document-fields"](),
            icon: "TextIcon",
            disabled: false,
            run: () =>
              transfer(menu.at, {
                menu: menu.target.kind === "row" ? "row" : "cell",
              }),
          },
        ],
      },
      i18n,
      menu.target,
      currentArea,
      () => {},
    ).map(wrap);
  };
  const padding = TableCellPadding[manager.density$.value ?? "normal"],
    appearance = manager.appearance$.value ?? "grid";
  const renderRows = (head: boolean) =>
    rows.map(({ rowId, backgroundColor }, r) => {
      const isHeader = r < (manager.headerRows$.value ?? 0);
      if (head !== isHeader) return null;
      const Tag = head ? "th" : "td";
      return (
        <tr key={rowId} data-row-id={rowId}>
          {cols.map((col, c) => {
            const at = { row: rowId, column: col.columnId };
            const cell = manager.getCell(rowId, col.columnId);
            const color =
              cell?.backgroundColor ?? col.backgroundColor ?? backgroundColor;
            const control = (axis: "row" | "column") => (
              <div
                className={
                  axis === "row" ? rowOptionsCellStyle : columnOptionsCellStyle
                }
                style={{
                  opacity: (
                    axis === "row"
                      ? hover?.row === rowId
                      : hover?.column === col.columnId
                  )
                    ? 1
                    : undefined,
                }}
              >
                <EditorTableControl
                  controls={{
                    menu: true,
                    action: {
                      id: `drag-${axis}-handle`,
                      icon: "MoreHorizontalIcon",
                      label:
                        axis === "row"
                          ? t["com.myoxus.editor.table.row-options"]()
                          : t["com.myoxus.editor.table.column-options"](),
                      disabled: readonly,
                      run: (el) =>
                        show(
                          at,
                          {
                            kind: axis,
                            id: axis === "row" ? rowId : col.columnId,
                          },
                          el,
                        ),
                    },
                  }}
                />
              </div>
            );
            return (
              <Tag
                key={col.columnId}
                data-table-cell=""
                data-row-id={rowId}
                data-column-id={col.columnId}
                scope={head ? "col" : undefined}
                className={cellContainerStyle}
                data-area={includes(r, c) ? "selected" : undefined}
                style={{
                  minWidth: col.width ?? DefaultColumnWidth,
                  maxWidth: col.width ?? ColumnMaxWidth,
                  textAlign: col.textAlign,
                  backgroundColor: color?.startsWith("--")
                    ? `var(${color})`
                    : (color ??
                      (head
                        ? "var(--myoxus-background-secondary-color)"
                        : undefined)),
                  borderWidth:
                    appearance === "plain"
                      ? 0
                      : appearance === "ruled"
                        ? "1px 0"
                        : undefined,
                  padding: `${padding.block} ${padding.inline}`,
                }}
                onPointerEnter={() => setHover(at)}
                onContextMenu={(e) => {
                  if (readonly) return;
                  e.preventDefault();
                  const s = includes(r, c)
                    ? selected
                    : area({ first: at, last: at });
                  if (s) show(at, { kind: "cell", area: s }, e.currentTarget);
                }}
              >
                {cell &&
                  (readCell ? (
                    readCell(model, cell.text.yText)
                  ) : (
                    <CellText
                      id={at}
                      text={cell.text.yText}
                      readonly={readonly}
                      model={model}
                    />
                  ))}
                {!readonly && !r && control("column")}
                {!readonly && !c && control("row")}
                {!readonly && (
                  <div
                    className={columnRightIndicatorStyle}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const el = e.currentTarget,
                        start = e.clientX,
                        width = el.parentElement!.getBoundingClientRect().width;
                      el.setPointerCapture(e.pointerId);
                      el.onpointerup = (ev) => {
                        el.onpointerup = null;
                        if (editable()) {
                          store.captureSync();
                          manager.setColumnWidth(
                            col.columnId,
                            Math.max(
                              ColumnMinWidth,
                              width + ev.clientX - start,
                            ),
                          );
                          store.captureSync();
                        }
                      };
                    }}
                    style={{ opacity: 0 }}
                  />
                )}
              </Tag>
            );
          })}
        </tr>
      );
    });
  return (
    <div
      ref={parent}
      className={tableContainer}
      data-page-table={model.id}
      data-block-id={model.id}
      contentEditable={false}
      tabIndex={-1}
      onPointerDown={(e) => {
        const td = (e.target as Element).closest<HTMLElement>(
          "[data-table-cell]",
        );
        if (
          e.button !== 0 ||
          !td ||
          (e.target as Element).closest("button,[role=menu]")
        )
          return;
        const at = { row: td.dataset.rowId!, column: td.dataset.columnId! };
        drag.current = at;
        select({ first: at, last: at });
        if (!readCell && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          focus(at);
        }
      }}
      onPointerMove={(e) => {
        if (!drag.current || e.buttons !== 1) return;
        const td = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest<HTMLElement>("[data-table-cell]");
        if (!td || !parent.current?.contains(td)) return;
        const at = { row: td.dataset.rowId!, column: td.dataset.columnId! };
        if (!same(at, drag.current)) {
          select({ first: drag.current, last: at });
          parent.current.focus({ preventScroll: true });
          document.getSelection()?.removeAllRanges();
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onCopy={(e) => copy(e, false)}
      onCut={(e) => copy(e, true)}
      onPaste={(e) => {
        const at = selection?.first;
        if (at && paste(e.clipboardData, at)) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (!editable() || e.nativeEvent.isComposing) return;
        const key = e.key.toLowerCase();
        if ((e.metaKey || e.ctrlKey) && (key === "z" || key === "y")) {
          e.preventDefault();
          key === "y" || e.shiftKey ? store.redo() : store.undo();
          return;
        }
        if (
          multi &&
          selected &&
          (e.key === "Delete" || e.key === "Backspace")
        ) {
          e.preventDefault();
          manager.clearCellsBySelection(selected);
          return;
        }
        if (e.key !== "Tab" || !(e.target instanceof HTMLTextAreaElement))
          return;
        const { dataset } = e.target;
        const r = rows.findIndex((row) => row.rowId === dataset.row),
          c = cols.findIndex((col) => col.columnId === dataset.column);
        const i = r * cols.length + c + (e.shiftKey ? -1 : 1);
        if (i < 0) return;
        e.preventDefault();
        const row =
            rows[Math.floor(i / cols.length)]?.rowId ??
            manager.addRow(rows.length - 1),
          column = cols[i % cols.length].columnId;
        const at = { row, column };
        select({ first: at, last: at });
        requestAnimationFrame(() => focus(at));
      }}
    >
      <table
        className={tableWrapper}
        style={{
          marginInlineStart:
            model.props.textAlign === "right" ||
            model.props.textAlign === "center"
              ? "auto"
              : undefined,
          marginInlineEnd:
            model.props.textAlign === "center" ? "auto" : undefined,
        }}
      >
        {!!manager.headerRows$.value && <thead>{renderRows(true)}</thead>}
        <tbody>{renderRows(false)}</tbody>
      </table>
      {menu && (
        <EditorActionMenu
          controls={{
            actions: commands(),
            label: t["com.myoxus.editor.slash.table"](),
            setAnchor,
            close: () => {
              setMenu(null);
              focus(menu.at);
            },
          }}
        />
      )}
    </div>
  );
}
