// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { LockIcon } from "@myoxus/icons/react";
import { useLiveData, useServiceOptional } from "@myoxus/infra";
import { Badge, Group, notify } from "@myoxus/ui-facade";
import { TextAlign, type TableBlockModel } from "@virgultum/core/models";
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
  cellColorList,
  cellContainerStyle,
  ColumnMaxWidth,
  ColumnMinWidth,
  columnOptionsCellStyle,
  columnRightIndicatorStyle,
  DefaultColumnWidth,
  DefaultRowHeight,
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
import { usePageCaption } from "./page-caption";
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
  const mergeMap = manager.mergeMap$.value;
  const headerColumn = manager.headerColumn$.value;
  const striped = manager.striped$.value;
  const caption = usePageCaption(model, readonly);
  const parent = useRef<HTMLDivElement>(null),
    drag = useRef<Address | null>(null),
    suppressHandleClick = useRef(false);
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
    [hover, setHover] = useState<Address | null>(null),
    [hoverAxis, setHoverAxis] = useState<{
      kind: "column" | "row";
      id: string;
    } | null>(null);
  const [resizingCol, setResizingCol] = useState<{
    columnId: string;
    width: number;
  } | null>(null);
  const [reorder, setReorder] = useState<{
    kind: "column" | "row";
    fromIndex: number;
    targetIndex: number;
  } | null>(null);
  const [edgeDrag, setEdgeDrag] = useState<{
    kind: "column" | "row";
    delta: number;
  } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null),
    [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [richSelection, setRichSelection] =
    useState<CellSelectionSnapshot | null>(null);
  const [formatAnchor, setFormatAnchor] = useState<HTMLElement | null>(null);
  const [areaToolbarAnchor, setAreaToolbarAnchor] =
    useState<HTMLElement | null>(null);
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

  const areaVirtualRef = useMemo(() => {
    if (!multi || !selected || menu || richSelection || readonly) return null;
    return {
      getBoundingClientRect: () => {
        const container = parent.current;
        if (!container) return new DOMRect();
        const cells = Array.from(
          container.querySelectorAll<HTMLElement>('[data-area="selected"]'),
        );
        if (!cells.length) return new DOMRect();
        let left = Infinity,
          top = Infinity,
          right = -Infinity,
          bottom = -Infinity;
        for (const el of cells) {
          const r = el.getBoundingClientRect();
          if (r.left < left) left = r.left;
          if (r.top < top) top = r.top;
          if (r.right > right) right = r.right;
          if (r.bottom > bottom) bottom = r.bottom;
        }
        const topClearance = selected.rowStartIndex === 0 ? 28 : 0;
        return new DOMRect(
          left,
          top - topClearance,
          right - left,
          bottom - top + topClearance,
        );
      },
    };
  }, [multi, selected, menu, richSelection, readonly]);

  usePageFloatingAnchor({
    active: Boolean(areaVirtualRef),
    reference: areaVirtualRef,
    anchor: areaToolbarAnchor,
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
    if (target.kind === "column" && rows.length) {
      select({
        first: { row: rows[0].rowId, column: target.id },
        last: { row: rows[rows.length - 1].rowId, column: target.id },
      });
    } else if (target.kind === "row" && cols.length) {
      select({
        first: { row: target.id, column: cols[0].columnId },
        last: { row: target.id, column: cols[cols.length - 1].columnId },
      });
    } else if (target.kind !== "cell" || !multi) {
      select({ first: at, last: at });
    }
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

  const restoreFocusAfterMenu = (closedMenu: Menu) => {
    if (closedMenu.target.kind === "cell") {
      focus(closedMenu.at);
    } else {
      // Keep the whole column/row selection intact instead of collapsing it
      // into a single cell via cell focus.
      parent.current?.focus({ preventScroll: true });
    }
  };

  const appendColumn = () => {
    if (!editable()) return;
    store.captureSync();
    const column = manager.addColumn(cols.length - 1);
    store.captureSync();
    const firstRow = rows[0]?.rowId;
    if (firstRow && column) {
      const at = { row: firstRow, column };
      select({ first: at, last: at });
      setRichSelection(null);
      requestAnimationFrame(() => focus(at));
    }
  };

  const appendRow = () => {
    if (!editable()) return;
    store.captureSync();
    const row = manager.addRow(rows.length - 1);
    store.captureSync();
    const firstCol = cols[0]?.columnId;
    if (row && firstCol) {
      const at = { row, column: firstCol };
      select({ first: at, last: at });
      setRichSelection(null);
      requestAnimationFrame(() => focus(at));
    }
  };

  const commands = () => {
    if (!menu) return [];
    const live = () =>
      editable() &&
      menuOwner.current === menu &&
      menu.anchor.isConnected &&
      !!cellEditor(menu.at);
    const dismiss = () => {
      const closedMenu = menu;
      setMenu(null);
      queueMicrotask(() => restoreFocusAfterMenu(closedMenu));
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
        onDistributeColumns: () => {
          const available = Math.max(
            cols.length * ColumnMinWidth,
            (parent.current?.clientWidth ?? 800) - 68,
          );
          manager.distributeColumnWidths(available);
        },
        onToggleCaption: () => {
          if (manager.caption$.value) {
            manager.setCaption(undefined);
          } else {
            // Delay past menu-close focus restoration so the newly shown
            // caption input keeps focus instead of blurring empty.
            requestAnimationFrame(() => caption.show());
          }
        },
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

  const colorLabels = useMemo(
    () => ({
      Default: t["com.myoxus.editor.table.color.default"](),
      Blue: t["com.myoxus.editor.table.color.blue"](),
      Green: t["com.myoxus.editor.table.color.green"](),
      Grey: t["com.myoxus.editor.table.color.grey"](),
      Orange: t["com.myoxus.editor.table.color.orange"](),
      Purple: t["com.myoxus.editor.table.color.purple"](),
      Red: t["com.myoxus.editor.table.color.red"](),
      Teal: t["com.myoxus.editor.table.color.teal"](),
      Yellow: t["com.myoxus.editor.table.color.yellow"](),
    }),
    [t],
  );

  const areaActions = useMemo<SelectionAction[]>(() => {
    if (!multi || !selected || menu || richSelection || readonly) return [];
    const cells = manager.getCellsBySelection(selected);
    const hasFixed = cells.some((cell) => cell.textProtection === "fixed");
    const isFullColumnSelection =
      selected.rowStartIndex === 0 && selected.rowEndIndex === rows.length - 1;
    const toggleAreaMark = (
      mark: "bold" | "italic" | "underline" | "strike" | "code",
    ) => {
      if (!editable() || hasFixed) return;
      const nonEmpty = cells.filter((c) => c.text.length > 0);
      if (!nonEmpty.length) return;
      const allActive = nonEmpty.every((c) => {
        const ops = sliceYTextDelta(c.text.yText, 0, c.text.length);
        return (
          ops.length > 0 &&
          ops.every((op) =>
            Boolean((op.attributes as Record<string, unknown>)?.[mark]),
          )
        );
      });
      store.captureSync();
      store.transact(() => {
        for (const c of nonEmpty) {
          c.text.yText.format(0, c.text.length, {
            [mark]: allActive ? null : true,
          });
        }
      });
      store.captureSync();
    };
    const isMarkActive = (mark: string) => {
      const nonEmpty = cells.filter((c) => c.text.length > 0);
      return (
        nonEmpty.length > 0 &&
        nonEmpty.every((c) => {
          const ops = sliceYTextDelta(c.text.yText, 0, c.text.length);
          return (
            ops.length > 0 &&
            ops.every((op) =>
              Boolean((op.attributes as Record<string, unknown>)?.[mark]),
            )
          );
        })
      );
    };
    const primary: SelectionAction[] = [
      {
        id: "area-background",
        icon: "ColorPickerIcon",
        label: t["com.myoxus.editor.table.background-color"](),
        disabled: hasFixed,
        control: {
          type: "menu",
          items: [
            {
              id: "default",
              label: colorLabels.Default,
              swatch: "var(--myoxus-background-primary-color)",
              disabled: hasFixed,
              run: () => manager.setCellsBackgroundColor(selected, undefined),
            },
            ...cellColorList.map((opt) => ({
              id: opt.name.toLowerCase(),
              label:
                colorLabels[opt.name as keyof typeof colorLabels] ?? opt.name,
              swatch: opt.swatch,
              disabled: hasFixed,
              run: () => manager.setCellsBackgroundColor(selected, opt.color),
            })),
          ],
        },
      },
      {
        id: "area-bold",
        icon: "BoldIcon",
        label: t["Bold"](),
        active: isMarkActive("bold"),
        disabled: hasFixed,
        run: () => toggleAreaMark("bold"),
      },
      {
        id: "area-italic",
        icon: "ItalicIcon",
        label: t["com.myoxus.keyboardShortcuts.italic"](),
        active: isMarkActive("italic"),
        disabled: hasFixed,
        run: () => toggleAreaMark("italic"),
      },
      {
        id: "area-underline",
        icon: "UnderLineIcon",
        label: t["com.myoxus.keyboardShortcuts.underline"](),
        active: isMarkActive("underline"),
        disabled: hasFixed,
        run: () => toggleAreaMark("underline"),
      },
      {
        id: "area-strike",
        icon: "StrikeThroughIcon",
        label: t["com.myoxus.keyboardShortcuts.strikethrough"](),
        active: isMarkActive("strike"),
        disabled: hasFixed,
        run: () => toggleAreaMark("strike"),
      },
    ];
    if (isFullColumnSelection) {
      const selectedColIds = cols
        .slice(selected.columnStartIndex, selected.columnEndIndex + 1)
        .map((c) => c.columnId);
      primary.push({
        id: "area-align",
        icon: "TextAlignLeftIcon",
        label: t["com.myoxus.editor.toolbar.alignment"](),
        disabled: hasFixed,
        control: {
          type: "choice",
          presentation: "icons",
          value: cols[selected.columnStartIndex]?.textAlign ?? TextAlign.Left,
          options: [
            {
              value: TextAlign.Left,
              icon: "TextAlignLeftIcon",
              label: t["com.myoxus.editor.toolbar.align-left"](),
            },
            {
              value: TextAlign.Center,
              icon: "TextAlignCenterIcon",
              label: t["com.myoxus.editor.toolbar.align-center"](),
            },
            {
              value: TextAlign.Right,
              icon: "TextAlignRightIcon",
              label: t["com.myoxus.editor.toolbar.align-right"](),
            },
          ],
          change: (val) => {
            store.captureSync();
            for (const colId of selectedColIds) {
              manager.setColumnTextAlign(colId, val as TextAlign);
            }
            store.captureSync();
          },
        },
      });
    }
    if (manager.canMergeCells(selected)) {
      primary.push({
        id: "area-merge",
        icon: "GroupIcon",
        label: t["com.myoxus.editor.table.merge-cells"](),
        disabled: hasFixed,
        run: () => manager.mergeCells(selected),
      });
    }
    if (manager.canUnmergeCells(selected)) {
      primary.push({
        id: "area-unmerge",
        icon: "UngroupIcon",
        label: t["com.myoxus.editor.table.unmerge-cells"](),
        disabled: hasFixed,
        run: () => manager.unmergeCells(selected),
      });
    }
    primary.push(
      {
        id: "area-copy",
        icon: "CopyIcon",
        label: t["Copy"](),
        disabled: false,
        run: () => {
          const cap = manager.captureArea(selected);
          void navigator.clipboard
            ?.writeText(cap.values.map((r) => r.join("\t")).join("\n"))
            .catch(() => undefined);
        },
      },
      {
        id: "area-clear",
        icon: "CloseIcon",
        label: t["com.myoxus.editor.table.clear-contents"](),
        disabled: hasFixed,
        run: () => manager.clearCellsBySelection(selected),
      },
    );
    return primary;
  }, [
    multi,
    selected,
    menu,
    richSelection,
    readonly,
    manager,
    rows,
    cols,
    t,
    colorLabels,
    store,
  ]);

  const areaToolbarControls = useMemo(() => {
    if (!areaActions.length || !selected) return null;
    const snapshot = {
      open: true,
      key: `table-area:${selected.rowStartIndex}:${selected.columnStartIndex}:${selected.rowEndIndex}:${selected.columnEndIndex}`,
      placement: "top" as const,
      primary: areaActions,
      more: [],
    };
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      dismiss: () => select(null),
      activate: () => parent.current?.focus({ preventScroll: true }),
      setFloating: () => {},
      setAnchor: setAreaToolbarAnchor,
    };
  }, [areaActions, selected]);

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

  const startAxisReorder = (
    axis: "column" | "row",
    fromIndex: number,
    e: React.PointerEvent<HTMLElement>,
  ) => {
    if (readonly || e.button !== 0 || !editable()) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let latestTarget = fromIndex;
    const computeTarget = (clientX: number, clientY: number) => {
      const container = parent.current;
      if (!container) return fromIndex;
      if (axis === "column") {
        const rects = cols.map((c) =>
          container
            .querySelector<HTMLElement>(
              `[data-table-cell][data-column-id="${CSS.escape(c.columnId)}"]`,
            )
            ?.getBoundingClientRect(),
        );
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (r && clientX < r.left + r.width / 2) return i;
        }
        return cols.length;
      }
      const rects = rows.map((row) =>
        container
          .querySelector<HTMLElement>(
            `tr[data-row-id="${CSS.escape(row.rowId)}"]`,
          )
          ?.getBoundingClientRect(),
      );
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r && clientY < r.top + r.height / 2) return i;
      }
      return rows.length;
    };
    const onMove = (ev: PointerEvent) => {
      const dist =
        axis === "column"
          ? Math.abs(ev.clientX - startX)
          : Math.abs(ev.clientY - startY);
      if (!dragging && dist < 6) return;
      if (!dragging) {
        dragging = true;
        suppressHandleClick.current = true;
        setMenu(null);
      }
      latestTarget = computeTarget(ev.clientX, ev.clientY);
      setReorder({ kind: axis, fromIndex, targetIndex: latestTarget });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (dragging) {
        setReorder(null);
        if (
          editable() &&
          latestTarget !== fromIndex &&
          latestTarget !== fromIndex + 1
        ) {
          const after = latestTarget - 1;
          store.captureSync();
          if (axis === "column") {
            manager.moveColumn(fromIndex, after);
          } else if (!manager.moveRow(fromIndex, after)) {
            notify.warning({
              title: t["com.myoxus.editor.table.header-repeat-conflict"](),
            });
          }
          store.captureSync();
        }
        requestAnimationFrame(() => {
          suppressHandleClick.current = false;
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const autoFitColumn = (columnId: string) => {
    if (!editable() || !parent.current) return;
    const editors = Array.from(
      parent.current.querySelectorAll<HTMLElement>(
        `[data-cell-editor][data-column="${CSS.escape(columnId)}"]`,
      ),
    );
    if (!editors.length) return;
    const probe = document.createElement("span");
    const cs = getComputedStyle(editors[0]!);
    Object.assign(probe.style, {
      position: "fixed",
      visibility: "hidden",
      whiteSpace: "pre",
      font: cs.font,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      fontWeight: "600",
      letterSpacing: cs.letterSpacing,
    });
    document.body.append(probe);
    let maxText = 0;
    try {
      for (const el of editors) {
        const lines = (el.textContent ?? "").split("\n");
        for (const ln of lines) {
          probe.textContent = ln;
          const w = probe.getBoundingClientRect().width;
          if (w > maxText) maxText = w;
        }
      }
    } finally {
      probe.remove();
    }
    const target = Math.min(
      ColumnMaxWidth,
      Math.max(ColumnMinWidth, Math.ceil(maxText) + 32),
    );
    store.captureSync();
    manager.setColumnWidth(columnId, target);
    store.captureSync();
  };

  const startEdgeDrag = (
    kind: "column" | "row",
    e: React.PointerEvent<HTMLElement>,
  ) => {
    if (readonly || e.button !== 0 || !editable()) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const step = kind === "column" ? DefaultColumnWidth : DefaultRowHeight;
    let dragged = false;
    let latestDelta = 0;
    const onMove = (ev: PointerEvent) => {
      const raw = kind === "column" ? ev.clientX - startX : ev.clientY - startY;
      if (!dragged && Math.abs(raw) < 20) return;
      dragged = true;
      latestDelta = Math.max(0, Math.round(raw / step));
      setEdgeDrag({ kind, delta: latestDelta });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (dragged) {
        suppressHandleClick.current = true;
        setEdgeDrag(null);
        if (editable() && latestDelta > 0) {
          store.captureSync();
          if (kind === "column") manager.addNColumn(latestDelta);
          else manager.addNRow(latestDelta);
          store.captureSync();
        }
        requestAnimationFrame(() => {
          suppressHandleClick.current = false;
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const resolveVisibleAddress = (
    targetRow: number,
    targetCol: number,
  ): Address | null => {
    const clampedR = Math.max(0, Math.min(rows.length - 1, targetRow));
    const clampedC = Math.max(0, Math.min(cols.length - 1, targetCol));
    const anchor = mergeMap.coveredBy.get(`${clampedR}:${clampedC}`) ?? {
      row: clampedR,
      col: clampedC,
    };
    const rowId = rows[anchor.row]?.rowId;
    const colId = cols[anchor.col]?.columnId;
    return rowId && colId ? { row: rowId, column: colId } : null;
  };

  const renderRows = (head: boolean) =>
    rows.map(({ rowId, backgroundColor, repeat }, r) => {
      const isHeader = r < (manager.headerRows$.value ?? 0);
      if (head !== isHeader) return null;
      const isRowDropBefore =
        reorder?.kind === "row" && reorder.targetIndex === r;
      const isRowDropAfter =
        reorder?.kind === "row" &&
        reorder.targetIndex === rows.length &&
        r === rows.length - 1;
      return (
        <tr
          key={rowId}
          data-row-id={rowId}
          data-row-repeat={repeat?.source}
          data-drop-row-before={isRowDropBefore ? "true" : undefined}
          data-drop-row-after={isRowDropAfter ? "true" : undefined}
        >
          {cols.map((col, c) => {
            if (mergeMap.coveredBy.has(`${r}:${c}`)) return null;
            const span = mergeMap.spans.get(`${r}:${c}`) ?? {
              colspan: 1,
              rowspan: 1,
            };
            const isRowHeader = !head && headerColumn && c === 0;
            const Tag = head || isRowHeader ? "th" : "td";
            const at = { row: rowId, column: col.columnId };
            const cell = manager.getCell(rowId, col.columnId);
            const color =
              cell?.backgroundColor ?? col.backgroundColor ?? backgroundColor;
            const control = (axis: "row" | "column") => {
              const axisId = axis === "row" ? rowId : col.columnId;
              const axisIndex = axis === "row" ? r : c;
              const isAxisMenuOpen =
                menu?.target.kind === axis && menu.target.id === axisId;
              return (
                <div
                  className={
                    axis === "row"
                      ? rowOptionsCellStyle
                      : columnOptionsCellStyle
                  }
                  style={{
                    opacity:
                      isAxisMenuOpen ||
                      (axis === "row"
                        ? hover?.row === rowId
                        : hover?.column === col.columnId)
                        ? 1
                        : undefined,
                  }}
                  onPointerEnter={() =>
                    setHoverAxis({ kind: axis, id: axisId })
                  }
                  onPointerLeave={() =>
                    setHoverAxis((prev) =>
                      prev?.kind === axis && prev.id === axisId ? null : prev,
                    )
                  }
                  onPointerDown={(e) => startAxisReorder(axis, axisIndex, e)}
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
                        run: (el) => {
                          if (suppressHandleClick.current) return;
                          show(at, { kind: axis, id: axisId }, el);
                        },
                      },
                    }}
                  />
                </div>
              );
            };
            const rEnd = r + span.rowspan - 1;
            const cEnd = c + span.colspan - 1;
            const isSelected = Boolean(
              selected &&
              rEnd >= selected.rowStartIndex &&
              r <= selected.rowEndIndex &&
              cEnd >= selected.columnStartIndex &&
              c <= selected.columnEndIndex,
            );
            const isAxisHovered = Boolean(
              hoverAxis &&
              ((hoverAxis.kind === "column" && hoverAxis.id === col.columnId) ||
                (hoverAxis.kind === "row" && hoverAxis.id === rowId)),
            );
            const isColDropBefore =
              reorder?.kind === "column" && reorder.targetIndex === c;
            const isColDropAfter =
              reorder?.kind === "column" &&
              reorder.targetIndex === cols.length &&
              cEnd === cols.length - 1;
            const liveWidth =
              span.colspan > 1
                ? undefined
                : resizingCol?.columnId === col.columnId
                  ? resizingCol.width
                  : col.width;
            const isResizingThis = resizingCol?.columnId === col.columnId;
            return (
              <Tag
                key={col.columnId}
                colSpan={span.colspan > 1 ? span.colspan : undefined}
                rowSpan={span.rowspan > 1 ? span.rowspan : undefined}
                data-table-cell=""
                data-row-id={rowId}
                data-column-id={col.columnId}
                data-header-column={isRowHeader ? "true" : undefined}
                data-custom-bg={color ? "true" : undefined}
                data-cell-protection={cell?.textProtection}
                scope={head ? "col" : isRowHeader ? "row" : undefined}
                className={cellContainerStyle}
                data-area={isSelected ? "selected" : undefined}
                data-area-top={
                  isSelected && selected && r <= selected.rowStartIndex
                    ? ""
                    : undefined
                }
                data-area-bottom={
                  isSelected && selected && rEnd >= selected.rowEndIndex
                    ? ""
                    : undefined
                }
                data-area-left={
                  isSelected && selected && c <= selected.columnStartIndex
                    ? ""
                    : undefined
                }
                data-area-right={
                  isSelected && selected && cEnd >= selected.columnEndIndex
                    ? ""
                    : undefined
                }
                data-axis-hover={isAxisHovered ? "true" : undefined}
                data-drop-col-before={isColDropBefore ? "true" : undefined}
                data-drop-col-after={isColDropAfter ? "true" : undefined}
                style={{
                  minWidth:
                    span.colspan > 1
                      ? undefined
                      : (liveWidth ?? DefaultColumnWidth),
                  maxWidth:
                    span.colspan > 1
                      ? undefined
                      : (liveWidth ?? ColumnMaxWidth),
                  width: liveWidth,
                  textAlign: col.textAlign,
                  backgroundColor: color?.startsWith("--")
                    ? `var(${color})`
                    : (color ??
                      (head || isRowHeader
                        ? "var(--myoxus-background-secondary-color)"
                        : undefined)),
                  padding: `${padding.block} ${padding.inline}`,
                }}
                onPointerEnter={() => setHover(at)}
                onContextMenu={(e) => {
                  if (readonly) return;
                  e.preventDefault();
                  const s = isSelected
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
                {!readonly && !r && span.colspan === 1 && control("column")}
                {!readonly && !c && control("row")}
                {!readonly && span.colspan === 1 && (
                  <div
                    className={columnRightIndicatorStyle}
                    data-col-resizer=""
                    data-resizing={isResizingThis ? "true" : undefined}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      autoFitColumn(col.columnId);
                    }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const el = e.currentTarget,
                        start = e.clientX,
                        startWidth =
                          el.parentElement!.getBoundingClientRect().width;
                      let latestWidth = startWidth;
                      el.setPointerCapture(e.pointerId);
                      setResizingCol({
                        columnId: col.columnId,
                        width: Math.round(startWidth),
                      });
                      const clearResizeHandlers = () => {
                        el.onpointermove = null;
                        el.onpointerup = null;
                        el.onpointercancel = null;
                        setResizingCol(null);
                      };
                      el.onpointermove = (ev) => {
                        latestWidth = Math.min(
                          ColumnMaxWidth,
                          Math.max(
                            ColumnMinWidth,
                            Math.round(startWidth + ev.clientX - start),
                          ),
                        );
                        setResizingCol({
                          columnId: col.columnId,
                          width: latestWidth,
                        });
                      };
                      el.onpointercancel = clearResizeHandlers;
                      el.onpointerup = () => {
                        const finalWidth = latestWidth;
                        clearResizeHandlers();
                        if (editable()) {
                          store.captureSync();
                          manager.setColumnWidth(col.columnId, finalWidth);
                          store.captureSync();
                        }
                      };
                    }}
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
        if (e.shiftKey && selection) {
          e.preventDefault();
          select({ first: selection.first, last: at });
          setRichSelection(null);
          parent.current?.focus({ preventScroll: true });
          document.getSelection()?.removeAllRanges();
          return;
        }
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
        if (!selection || !same(at, selection.last)) {
          select({ first: drag.current, last: at });
          if (!same(at, drag.current)) {
            setRichSelection(null);
            parent.current.focus({ preventScroll: true });
            document.getSelection()?.removeAllRanges();
          }
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerLeave={() => {
        setHover(null);
        setHoverAxis(null);
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
        const editorEl = (e.target as Element).closest<HTMLElement>(
          "[data-cell-editor]",
        );
        // Escape leaves inline text editing for Excel-style cell navigation mode.
        if (e.key === "Escape" && editorEl) {
          e.preventDefault();
          e.stopPropagation();
          setRichSelection(null);
          editorEl.blur();
          parent.current?.focus({ preventScroll: true });
          return;
        }
        // Delete/Backspace in cell-selection mode (single or multi-cell) clears cells.
        if (
          !editorEl &&
          selected &&
          (e.key === "Delete" || e.key === "Backspace")
        ) {
          e.preventDefault();
          store.captureSync();
          manager.clearCellsBySelection(selected);
          store.captureSync();
          return;
        }
        // Enter / F2 in cell-selection mode enters inline text editing.
        if (!editorEl && selection && (e.key === "Enter" || e.key === "F2")) {
          e.preventDefault();
          select({ first: selection.first, last: selection.first });
          focus(selection.first);
          return;
        }
        // Arrow keys in cell-selection mode (or Shift+Arrow anywhere) navigate / extend selection.
        const isArrow =
          e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight";
        if (isArrow) {
          const dr = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
          const dc =
            e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
          if (!editorEl && selection) {
            e.preventDefault();
            const base = e.shiftKey ? selection.last : selection.first;
            const br = rows.findIndex((row) => row.rowId === base.row);
            const bc = cols.findIndex((col) => col.columnId === base.column);
            if (br < 0 || bc < 0) return;
            const next = resolveVisibleAddress(br + dr, bc + dc);
            if (!next) return;
            select(
              e.shiftKey
                ? { first: selection.first, last: next }
                : { first: next, last: next },
            );
            return;
          }
          if (editorEl && !e.shiftKey) {
            const cellSel = readCellSelection(editorEl);
            const curRow = rows.findIndex(
              (row) => row.rowId === editorEl.dataset.row,
            );
            const curCol = cols.findIndex(
              (col) => col.columnId === editorEl.dataset.column,
            );
            if (
              curRow >= 0 &&
              curCol >= 0 &&
              cellSel &&
              cellSel.start === cellSel.end
            ) {
              const cellText =
                manager
                  .getCell(rows[curRow]!.rowId, cols[curCol]!.columnId)
                  ?.text.toString() ?? "";
              const atStart = cellSel.start === 0;
              const atEnd = cellSel.end >= cellText.length;
              const noNewlineBefore =
                cellText.lastIndexOf("\n", Math.max(0, cellSel.start - 1)) ===
                -1;
              const noNewlineAfter = cellText.indexOf("\n", cellSel.end) === -1;
              const shouldJump =
                (e.key === "ArrowLeft" && atStart) ||
                (e.key === "ArrowRight" && atEnd) ||
                (e.key === "ArrowUp" && (atStart || noNewlineBefore)) ||
                (e.key === "ArrowDown" && (atEnd || noNewlineAfter));
              if (shouldJump) {
                const span = mergeMap.spans.get(`${curRow}:${curCol}`) ?? {
                  colspan: 1,
                  rowspan: 1,
                };
                const nr =
                  dr > 0 ? curRow + span.rowspan : dr < 0 ? curRow - 1 : curRow;
                const nc =
                  dc > 0 ? curCol + span.colspan : dc < 0 ? curCol - 1 : curCol;
                if (
                  nr >= 0 &&
                  nr < rows.length &&
                  nc >= 0 &&
                  nc < cols.length
                ) {
                  const next = resolveVisibleAddress(nr, nc);
                  if (next) {
                    e.preventDefault();
                    select({ first: next, last: next });
                    setRichSelection(null);
                    focus(next, e.key === "ArrowLeft" ? undefined : 0);
                    return;
                  }
                }
              }
            }
          }
        }
        // Plain Enter inside a cell jumps to the cell directly below (Shift+Enter stays newline).
        if (e.key === "Enter" && !e.shiftKey && editorEl) {
          const curRow = rows.findIndex(
            (row) => row.rowId === editorEl.dataset.row,
          );
          const curCol = cols.findIndex(
            (col) => col.columnId === editorEl.dataset.column,
          );
          if (curRow >= 0 && curCol >= 0) {
            const span = mergeMap.spans.get(`${curRow}:${curCol}`) ?? {
              colspan: 1,
              rowspan: 1,
            };
            const nextRowIdx = curRow + span.rowspan;
            if (nextRowIdx < rows.length) {
              const next = resolveVisibleAddress(nextRowIdx, curCol);
              if (next) {
                e.preventDefault();
                e.stopPropagation();
                select({ first: next, last: next });
                setRichSelection(null);
                focus(next);
                return;
              }
            }
          }
        }
        if (e.key !== "Tab" || !editorEl) return;
        const { dataset } = editorEl;
        const r = rows.findIndex((row) => row.rowId === dataset.row),
          c = cols.findIndex((col) => col.columnId === dataset.column);
        const step = e.shiftKey ? -1 : 1;
        let i = r * cols.length + c + step;
        while (
          i >= 0 &&
          i < rows.length * cols.length &&
          mergeMap.coveredBy.has(
            `${Math.floor(i / cols.length)}:${i % cols.length}`,
          )
        ) {
          i += step;
        }
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
        if (existingRow) {
          focus(at);
        } else {
          requestAnimationFrame(() => focus(at));
        }
      }}
    >
      <div
        data-table-frame=""
        data-table-appearance={appearance}
        data-table-striped={striped ? "true" : undefined}
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
        <table className={tableWrapper}>
          {!!manager.headerRows$.value && <thead>{renderRows(true)}</thead>}
          <tbody>{renderRows(false)}</tbody>
        </table>
        {!readonly && (
          <>
            <div
              data-table-edge="add-column"
              data-dragging={edgeDrag?.kind === "column" ? "true" : undefined}
              onPointerDown={(e) => startEdgeDrag("column", e)}
              onClick={(event) => {
                if (suppressHandleClick.current) return;
                if (
                  event.target instanceof Element &&
                  event.target.closest("button")
                ) {
                  return;
                }
                event.stopPropagation();
                appendColumn();
              }}
            >
              <EditorTableControl
                controls={{
                  dragBadge:
                    edgeDrag?.kind === "column" && edgeDrag.delta > 0
                      ? `+${edgeDrag.delta} (${rows.length} × ${cols.length + edgeDrag.delta})`
                      : undefined,
                  action: {
                    id: "add-column-button",
                    icon: "PlusIcon",
                    label: t["com.myoxus.editor.table.insert-right"](),
                    disabled: readonly,
                    run: () => {
                      if (suppressHandleClick.current) return;
                      appendColumn();
                    },
                  },
                }}
              />
            </div>
            <div
              data-table-edge="add-row"
              data-dragging={edgeDrag?.kind === "row" ? "true" : undefined}
              onPointerDown={(e) => startEdgeDrag("row", e)}
              onClick={(event) => {
                if (suppressHandleClick.current) return;
                if (
                  event.target instanceof Element &&
                  event.target.closest("button")
                ) {
                  return;
                }
                event.stopPropagation();
                appendRow();
              }}
            >
              <EditorTableControl
                controls={{
                  dragBadge:
                    edgeDrag?.kind === "row" && edgeDrag.delta > 0
                      ? `+${edgeDrag.delta} (${rows.length + edgeDrag.delta} × ${cols.length})`
                      : undefined,
                  action: {
                    id: "add-row-button",
                    icon: "PlusIcon",
                    label: t["com.myoxus.editor.table.insert-below"](),
                    disabled: readonly,
                    run: () => {
                      if (suppressHandleClick.current) return;
                      appendRow();
                    },
                  },
                }}
              />
            </div>
          </>
        )}
      </div>
      {caption.field && <div data-table-caption="">{caption.field}</div>}
      {selectionToolbarControls && (
        <EditorSelectionToolbar controls={selectionToolbarControls} />
      )}
      {areaToolbarControls && (
        <EditorSelectionToolbar controls={areaToolbarControls} />
      )}
      {menu && (
        <EditorActionMenu
          controls={{
            actions: commands(),
            label: t["com.myoxus.editor.slash.table"](),
            setAnchor,
            close: () => {
              const closedMenu = menu;
              setMenu(null);
              restoreFocusAfterMenu(closedMenu);
            },
          }}
        />
      )}
      {templateVariablePicker}
    </div>
  );
}
