import {
  EditorChromeHostIdentifier,
  type EditorTableControl,
  templateRepeatLabel,
  templateRepeatActions,
  templateVariableLabel,
} from "@virgultum/core/services";
import { computed, effect, signal, untracked } from "@preact/signals-core";
import {
  type PopupTarget,
  popupTargetFromElement,
} from "@virgultum/core/view/portal";
import { IS_MAC } from "@virgultum/core/primitives/env";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { DefaultInlineManagerExtension } from "../../inlines/preset/index";
import {
  type TableColumn,
  type TableRow,
  normalizeTableColumnTextAlign,
} from "@virgultum/core/models";

import { RichText } from "../../rich-text/index";
import {
  EditorI18nProvider,
  type SelectionAction,
  type EditorI18nMessage,
  MyoxusHostServiceIdentifier,
  ThemeProvider,
  editorMessage,
  resolveEditorMessage,
  textProtectionMessages,
  textProtectionHint,
} from "@virgultum/core/services";
import { cssVar } from "@virgultum/core/theme";
import { visitDocumentFieldRuns } from "@virgultum/core/types";
import { editorToast, getViewportElement } from "@virgultum/core/utils";
import { NativeViewElement } from "@virgultum/core/runtime";
import { expandRangeEmbeds } from "@virgultum/core/runtime/inline";
import {
  nanoid,
  SliceSnapshotSchema,
  toJSON,
  type DeltaOperation,
  type SliceSnapshot,
  type Text,
} from "@virgultum/core/store";

import { resolveTableColors } from "./color";
import { openTableMenu } from "./table-menu";
import { ColumnMaxWidth, DefaultColumnWidth } from "./consts";
import type { SelectionController } from "./selection-controller";
import {
  type TableAreaSelection,
  TableSelectionData,
} from "./selection-schema";
import type { TableBlockComponent } from "./table-block";
import {
  cellContainerStyle,
  columnLeftIndicatorStyle,
  columnOptionsCellStyle,
  columnRightIndicatorStyle,
  rowBottomIndicatorStyle,
  rowOptionsCellStyle,
  rowTopIndicatorStyle,
} from "./table-cell-css";
import type { TableDataManager } from "./table-data-manager";

export const TableCellComponentName = "myoxus-table-cell";

export class TableCell extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _text$ = signal<Text | undefined>(undefined);
  private readonly _rowIndex$ = signal(0);
  private readonly _columnIndex$ = signal(0);
  private readonly _isHeader$ = signal(false);
  private readonly _row$ = signal<TableRow | undefined>(undefined);
  private readonly _column$ = signal<TableColumn | undefined>(undefined);
  private readonly _height$ = signal<number | undefined>(undefined);
  private readonly _syncRevision$ = signal(0);

  get text() {
    return this._text$.value;
  }
  set text(value: Text | undefined) {
    this._text$.value = value;
  }

  get readonly() {
    return this.dataManager.readonly$.value;
  }

  get textProtection() {
    return this.row && this.column
      ? this.dataManager.getCell(this.row.rowId, this.column.columnId)
          ?.textProtection
      : undefined;
  }

  get textProtected() {
    return this.textProtection === "fixed";
  }

  dataManager!: TableDataManager;

  get richText(): RichText | null {
    return this.richText$.peek() ?? this.querySelector("rich-text");
  }

  get rowIndex() {
    return this._rowIndex$.value;
  }
  set rowIndex(value: number) {
    this._rowIndex$.value = value;
  }

  get columnIndex() {
    return this._columnIndex$.value;
  }
  set columnIndex(value: number) {
    this._columnIndex$.value = value;
  }

  get isHeader() {
    return this._isHeader$.value;
  }
  set isHeader(value: boolean) {
    this._isHeader$.value = value;
  }

  get row() {
    return this._row$.value;
  }
  set row(value: TableRow | undefined) {
    this._row$.value = value;
  }

  get column() {
    return this._column$.value;
  }
  set column(value: TableColumn | undefined) {
    this._column$.value = value;
  }

  selectionController!: SelectionController;

  // The session owns table selection until its native menu releases focus.
  menuSession?: AbortSignal;

  get height() {
    return this._height$.value;
  }
  set height(value: number | undefined) {
    this._height$.value = value;
  }

  notifyModelUpdate() {
    this._syncRevision$.value++;
  }

  get updateComplete() {
    return Promise.resolve(this.isConnected);
  }

  get hoverColumnIndex$() {
    return this.dataManager.hoverColumnIndex$;
  }
  get hoverRowIndex$() {
    return this.dataManager.hoverRowIndex$;
  }
  get inlineManager() {
    return this.closest<TableBlockComponent>("myoxus-table")?.std.get(
      DefaultInlineManagerExtension.identifier,
    );
  }

  get topContenteditableElement() {
    return this.closest<TableBlockComponent>("myoxus-table")
      ?.topContenteditableElement;
  }

  private get i18n() {
    return (
      this.closest<TableBlockComponent>("myoxus-table")?.std.getOptional(
        EditorI18nProvider,
      ) ?? undefined
    );
  }

  private message(message: EditorI18nMessage) {
    return resolveEditorMessage(message, this.i18n);
  }

  restoreCellFocus(index?: number) {
    if (!this.isConnected) return;
    if (index === undefined) this.inlineEditor?.focusEnd();
    else this.inlineEditor?.setInlineRange({ index, length: 0 });
    // The requested range may equal the caret retained before a menu opened;
    // range equality must not prevent restoring native focus.
    this.inlineEditor?.syncInlineRange();
  }

  private readonly copyNativeFields = (event: ClipboardEvent) => {
    const table = this.closest<TableBlockComponent>("myoxus-table");
    const editor = this.inlineEditor;
    const text = this.text;
    const range = editor?.getInlineRange();
    if (!table || !editor || !text || !range?.length || !event.clipboardData)
      return;
    const selectedRange = { index: range.index, length: range.length };
    const selectedDelta = () =>
      text
        .sliceToDelta(
          selectedRange.index,
          selectedRange.index + selectedRange.length,
        )
        .filter((run) => run.insert !== "");
    const delta = selectedDelta();
    const textProtection = this.textProtection;
    if (!textProtection && !delta.some((run) => run.attributes?.documentField))
      return;
    const textSnapshot = toJSON(text) as { delta: typeof delta };
    textSnapshot.delta = structuredClone(delta);
    const snapshot: SliceSnapshot = {
      type: "slice",
      workspaceId: table.store.workspace.id,
      pageId: table.store.id,
      content: [
        {
          type: "block",
          id: nanoid(),
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: textSnapshot,
            ...(textProtection ? { textProtection } : {}),
          },
          children: [],
        },
      ],
    };
    event.preventDefault();
    event.stopPropagation();
    const isCut = event.type === "cut";
    const captured = JSON.stringify(delta);
    void table.std.clipboard
      .copySnapshot(snapshot)
      .then(() => {
        if (!isCut || this.textProtected) return;
        const currentRange = editor.getInlineRange();
        // Copy preparation can be asynchronous. Never delete a later selection
        // or content changed while authorizing the captured clipboard snapshot.
        if (
          !this.isConnected ||
          this.readonly ||
          this.inlineEditor !== editor ||
          this.text !== text ||
          currentRange?.index !== selectedRange.index ||
          currentRange.length !== selectedRange.length ||
          JSON.stringify(selectedDelta()) !== captured
        )
          throw new Error("Clipboard selection changed during cut");
        table.store.captureSync();
        editor.deleteText(selectedRange);
        table.store.captureSync();
        this.restoreCellFocus(selectedRange.index);
      })
      .catch((error: unknown) => {
        editorToast(
          table.host,
          editorMessage(
            "com.myoxus.editor.clipboard.copy-failed",
            "Copy failed. Please try again.",
          ),
        );
        console.error(error);
      });
  };

  private readonly pasteNativeFields = (event: ClipboardEvent) => {
    const table = this.closest<TableBlockComponent>("myoxus-table");
    const editor = this.inlineEditor;
    const text = this.text;
    const range = editor?.getInlineRange();
    if (!table || !editor || !text || !range || !event.clipboardData) return;
    let snapshot: SliceSnapshot;
    try {
      const items = table.std.clipboard.readOptionalSnapshotFromClipboard(
        event.clipboardData,
      );
      if (items === undefined) return;
      const native = items["VIRGULTUM/SNAPSHOT"];
      if (typeof native !== "string")
        throw new Error("Missing native snapshot");
      snapshot = SliceSnapshotSchema.parse(JSON.parse(native).snapshot);
    } catch (error) {
      // Never degrade a recognized but corrupt native selection to plain text.
      event.preventDefault();
      event.stopPropagation();
      this.notifyNativePasteFailure(table, error);
      return;
    }
    try {
      let fields = 0;
      visitDocumentFieldRuns(snapshot, () => fields++);
      const hasProtection = (blocks: SliceSnapshot["content"]): boolean =>
        blocks.some(
          (block) =>
            block.props.textProtection !== undefined ||
            hasProtection(block.children),
        );
      if (!fields && !hasProtection(snapshot.content)) return;
    } catch (error) {
      event.preventDefault();
      event.stopPropagation();
      this.notifyNativePasteFailure(table, error);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const initialRange = { index: range.index, length: range.length };
    const selectedRange = expandRangeEmbeds(editor, initialRange);
    const captured = JSON.stringify(text.toDelta());
    void table.std.clipboard
      .prepareNativeSlice(snapshot, table.store, table.blockId)
      .then((prepared) => {
        try {
          const blocks =
            prepared.snapshot.content.length === 1 &&
            prepared.snapshot.content[0]?.flavour === "myoxus:note"
              ? prepared.snapshot.content[0].children
              : prepared.snapshot.content;
          const block = blocks[0];
          if (
            blocks.length !== 1 ||
            !block ||
            block.flavour !== "myoxus:paragraph" ||
            block.children.length !== 0
          )
            throw new Error("Native field paste requires one text paragraph");
          const value = block.props.text as { delta?: DeltaOperation[] };
          const textProtection = block.props.textProtection;
          const destinationCell =
            this.row && this.column
              ? this.dataManager.getCell(this.row.rowId, this.column.columnId)
              : undefined;
          if (
            textProtection !== undefined &&
            textProtection !== "source" &&
            textProtection !== "fixed"
          )
            throw new Error("Invalid native text protection");
          // A whole-owner mode cannot be pasted onto a subset of free cell text.
          if (
            textProtection &&
            (selectedRange.index !== 0 ||
              selectedRange.length !== text.length ||
              destinationCell?.text !== text)
          )
            throw new Error(
              "Protected native text requires a whole-cell replacement",
            );
          const delta = value?.delta;
          if (
            !Array.isArray(delta) ||
            delta.some((run) => typeof run.insert !== "string")
          )
            throw new Error("Invalid native field paste text");
          const currentRange = editor.getInlineRange();
          if (
            !this.isConnected ||
            this.readonly ||
            this.textProtected ||
            editor.isReadonly ||
            this.inlineEditor !== editor ||
            this.text !== text ||
            currentRange?.index !== initialRange.index ||
            currentRange.length !== initialRange.length ||
            JSON.stringify(text.toDelta()) !== captured
          )
            throw new Error("Clipboard destination changed during paste");
          prepared.assertCurrent();
          table.store.captureSync();
          let index = selectedRange.index;
          editor.transact(() => {
            editor.yText.delete(index, selectedRange.length);
            for (const run of delta) {
              const value = run.insert!;
              if (!value) continue;
              editor.yText.insert(index, value, run.attributes ?? {});
              index += value.length;
            }
            if (textProtection && destinationCell)
              destinationCell.textProtection = textProtection;
          });
          table.store.captureSync();
          this.restoreCellFocus(index);
        } finally {
          prepared.dispose();
        }
      })
      .catch((error: unknown) => this.notifyNativePasteFailure(table, error));
  };

  notifyNativePasteFailure(table: TableBlockComponent, error: unknown) {
    editorToast(
      table.host,
      editorMessage(
        "com.myoxus.editor.clipboard.paste-failed",
        "Could not paste this field selection into the cell.",
      ),
    );
    console.error(error);
  }

  notifyHeaderRepeatConflict() {
    const table = this.closest<TableBlockComponent>("myoxus-table");
    if (table)
      editorToast(
        table.host,
        editorMessage(
          "com.myoxus.editor.table.header-repeat-conflict",
          "Header rows cannot contain repeated template rows.",
        ),
      );
  }

  openColumnOptions(target: PopupTarget, column: TableColumn) {
    openTableMenu(this, target, { kind: "column", id: column.columnId });
  }

  templateVariableActions(handoff: () => void): SelectionAction[] {
    const block = this.closest<TableBlockComponent>("myoxus-table");
    const host = block?.std.getOptional(MyoxusHostServiceIdentifier);
    const editor = this.inlineEditor;
    const text = this.text;
    const manager = this.dataManager;
    const rowId = this.row?.rowId,
      columnId = this.column?.columnId;
    if (
      this.readonly ||
      this.textProtected ||
      !host?.openTemplateVariablePicker ||
      !editor ||
      !text ||
      !rowId ||
      !columnId
    )
      return [];
    const range = editor.getInlineRange() ?? { index: text.length, length: 0 };
    const canWrite = () =>
      !this.readonly &&
      this.isConnected &&
      !this.textProtected &&
      this.dataManager === manager &&
      this.row?.rowId === rowId &&
      this.column?.columnId === columnId &&
      this.inlineEditor === editor &&
      !editor.isReadonly &&
      editor.isValidInlineRange(range) &&
      manager.getCell(rowId, columnId)?.text === text &&
      Boolean(
        block?.isConnected &&
        block.store.getBlock(block.model.id)?.model === block.model,
      );
    let nextCaret = range.index;
    return [
      {
        id: "document-fields",
        label: resolveEditorMessage(
          host.isTemplateDocument()
            ? templateVariableLabel
            : editorMessage(
                "com.myoxus.editor.field.document-fields",
                "Document fields",
              ),
          this.i18n,
        ),
        icon: "TextIcon",
        disabled: false,
        run: () => {
          if (!canWrite()) return;
          handoff();
          host.openTemplateVariablePicker?.({
            i18n: this.i18n,
            templateSource: host.isTemplateDocument(),
            canWrite,
            insert: (token) => {
              if (!canWrite() || !host.isTemplateDocument()) return;
              block?.store.captureSync();
              editor.insertText(range, token);
              nextCaret = range.index + token.length;
              block?.store.captureSync();
            },
            insertField: (field) => {
              if (
                !canWrite() ||
                (field.type === "input" && !host.isTemplateDocument())
              )
                return;
              block?.store.captureSync();
              editor.insertText(range, " ", { documentField: field });
              nextCaret = range.index + 1;
              block?.store.captureSync();
            },
            onClose: () => this.restoreCellFocus(nextCaret),
          });
        },
      },
    ];
  }

  textProtectionActions(selection: TableAreaSelection): SelectionAction[] {
    if (
      selection.rowStartIndex !== selection.rowEndIndex ||
      selection.columnStartIndex !== selection.columnEndIndex ||
      selection.rowStartIndex !== this.rowIndex ||
      selection.columnStartIndex !== this.columnIndex
    )
      return [];
    const table = this.closest<TableBlockComponent>("myoxus-table");
    const host = table?.std.getOptional(MyoxusHostServiceIdentifier);
    const rowId = this.row?.rowId;
    const columnId = this.column?.columnId;
    if (!table || !rowId || !columnId) return [];
    const cell = this.dataManager.getCell(rowId, columnId);
    if (!cell) return [];
    const mode = cell.textProtection;
    if (mode !== undefined && mode !== "source" && mode !== "fixed") return [];
    const fixed = mode === "fixed";
    if (!fixed && (this.readonly || !host?.isTemplateDocument())) return [];
    return [
      {
        id: "text-protection",
        label: this.message(
          fixed
            ? textProtectionMessages.fixed
            : mode === "source"
              ? textProtectionMessages.unprotect
              : textProtectionMessages.protect,
        ),
        icon: "LockIcon",
        disabled: this.readonly || fixed,
        active: mode === "source" || fixed,
        run: () => {
          const current = this.dataManager.getCell(rowId, columnId);
          if (
            !this.isConnected ||
            this.readonly ||
            !host?.isTemplateDocument() ||
            current !== cell ||
            current.textProtection !== mode ||
            mode === "fixed"
          )
            return false;
          table.store.captureSync();
          table.store.transact(() => {
            if (mode === "source") delete cell.textProtection;
            else cell.textProtection = "source";
          });
          table.store.captureSync();
          this.restoreCellFocus();
          return;
        },
      },
    ];
  }

  openRowOptions(
    target: PopupTarget,
    row: TableRow,
    area?: TableAreaSelection,
  ) {
    openTableMenu(this, target, { kind: "row", id: row.rowId, area });
  }

  rowRepeatActions(rowId: string): SelectionAction[] {
    const block = this.closest<TableBlockComponent>("myoxus-table");
    const host = block?.std.getOptional(MyoxusHostServiceIdentifier);
    if (!host?.isTemplateDocument()) return [];
    const manager = this.dataManager,
      selection = this.selectionController;
    const selected = selection.selected$.value;
    const i18n = this.i18n;
    // Keep this native row-menu selection, not merely a row with the same ID.
    const canWrite = () =>
      !this.readonly &&
      this.isConnected &&
      this.dataManager === manager &&
      this.row?.rowId === rowId &&
      selected?.type === "row" &&
      selected.rowId === rowId &&
      selection.selected$.value === selected &&
      Boolean(
        block?.isConnected &&
        block.store.getBlock(block.model.id)?.model === block.model,
      ) &&
      Boolean(host.isTemplateDocument()) &&
      manager.canSetRowRepeat(rowId);
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
              binding: manager.rows$.value.find((row) => row.rowId === rowId)
                ?.repeat,
              texts: manager.columns$.value.map(
                (column) =>
                  manager.getCell(rowId, column.columnId)?.text.toString() ??
                  "",
              ),
              leaf: block?.model.children.length === 0,
            }),
            change: (repeat) => {
              if (!manager.setRowRepeat(rowId, repeat))
                this.notifyHeaderRepeatConflict();
            },
          }),
        },
      },
    ];
  }

  private readonly onContextMenu = (e: Event) => {
    if (this.readonly) return;
    e.preventDefault();
    e.stopPropagation();
    const current = this.selectionController.selected$.value;
    const selected: TableAreaSelection =
      current?.type === "area" &&
      this.rowIndex >= current.rowStartIndex &&
      this.rowIndex <= current.rowEndIndex &&
      this.columnIndex >= current.columnStartIndex &&
      this.columnIndex <= current.columnEndIndex
        ? current
        : {
            type: "area",
            rowStartIndex: this.rowIndex,
            rowEndIndex: this.rowIndex,
            columnStartIndex: this.columnIndex,
            columnEndIndex: this.columnIndex,
          };
    if (selected !== current)
      this.selectionController.setSelected(selected, false);
    if (e.currentTarget instanceof HTMLElement)
      openTableMenu(this, popupTargetFromElement(e.currentTarget), {
        kind: "cell",
        area: selected,
      });
  };

  tdMouseEnter(rowIndex: number, columnIndex: number) {
    this.hoverColumnIndex$.value = columnIndex;
    this.hoverRowIndex$.value = rowIndex;
  }

  tdMouseLeave() {
    this.hoverColumnIndex$.value = undefined;
    this.hoverRowIndex$.value = undefined;
  }

  virtualWidth$ = computed(() => {
    const virtualWidth = this.dataManager.virtualWidth$.value;
    if (!virtualWidth || this.column?.columnId !== virtualWidth.columnId) {
      return undefined;
    }
    return virtualWidth.width;
  });

  private applyCellStyle(cellEl: HTMLTableCellElement) {
    void this._syncRevision$.value;
    const column = this.column;
    const row = this.row;
    const columnWidth = this.virtualWidth$.value ?? column?.width;
    const backgroundColor =
      (row && column
        ? this.dataManager.getCell(row.rowId, column.columnId)?.backgroundColor
        : undefined) ??
      column?.backgroundColor ??
      row?.backgroundColor ??
      (this.isHeader ? cssVar("backgroundSecondaryColor") : undefined);
    const theme =
      this.closest<TableBlockComponent>("myoxus-table")?.std.get(ThemeProvider);
    const appearance = this.dataManager.appearance$.value ?? "grid";
    const colors =
      backgroundColor && theme
        ? resolveTableColors(theme, backgroundColor)
        : { backgroundColor: backgroundColor ?? "", color: "" };

    cellEl.style.backgroundColor = colors.backgroundColor ?? "";
    cellEl.style.color = colors.color ?? "";
    cellEl.style.borderWidth =
      appearance === "grid" ? "" : appearance === "ruled" ? "1px 0" : "0";
    cellEl.style.minWidth = columnWidth
      ? `${columnWidth}px`
      : `${DefaultColumnWidth}px`;
    cellEl.style.maxWidth = columnWidth
      ? `${columnWidth}px`
      : `${ColumnMaxWidth}px`;
  }

  showColumnIndicator$ = computed(() => {
    const indicatorIndex =
      this.dataManager.ui.columnIndicatorIndex$.value ?? -1;
    if (indicatorIndex === 0 && this.columnIndex === 0) {
      return "left";
    }
    if (indicatorIndex - 1 === this.columnIndex) {
      return "right";
    }
    return;
  });

  showRowIndicator$ = computed(() => {
    const indicatorIndex = this.dataManager.ui.rowIndicatorIndex$.value ?? -1;
    if (indicatorIndex === 0 && this.rowIndex === 0) {
      return "top";
    }
    if (indicatorIndex - 1 === this.rowIndex) {
      return "bottom";
    }
    return;
  });

  richText$ = signal<RichText>();

  get inlineEditor() {
    return this.richText$.value?.inlineEditor;
  }

  private tabRowPending = false;

  private navigateByTab(e: KeyboardEvent) {
    if (this.readonly || e.isComposing || e.altKey || e.ctrlKey || e.metaKey)
      return;
    const table = this.closest<TableBlockComponent>("myoxus-table");
    if (!table) return;
    const cells = Array.from(
      table.querySelectorAll<TableCell>("myoxus-table-cell"),
    );
    const index = cells.indexOf(this);
    if (index < 0) return;

    // Let the browser leave the first cell backwards; the document Tab
    // shortcut must not turn that focus traversal into block indentation.
    e.stopPropagation();
    if (e.shiftKey && index === 0) return;
    e.preventDefault();
    if (this.tabRowPending) return;
    const target = cells[index + (e.shiftKey ? -1 : 1)];
    if (target) {
      if (e.shiftKey) target.inlineEditor?.focusEnd();
      else target.inlineEditor?.focusStart();
      target.inlineEditor?.syncInlineRange();
      return;
    }

    table.store.captureSync();
    const rowId = this.dataManager.addRow(
      this.dataManager.rows$.value.length - 1,
    );
    table.store.captureSync();
    this.tabRowPending = true;
    // A new row has no inline editor until its cells and rich-text children
    // finish mounting. Keep repeated keydowns from adding duplicate rows.
    void this.focusNewTabRow(table, rowId)
      .catch(console.error)
      .finally(() => {
        this.tabRowPending = false;
      });
  }

  private async focusNewTabRow(table: TableBlockComponent, rowId: string) {
    await table.updateComplete;
    const cell = Array.from(
      table.querySelectorAll<TableCell>("myoxus-table-cell"),
    ).find((cell) => cell.row?.rowId === rowId && cell.columnIndex === 0);
    if (!cell) return;
    await cell.updateComplete;
    await cell.richText?.updateComplete;
    if (cell.isConnected && !cell.readonly) cell.inlineEditor?.focusStart();
  }

  private readonly _handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") return;
    if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
      const cell = this.querySelector<HTMLElement>("[data-table-cell]");
      if (cell && this.row) {
        e.preventDefault();
        e.stopPropagation();
        const selected = this.selectionController.selected$.value;
        this.openRowOptions(
          popupTargetFromElement(cell),
          this.row,
          selected?.type === "area"
            ? selected
            : {
                type: "area",
                rowStartIndex: this.rowIndex,
                rowEndIndex: this.rowIndex,
                columnStartIndex: this.columnIndex,
                columnEndIndex: this.columnIndex,
              },
        );
      }
      return;
    }
    // Cell text owns ordinary typing, but document history is owned by the
    // root keyboard manager. Do not swallow its existing Undo/Redo shortcuts
    // after a row action restores focus to this cell.
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && ["z", "y"].includes(e.key.toLowerCase())) return;
    if (e.key !== "Escape") {
      e.stopPropagation();
    }
  };

  private mountOptionControl(
    cellEl: HTMLTableCellElement,
    kind: "row" | "column",
  ) {
    const column = kind === "column";
    const doc = this.ownerDocument;
    const table = this.closest<TableBlockComponent>("myoxus-table");
    const chrome = table?.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return () => {};

    const container = doc.createElement("div");
    container.className = column ? columnOptionsCellStyle : rowOptionsCellStyle;
    cellEl.append(container);

    const state = computed<EditorTableControl | null>(() => {
      const id = column ? this.column?.columnId : this.row?.rowId;
      if (!id || this.readonly) return null;
      return {
        menu: true,
        mouseDown: (element, event) => {
          if (!this.isConnected || this.readonly || event.button !== 0) return;
          // SVG glyph targets are not HTMLElements; pass the native button to the
          // existing drag controller rather than relying on ancestor delegation.
          if (column) this.selectionController.columnDrag(element, event);
          else this.selectionController.rowDrag(element, event);
        },
        setElement: (element) => {
          if (element)
            element.dataset[column ? "dragColumnId" : "dragRowId"] = id;
        },
        action: {
          id: column ? "drag-column-handle" : "drag-row-handle",
          icon: "MoreHorizontalIcon",
          label: this.message(
            column
              ? editorMessage(
                  "com.myoxus.editor.table.column-options",
                  "Column options",
                )
              : editorMessage(
                  "com.myoxus.editor.table.row-options",
                  "Row options",
                ),
          ),
          disabled: this.readonly,
          run: (element) => {
            if (!element || !this.isConnected || this.readonly) return;
            // Re-resolve identity after structural edits instead of using a stale index.
            const target = popupTargetFromElement(element);
            if (column) {
              const live = this.dataManager.columns$.value.find(
                (item) => item.columnId === id,
              );
              if (live) this.openColumnOptions(target, live);
            } else {
              const live = this.dataManager.rows$.value.find(
                (item) => item.rowId === id,
              );
              if (live) this.openRowOptions(target, live);
            }
          },
        },
      };
    });

    const releasePortal = chrome.mountTableControl(container, state);
    const stopOpacity = effect(() => {
      const index = column ? this.columnIndex : this.rowIndex;
      const hovered =
        index === (column ? this.hoverColumnIndex$ : this.hoverRowIndex$).value;
      container.style.opacity = hovered ? "1" : "";
    });

    return () => {
      stopOpacity();
      releasePortal();
      container.remove();
    };
  }

  private mountIndicators(cellEl: HTMLTableCellElement) {
    const doc = this.ownerDocument;
    const group = new DisposableGroup();

    const colLeft = doc.createElement("div");
    colLeft.className = columnLeftIndicatorStyle;

    const colRight = doc.createElement("div");
    colRight.className = columnRightIndicatorStyle;
    const onColRightEnter = () => {
      this.dataManager.hoverDragHandleColumnId$.value = this.column?.columnId;
    };
    const onColRightLeave = () => {
      this.dataManager.hoverDragHandleColumnId$.value = undefined;
    };
    colRight.addEventListener("mouseenter", onColRightEnter);
    colRight.addEventListener("mouseleave", onColRightLeave);
    group.add(() => {
      colRight.removeEventListener("mouseenter", onColRightEnter);
      colRight.removeEventListener("mouseleave", onColRightLeave);
    });

    const rowTop = doc.createElement("div");
    rowTop.className = rowTopIndicatorStyle;

    const rowBottom = doc.createElement("div");
    rowBottom.className = rowBottomIndicatorStyle;

    cellEl.append(colRight, rowBottom);
    group.add(() => {
      colLeft.remove();
      colRight.remove();
      rowTop.remove();
      rowBottom.remove();
    });

    group.add(
      effect(() => {
        const colIdx = this.columnIndex;
        const rowIdx = this.rowIndex;
        const uiRows = this.dataManager.uiRows$.value;
        const uiCols = this.dataManager.uiColumns$.value;
        const isFirstRow = rowIdx === 0;
        const isLastRow = rowIdx === uiRows.length - 1;
        const isFirstCol = colIdx === 0;
        const isLastCol = colIdx === uiCols.length - 1;

        const columnId = this.column?.columnId;
        if (columnId !== undefined) {
          colRight.dataset.widthAdjustColumnId = columnId;
        } else {
          delete colRight.dataset.widthAdjustColumnId;
        }

        const showWidthAdjust =
          this.dataManager.widthAdjustColumnId$.value === columnId ||
          this.dataManager.hoverDragHandleColumnId$.value === columnId;
        const showCol = this.showColumnIndicator$.value;
        const colRadius = isFirstRow
          ? "3px 3px 0 0"
          : isLastRow
            ? "0 0 3px 3px"
            : "0";

        if (isFirstCol) {
          if (!colLeft.parentNode) cellEl.insertBefore(colLeft, colRight);
          colLeft.style.opacity = showCol === "left" ? "1" : "0";
          colLeft.style.borderRadius = colRadius;
        } else if (colLeft.parentNode) {
          colLeft.remove();
        }

        colRight.style.opacity =
          showWidthAdjust || showCol === "right" ? "1" : "0";
        colRight.style.borderRadius = colRadius;

        const showRow = this.showRowIndicator$.value;
        const rowRadius = isFirstCol
          ? "3px 0 0 3px"
          : isLastCol
            ? "0 3px 3px 0"
            : "0";

        if (isFirstRow) {
          if (!rowTop.parentNode) cellEl.insertBefore(rowTop, rowBottom);
          rowTop.style.opacity = showRow === "top" ? "1" : "0";
          rowTop.style.borderRadius = rowRadius;
        } else if (rowTop.parentNode) {
          rowTop.remove();
        }

        rowBottom.style.opacity = showRow === "bottom" ? "1" : "0";
        rowBottom.style.borderRadius = rowRadius;
      }),
    );

    return () => group.dispose();
  }

  connectedCallback() {
    this.disposables = new DisposableGroup();

    const selectAll = (e: KeyboardEvent) => {
      if (this.readonly) return;
      if (e.key === "a" && (IS_MAC ? e.metaKey : e.ctrlKey)) {
        e.stopPropagation();
        e.preventDefault();
        this.inlineEditor?.selectAll();
      }
    };
    this.disposables.addFromEvent(this, "keydown", selectAll);
    // Cell editors share the document event source. Move focus before the
    // event reaches it, otherwise later cell listeners can navigate again
    // with the selection changed by this same keydown.
    this.disposables.addFromEvent(this, "keydown", (e: KeyboardEvent) => {
      if (
        !this.readonly &&
        e.key === "Tab" &&
        !e.defaultPrevented &&
        e.target instanceof Node &&
        this.richText?.contains(e.target)
      ) {
        this.navigateByTab(e);
      }
    });
    // Browsers synthesize `contextmenu` after Shift+F10 unless the DOM keydown
    // is cancelled. Rich-text's internal keydown slot does not cover that
    // native path consistently, so own the table menu shortcut at the cell.
    this.disposables.addFromEvent(this, "keydown", (e: KeyboardEvent) => {
      if (
        !this.readonly &&
        !e.defaultPrevented &&
        ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu")
      ) {
        this._handleKeyDown(e);
      }
    });
    this.disposables.addFromEvent(this, "click", (e: MouseEvent) => {
      if (this.readonly) return;
      e.stopPropagation();
      const clickedFocus = document.activeElement;
      requestAnimationFrame(() => {
        // A keyboard traversal may already have moved focus since the click.
        // Its old cell must not reclaim the caret in this delayed fallback.
        // Clicking cell padding can leave focus outside the rich text until
        // this fallback runs; keep that initial focus acquisition intact.
        if (
          document.activeElement !== clickedFocus &&
          !this.contains(document.activeElement)
        ) {
          return;
        }
        if (!this.inlineEditor?.inlineRange$.value) {
          this.inlineEditor?.focusEnd();
        }
      });
    });

    this.disposables.add(
      effect(() => {
        const isHeader = this._isHeader$.value;
        const hasText = Boolean(this._text$.value);
        const doc = this.ownerDocument;
        const cellEl = doc.createElement(isHeader ? "th" : "td");
        cellEl.setAttribute("data-table-cell", "");
        if (isHeader) cellEl.setAttribute("scope", "col");
        cellEl.className = cellContainerStyle;

        if (!hasText) {
          const pad = doc.createElement("div");
          pad.style.padding =
            "var(--myoxus-table-cell-padding-block) var(--myoxus-table-cell-padding-inline)";
          const spacer = doc.createElement("div");
          spacer.style.height = "22px";
          pad.append(spacer);
          cellEl.append(pad);
          this.richText$.value = undefined;
          this.replaceChildren(cellEl);
          const stopStyle = effect(() => this.applyCellStyle(cellEl));
          return () => {
            stopStyle();
          };
        }

        const inner = new DisposableGroup();

        const onEnter = () =>
          this.tdMouseEnter(this.rowIndex, this.columnIndex);
        const onLeave = () => this.tdMouseLeave();
        cellEl.addEventListener("mouseenter", onEnter);
        cellEl.addEventListener("mouseleave", onLeave);
        cellEl.addEventListener("contextmenu", this.onContextMenu);
        cellEl.addEventListener("copy", this.copyNativeFields, {
          capture: true,
        });
        cellEl.addEventListener("cut", this.copyNativeFields, {
          capture: true,
        });
        cellEl.addEventListener("paste", this.pasteNativeFields, {
          capture: true,
        });
        inner.add(() => {
          cellEl.removeEventListener("mouseenter", onEnter);
          cellEl.removeEventListener("mouseleave", onLeave);
          cellEl.removeEventListener("contextmenu", this.onContextMenu);
          cellEl.removeEventListener("copy", this.copyNativeFields, {
            capture: true,
          });
          cellEl.removeEventListener("cut", this.copyNativeFields, {
            capture: true,
          });
          cellEl.removeEventListener("paste", this.pasteNativeFields, {
            capture: true,
          });
        });

        const richText = doc.createElement("rich-text") as RichText;
        richText.setAttribute("data-disable-ask-ai", "");
        richText.setAttribute("data-not-block-text", "");
        richText.setAttribute("data-parent-flavour", "myoxus:table");
        richText.style.minHeight = "22px";
        richText.style.padding =
          "var(--myoxus-table-cell-padding-block) var(--myoxus-table-cell-padding-inline)";
        richText.enableUndoRedo = false;
        richText.enableClipboard = true;
        richText.verticalScrollContainerGetter = () =>
          this.topContenteditableElement?.host
            ? getViewportElement(this.topContenteditableElement.host)
            : null;

        untracked(() => {
          const table = this.closest<TableBlockComponent>("myoxus-table");
          const manager = this.inlineManager;
          richText.yText = this._text$.peek()!;
          richText.undoManager = table?.store.history.undoManager;
          richText.inlineEventSource =
            this.topContenteditableElement ?? undefined;
          richText.attributesSchema = manager?.getSchema();
          richText.attributeRenderer = manager?.getRenderer();
          if (manager?.embedChecker)
            richText.embedChecker = manager.embedChecker;
          if (manager?.markdownMatches)
            richText.markdownMatches = manager.markdownMatches;
          richText.readonly = this.readonly || this.textProtected;
          richText.style.textAlign =
            normalizeTableColumnTextAlign(this._column$.peek()?.textAlign) ??
            "start";
          richText.title = textProtectionHint(this.textProtection, this.i18n);
        });

        cellEl.append(richText);
        this.replaceChildren(cellEl);
        this.richText$.value = richText;

        inner.add(
          effect(() => {
            void this._syncRevision$.value;
            const row = this.row;
            const column = this.column;
            if (row?.rowId !== undefined) cellEl.dataset.rowId = row.rowId;
            else delete cellEl.dataset.rowId;
            if (column?.columnId !== undefined)
              cellEl.dataset.columnId = column.columnId;
            else delete cellEl.dataset.columnId;

            this.applyCellStyle(cellEl);

            const text = this.text;
            if (text && richText.yText !== text) richText.yText = text;
            const ro = this.readonly || this.textProtected;
            if (richText.readonly !== ro) richText.readonly = ro;
            richText.style.textAlign =
              normalizeTableColumnTextAlign(column?.textAlign) ?? "start";
            richText.title = textProtectionHint(this.textProtection, this.i18n);
          }),
        );

        inner.add(
          effect(() => {
            if (this.readonly) return;
            const inlineEditor = richText.inlineEditor;
            if (!inlineEditor) return;
            const sub = inlineEditor.slots.keydown.subscribe(
              this._handleKeyDown,
            );
            const stopRange = effect(() => {
              const inlineRange = inlineEditor.inlineRange$.value;
              const targetSelection: TableAreaSelection = {
                type: "area",
                rowStartIndex: this.rowIndex,
                rowEndIndex: this.rowIndex,
                columnStartIndex: this.columnIndex,
                columnEndIndex: this.columnIndex,
              };
              const currentSelection =
                this.selectionController.selected$.peek();
              if (
                inlineRange &&
                (!this.menuSession || this.menuSession.aborted) &&
                !TableSelectionData.equals(targetSelection, currentSelection)
              ) {
                this.selectionController.setSelected(targetSelection, false);
              }
            });
            return () => {
              stopRange();
              sub.unsubscribe();
            };
          }),
        );

        inner.add(
          effect(() => {
            if (
              this.readonly ||
              !this.row ||
              !this.column ||
              this.rowIndex !== 0
            )
              return;
            return untracked(() => this.mountOptionControl(cellEl, "column"));
          }),
        );

        inner.add(
          effect(() => {
            if (
              this.readonly ||
              !this.row ||
              !this.column ||
              this.columnIndex !== 0
            )
              return;
            return untracked(() => this.mountOptionControl(cellEl, "row"));
          }),
        );

        inner.add(
          effect(() => {
            if (this.readonly) return;
            return untracked(() => this.mountIndicators(cellEl));
          }),
        );

        return () => {
          inner.dispose();
          if (this.richText$.peek() === richText) {
            this.richText$.value = undefined;
          }
        };
      }),
    );
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.richText$.value = undefined;
    this.replaceChildren();
  }
}

export const createColumnDragPreview = (cells: TableCell[]) => {
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.opacity = "0.8";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.zIndex = "1000";
  container.style.boxShadow = "0 0 10px 0 rgba(0, 0, 0, 0.1)";
  container.style.backgroundColor = cssVar("backgroundPrimaryColor");
  cells.forEach((cell, index) => {
    const div = document.createElement("div");
    const td = cell.querySelector("[data-table-cell]");
    if (index !== 0) {
      div.style.borderTop = td ? getComputedStyle(td).borderTop : "";
    }
    if (td) {
      const computed = getComputedStyle(td);
      div.style.height = `${td.getBoundingClientRect().height}px`;
      div.style.backgroundColor = computed.backgroundColor;
    }
    if (cell.text) {
      const text = new RichText();
      if (td) text.style.padding = getComputedStyle(td).padding;
      text.yText = cell.text;
      text.readonly = true;
      text.attributesSchema = cell.inlineManager?.getSchema();
      text.attributeRenderer = cell.inlineManager?.getRenderer();
      text.embedChecker = cell.inlineManager?.embedChecker ?? (() => false);
      div.append(text);
    }
    container.append(div);
  });
  return container;
};

export const createRowDragPreview = (cells: TableCell[]) => {
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.opacity = "0.8";
  container.style.display = "flex";
  container.style.flexDirection = "row";
  container.style.zIndex = "1000";
  container.style.boxShadow = "0 0 10px 0 rgba(0, 0, 0, 0.1)";
  container.style.backgroundColor = cssVar("backgroundPrimaryColor");
  cells.forEach((cell, index) => {
    const div = document.createElement("div");
    const td = cell.querySelector("[data-table-cell]");
    if (index !== 0) {
      div.style.borderLeft = td ? getComputedStyle(td).borderLeft : "";
    }
    if (td) {
      const computed = getComputedStyle(td);
      div.style.width = `${td.getBoundingClientRect().width}px`;
      div.style.backgroundColor = computed.backgroundColor;
    }
    if (cell.text) {
      const text = new RichText();
      if (td) text.style.padding = getComputedStyle(td).padding;
      text.yText = cell.text;
      text.readonly = true;
      text.attributesSchema = cell.inlineManager?.getSchema();
      text.attributeRenderer = cell.inlineManager?.getRenderer();
      text.embedChecker = cell.inlineManager?.embedChecker ?? (() => false);
      div.append(text);
    }
    container.append(div);
  });
  return container;
};

declare global {
  interface HTMLElementTagNameMap {
    [TableCellComponentName]: TableCell;
  }
}
