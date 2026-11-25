// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { LockIcon } from "@myoxus/icons/react";
import { useLiveData, useServiceOptional } from "@myoxus/infra";
import { Badge, Group, notify } from "@myoxus/ui-facade";
import type { TableBlockModel } from "@virgultum/core/models";
import {
  DefaultEditorI18nService,
  editorMessage,
  resolveEditorMessage,
  templateRepeatActions,
  templateRepeatLabel,
  templateVariableLabel,
  textProtectionMessages,
  type SelectionAction,
} from "@virgultum/core/services";
import {
  cellContainerStyle,
  ColumnMaxWidth,
  ColumnMinWidth,
  columnOptionsCellStyle,
  columnRightIndicatorStyle,
  DefaultColumnWidth,
  rowOptionsCellStyle,
  TableCellPadding,
  tableContainer,
  TableDataManager,
  tableMenuActions,
  tableWrapper,
  type TableAreaSelection,
  type TableMenuTarget,
} from "@virgultum/content/page-table";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import type * as Y from "yjs";

import { TemplateDocService } from "../../../modules/template-doc";
import { EditorActionMenu } from "../../view-extensions/editor-view/editor-chrome/action-menu";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import { EditorTableControl } from "../../view-extensions/editor-view/editor-chrome/table-control";
import { configureEditorI18n } from "../editor-i18n";
import { usePageFloatingAnchor } from "./page-floating-anchor";
import {
  clearCellFormatting,
  PageTableCell,
  readCellSelection,
  restoreCellSelection,
  sliceYTextDelta,
  toggleCellFormat,
  type CellSelectionSnapshot,
} from "./page-table-cell";
import { useTemplateVariablePicker } from "./template-variable-picker";

type Address = { row: string; column: string };
type Rectangle = { first: Address; last: Address };
type Menu = {
  anchor: HTMLElement;
  at: Address;
  target: TableMenuTarget;
  cells: ReturnType<TableDataManager["getCellsBySelection"]>;
  caret: { start: number; end: number };
};

function same(a: Address, b: Address) {
  return a.row === b.row && a.column === b.column;
}

export default function PageTable({
  model,
  readonly,
  detached = false,
  readCell,
  onOpenLink,
}: {
  model: TableBlockModel;
  readonly: boolean;
  detached?: boolean;
  readCell?: (
    model: TableBlockModel,
    text: Y.Text,
  ) => import("react").ReactNode;
  onOpenLink?: (url: string, button: number) => void;
}) {
  const t = useI18n(),
    store = model.store;
  const manager = useMemo(() => new TableDataManager(model), [model]);
  const list = useServiceOptional(TemplateDocService)?.list;
  const template = useLiveData(
    useMemo(
      () => (readonly || !list ? undefined : list.isTemplate$(store.id)),
      [readonly, list, store.id],
    ),
  );
  const { openTemplateVariablePicker, templateVariablePicker } =
    useTemplateVariablePicker();
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
  const [richSelection, setRichSelection] =
    useState<CellSelectionSnapshot | null>(null);
  const [formatAnchor, setFormatAnchor] = useState<HTMLElement | null>(null);
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

  const cellEditor = (id: Address) =>
    parent.current?.querySelector<HTMLElement>(
      `[data-cell-editor][data-row="${CSS.escape(id.row)}"][data-column="${CSS.escape(id.column)}"]`,
    ) ?? null;

  const focus = (id: Address, offset?: number) => {
    const el =
      cellEditor(id) ??
      parent.current?.querySelector<HTMLElement>("[data-cell-editor]");
    if (!el) return;
    el.focus({ preventScroll: true });
    if (offset !== undefined) {
      restoreCellSelection(el, offset);
    }
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
        !e.target.closest(
          '[role="menu"],[role="menuitem"],[role="toolbar"],[role="dialog"]',
        )
      ) {
        select(null);
        setRichSelection(null);
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

  usePageFloatingAnchor({
    active: Boolean(menu && menu.anchor.isConnected),
    reference: menu?.anchor ?? null,
    anchor,
  });

  const formatVirtualRef = useMemo(
    () =>
      richSelection
        ? { getBoundingClientRect: () => richSelection.rect }
        : null,
    [richSelection],
  );
  usePageFloatingAnchor({
    active: Boolean(richSelection && !menu && !multi),
    reference: formatVirtualRef,
    anchor: formatAnchor,
  });

  const pasteArea = (data: DataTransfer) => {
    if (!editable() || !selected) return false;
    const html = data.getData("text/html");
    const parsed = html
      ? new DOMParser().parseFromString(html, "text/html")
      : null;
    const table = parsed?.querySelector("table");
    const plain = data.getData("text/plain");
    const isTabularText = plain.includes("\t");
    if (!multi && !table && !isTabularText) return false;
    store.captureSync();
    manager.pasteArea(
      selected,
      table
        ? Array.from(table.rows, (row) =>
            Array.from(row.cells, (c) => c.textContent ?? ""),
          )
        : plain.split(/\r?\n/).map((line) => line.split("\t")),
    );
    store.captureSync();
    return true;
  };

  const copyArea = (e: ClipboardEvent, isCut: boolean) => {
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

  const show = (at: Address, target: TableMenuTarget, trigger: HTMLElement) => {
    if (!editable()) return;
    setRichSelection(null);
    if (target.kind !== "cell" || !multi) select({ first: at, last: at });
    const el = cellEditor(at);
    const text = manager.getCell(at.row, at.column)?.text.yText;
    const currentSel = el ? readCellSelection(el) : null;
    const fallbackEnd = text?.length ?? 0;
    setMenu({
      at,
      target,
      anchor: trigger,
      cells:
        target.kind === "cell" ? manager.getCellsBySelection(target.area) : [],
      caret: currentSel ?? { start: fallbackEnd, end: fallbackEnd },
    });
  };

  const commands = () => {
    if (!menu) return [];
    const live = () =>
      editable() &&
      menuOwner.current === menu &&
      menu.anchor.isConnected &&
      !!cellEditor(menu.at);
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

    const activeRowId = menu.at.row;
    const activeColumnId = menu.at.column;
    const capturedCaret = menu.caret;

    const buildTextProtectionActions = (
      sel: TableAreaSelection,
    ): SelectionAction[] => {
      if (
        sel.rowStartIndex !== sel.rowEndIndex ||
        sel.columnStartIndex !== sel.columnEndIndex
      ) {
        return [];
      }
      const rowId = rows[sel.rowStartIndex]?.rowId;
      const columnId = cols[sel.columnStartIndex]?.columnId;
      if (!rowId || !columnId) return [];
      const cell = manager.getCell(rowId, columnId);
      if (!cell) return [];
      const mode = cell.textProtection;
      if (mode !== undefined && mode !== "source" && mode !== "fixed")
        return [];
      const fixed = mode === "fixed";
      if (!fixed && !template) return [];
      return [
        {
          id: "text-protection",
          label: resolveEditorMessage(
            fixed
              ? textProtectionMessages.fixed
              : mode === "source"
                ? textProtectionMessages.unprotect
                : textProtectionMessages.protect,
            i18n,
          ),
          icon: "LockIcon",
          disabled: readonly || fixed,
          active: mode === "source" || fixed,
          run: () => {
            const current = manager.getCell(rowId, columnId);
            if (!editable() || !template || current !== cell || fixed) return;
            store.transact(() => {
              if (mode === "source") delete cell.textProtection;
              else cell.textProtection = "source";
            });
          },
        },
      ];
    };

    const buildRowRepeatActions = (rowId: string): SelectionAction[] => {
      if (!template) return [];
      const canWrite = () =>
        editable() && Boolean(template) && manager.canSetRowRepeat(rowId);
      return [
        {
          id: "row-repeat",
          label: resolveEditorMessage(templateRepeatLabel, i18n),
          icon: "RefreshCwIcon",
          disabled: !canWrite(),
          control: {
            type: "menu",
            items: templateRepeatActions({
              i18n,
              canWrite,
              unit: () => ({
                binding: manager.rows$.value.find((r) => r.rowId === rowId)
                  ?.repeat,
                texts: manager.columns$.value.map(
                  (col) =>
                    manager.getCell(rowId, col.columnId)?.text.toString() ?? "",
                ),
                leaf: model.children.length === 0,
              }),
              change: (repeat) => {
                if (!manager.setRowRepeat(rowId, repeat)) {
                  notify.warning({
                    title:
                      t["com.myoxus.editor.table.header-repeat-conflict"](),
                  });
                }
              },
            }),
          },
        },
      ];
    };

    const buildTemplateVariableActions = (): SelectionAction[] => {
      const cell = manager.getCell(activeRowId, activeColumnId);
      if (!cell || cell.textProtection === "fixed") return [];
      const yText = cell.text.yText;
      const canWrite = () => {
        const current = manager.getCell(activeRowId, activeColumnId);
        return (
          editable() &&
          current?.textProtection !== "fixed" &&
          current?.text.yText === yText
        );
      };
      let nextCaret = Math.min(capturedCaret.start, yText.length);
      return [
        {
          id: "document-fields",
          label: resolveEditorMessage(
            template
              ? templateVariableLabel
              : editorMessage(
                  "com.myoxus.editor.field.document-fields",
                  "Document fields",
                ),
            i18n,
          ),
          icon: "TextIcon",
          disabled: false,
          run: () => {
            if (!canWrite()) return;
            openTemplateVariablePicker({
              i18n,
              templateSource: Boolean(template),
              canWrite,
              insert: (token) => {
                if (!canWrite() || !template) return;
                const start = Math.min(capturedCaret.start, yText.length);
                const end = Math.min(capturedCaret.end, yText.length);
                store.captureSync();
                store.transact(() => {
                  if (end > start) yText.delete(start, end - start);
                  yText.insert(start, token);
                });
                nextCaret = start + token.length;
                store.captureSync();
              },
              insertField: (field) => {
                if (!canWrite() || (field.type === "input" && !template))
                  return;
                const start = Math.min(capturedCaret.start, yText.length);
                const end = Math.min(capturedCaret.end, yText.length);
                store.captureSync();
                store.transact(() => {
                  if (end > start) yText.delete(start, end - start);
                  yText.insert(start, " ", { documentField: field });
                });
                nextCaret = start + 1;
                store.captureSync();
              },
              onClose: () => {
                requestAnimationFrame(() => focus(menu.at, nextCaret));
              },
            });
          },
        },
      ];
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
        rowRepeatActions: buildRowRepeatActions,
        textProtectionActions: buildTextProtectionActions,
        templateVariableActions: buildTemplateVariableActions,
      },
      i18n,
      menu.target,
      currentArea,
      () => {},
    ).map(wrap);
  };

  const formatActions = useMemo<SelectionAction[]>(() => {
    if (!richSelection || !editable()) return [];
    const { row, column, start, end, text } = richSelection;
    const ops = sliceYTextDelta(text, start, end - start);
    const hasMark = (mark: string) =>
      ops.length > 0 &&
      ops.every((op) =>
        Boolean((op.attributes as Record<string, unknown>)?.[mark]),
      );

    const applyMark = (
      mark: "bold" | "italic" | "underline" | "strike" | "code",
    ) => {
      toggleCellFormat(model, text, start, end, mark);
      requestAnimationFrame(() => {
        const el = cellEditor({ row, column });
        if (el) {
          el.focus({ preventScroll: true });
          restoreCellSelection(el, start, end);
        }
      });
    };

    return [
      {
        id: "cell-bold",
        label: t["Bold"](),
        icon: "BoldIcon",
        active: hasMark("bold"),
        disabled: false,
        run: () => applyMark("bold"),
      },
      {
        id: "cell-italic",
        label: t["com.myoxus.keyboardShortcuts.italic"](),
        icon: "ItalicIcon",
        active: hasMark("italic"),
        disabled: false,
        run: () => applyMark("italic"),
      },
      {
        id: "cell-underline",
        label: t["com.myoxus.keyboardShortcuts.underline"](),
        icon: "UnderLineIcon",
        active: hasMark("underline"),
        disabled: false,
        run: () => applyMark("underline"),
      },
      {
        id: "cell-strike",
        label: t["com.myoxus.keyboardShortcuts.strikethrough"](),
        icon: "StrikeThroughIcon",
        active: hasMark("strike"),
        disabled: false,
        run: () => applyMark("strike"),
      },
      {
        id: "cell-code",
        label: t["com.myoxus.editor.keyboard.code"](),
        icon: "CodeIcon",
        active: hasMark("code"),
        disabled: false,
        run: () => applyMark("code"),
      },
      {
        id: "cell-clear-format",
        label: t["com.myoxus.editor.keyboard.default-color"](),
        icon: "ResetIcon",
        disabled: false,
        run: () => {
          clearCellFormatting(model, text, start, end);
          requestAnimationFrame(() => {
            const el = cellEditor({ row, column });
            if (el) {
              el.focus({ preventScroll: true });
              restoreCellSelection(el, start, end);
            }
          });
        },
      },
    ];
  }, [model, richSelection, t]);

  const selectionToolbarControls = useMemo(() => {
    if (!richSelection || menu || multi || !formatActions.length) return null;
    const snapshot = {
      open: true,
      key: `table-cell:${richSelection.row}:${richSelection.column}`,
      placement: "top" as const,
      primary: formatActions,
      more: [],
    };
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      dismiss: () => setRichSelection(null),
      activate: () =>
        focus(
          { row: richSelection.row, column: richSelection.column },
          richSelection.end,
        ),
      setFloating: () => {},
      setAnchor: setFormatAnchor,
    };
  }, [formatActions, menu, multi, richSelection]);

  const padding = TableCellPadding[manager.density$.value ?? "normal"],
    appearance = manager.appearance$.value ?? "grid";

  const renderRows = (head: boolean) =>
    rows.map(({ rowId, backgroundColor, repeat }, r) => {
      const isHeader = r < (manager.headerRows$.value ?? 0);
      if (head !== isHeader) return null;
      const Tag = head ? "th" : "td";
      return (
        <tr key={rowId} data-row-id={rowId} data-row-repeat={repeat?.source}>
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
                data-cell-protection={cell?.textProtection}
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
                {c === 0 && repeat && (
                  <Group gap="xs" mb="2xs">
                    <Badge tone="info" data-testid="table-row-repeat-badge">
                      {repeat.source}
                    </Badge>
                  </Group>
                )}
                {cell?.textProtection && (
                  <Group gap="2xs" mb="2xs">
                    <Badge
                      tone="neutral"
                      prefix={<LockIcon />}
                      data-testid="table-cell-protection-badge"
                    >
                      {resolveEditorMessage(
                        cell.textProtection === "fixed"
                          ? textProtectionMessages.fixed
                          : textProtectionMessages.protect,
                        i18n,
                      )}
                    </Badge>
                  </Group>
                )}
                {cell &&
                  (readCell ? (
                    readCell(model, cell.text.yText)
                  ) : (
                    <PageTableCell
                      model={model}
                      text={cell.text.yText}
                      row={rowId}
                      column={col.columnId}
                      readonly={readonly}
                      textProtection={cell.textProtection}
                      onOpenLink={onOpenLink}
                      onRichSelectionChange={setRichSelection}
                      onFocusCell={(rId, cId) => {
                        select({
                          first: { row: rId, column: cId },
                          last: { row: rId, column: cId },
                        });
                      }}
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
                      const clearResizeHandlers = () => {
                        el.onpointerup = null;
                        el.onpointercancel = null;
                      };
                      el.onpointercancel = clearResizeHandlers;
                      el.onpointerup = (ev) => {
                        clearResizeHandlers();
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
          (e.target as Element).closest("button,[role=menu],[role=toolbar]")
        )
          return;
        const at = { row: td.dataset.rowId!, column: td.dataset.columnId! };
        drag.current = at;
        select({ first: at, last: at });
        if (!readCell && !(e.target as Element).closest("[data-cell-editor]")) {
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
          setRichSelection(null);
          parent.current.focus({ preventScroll: true });
          document.getSelection()?.removeAllRanges();
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onCopy={(e) => copyArea(e, false)}
      onCut={(e) => copyArea(e, true)}
      onPaste={(e) => {
        if (pasteArea(e.clipboardData)) e.preventDefault();
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
          store.captureSync();
          manager.clearCellsBySelection(selected);
          store.captureSync();
          return;
        }
        const editorEl = (e.target as Element).closest<HTMLElement>(
          "[data-cell-editor]",
        );
        if (e.key !== "Tab" || !editorEl) return;
        const { dataset } = editorEl;
        const r = rows.findIndex((row) => row.rowId === dataset.row),
          c = cols.findIndex((col) => col.columnId === dataset.column);
        const i = r * cols.length + c + (e.shiftKey ? -1 : 1);
        if (i < 0) return;
        e.preventDefault();
        const existingRow = rows[Math.floor(i / cols.length)]?.rowId;
        let row = existingRow;
        if (!row) {
          store.captureSync();
          row = manager.addRow(rows.length - 1);
          store.captureSync();
        }
        const column = cols[i % cols.length].columnId;
        const at = { row, column };
        select({ first: at, last: at });
        setRichSelection(null);
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
      {selectionToolbarControls && (
        <EditorSelectionToolbar controls={selectionToolbarControls} />
      )}
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
      {templateVariablePicker}
    </div>
  );
}
