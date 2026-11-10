import { computed, effect, signal } from "@preact/signals-core";
import {
  popMenu,
  type PopupTarget,
  popupTargetFromElement,
  templateRepeatMenuOptions,
  templateRepeatLabel,
  templateVariableLabel,
} from "@virgultum/components/context-menu";
import { IS_MAC } from "@virgultum/global/env";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { DefaultInlineManagerExtension } from "@virgultum/inline-preset";
import {
  type TableColumn,
  type TableRow,
  normalizeTableColumnTextAlign,
} from "@virgultum/model";

import { RichText } from "@virgultum/rich-text";
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
} from "@virgultum/shared/services";
import { cssVar } from "@virgultum/shared/theme";
import { visitDocumentFieldRuns } from "@virgultum/shared/types";
import { editorToast, getViewportElement } from "@virgultum/shared/utils";
import { ShadowlessElement } from "@virgultum/std";
import { expandRangeEmbeds } from "@virgultum/std/inline";
import {
  nanoid,
  SliceSnapshotSchema,
  toJSON,
  type DeltaOperation,
  type SliceSnapshot,
  type Text,
} from "@virgultum/store";
import { html, nothing } from "lit";
import { eventOptions, property, query } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { html as staticHtml, literal } from "lit/static-html.js";

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
  columnOptionsStyle,
  columnRightIndicatorStyle,
  rowBottomIndicatorStyle,
  rowOptionsCellStyle,
  rowOptionsStyle,
  rowTopIndicatorStyle,
  threePointerIconDotStyle,
  threePointerIconStyle,
} from "./table-cell-css";
import type { TableDataManager } from "./table-data-manager";
export const TableCellComponentName = "myoxus-table-cell";
export class TableCell extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor text: Text | undefined = undefined;

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

  @property({ attribute: false })
  accessor dataManager!: TableDataManager;

  @query("rich-text")
  accessor richText: RichText | null = null;

  @property({ type: Number })
  accessor rowIndex = 0;

  @property({ type: Number })
  accessor columnIndex = 0;

  @property({ type: Boolean })
  accessor isHeader = false;

  @property({ attribute: false })
  accessor row: TableRow | undefined = undefined;

  @property({ attribute: false })
  accessor column: TableColumn | undefined = undefined;

  @property({ attribute: false })
  accessor selectionController!: SelectionController;

  // The session owns table selection until its native menu releases focus.
  menuSession?: AbortSignal;

  @property({ attribute: false })
  accessor height: number | undefined;

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

  @eventOptions({ capture: true })
  private copyNativeFields(event: ClipboardEvent) {
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
  }

  @eventOptions({ capture: true })
  private pasteNativeFields(event: ClipboardEvent) {
    const table = this.closest<TableBlockComponent>("myoxus-table");
    const editor = this.inlineEditor;
    const text = this.text;
    const range = editor?.getInlineRange();
    if (!table || !editor || !text || !range || !event.clipboardData) return;
    const html = event.clipboardData.getData("text/html");
    const hasNativeSnapshot = !!new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector("[data-virgultum-snapshot]");
    if (!hasNativeSnapshot) return;
    let snapshot: SliceSnapshot;
    try {
      const native = table.std.clipboard.readFromClipboard(event.clipboardData)[
        "VIRGULTUM/SNAPSHOT"
      ];
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
  }

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

  rowRepeatActions(
    target: PopupTarget,
    rowId: string,
    handoff: () => void,
  ): SelectionAction[] {
    const block = this.closest<TableBlockComponent>("myoxus-table");
    const host = block?.std.getOptional(MyoxusHostServiceIdentifier);
    if (!host?.isTemplateDocument()) return [];
    const manager = this.dataManager;
    const i18n = this.i18n;
    const canWrite = () =>
      !this.readonly &&
      this.isConnected &&
      this.dataManager === manager &&
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
        run: () => {
          if (!canWrite()) return;
          // The shared repeat picker owns its own lifetime and final caret return.
          handoff();
          this.selectionController.setSelected({ type: "row", rowId });
          popMenu(target, {
            options: templateRepeatMenuOptions({
              i18n,
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
              canWrite,
              change: (repeat) => {
                if (!manager.setRowRepeat(rowId, repeat))
                  this.notifyHeaderRepeatConflict();
              },
              onClose: () => {
                this.selectionController.setSelected(undefined);
                this.restoreCellFocus();
              },
            }),
          });
        },
      },
    ];
  }

  onContextMenu(e: Event) {
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
  }

  renderColumnOptions(column: TableColumn, columnIndex: number) {
    const openColumnOptions = (e: Event) => {
      e.stopPropagation();
      const element = e.currentTarget;
      if (element instanceof HTMLElement) {
        this.openColumnOptions(popupTargetFromElement(element), column);
      }
    };
    return html`<div class=${columnOptionsCellStyle}>
      <div
        data-testid="drag-column-handle"
        role="button"
        tabindex="0"
        aria-label=${this.message(
          editorMessage(
            "com.myoxus.editor.table.column-options",
            "Column options",
          ),
        )}
        data-drag-column-id=${column.columnId}
        class=${classMap({
          [columnOptionsStyle]: true,
        })}
        style=${styleMap({
          opacity: columnIndex === this.hoverColumnIndex$.value ? 1 : undefined,
        })}
        @click=${openColumnOptions}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openColumnOptions(event);
          }
        }}
      >
        ${threePointerIcon()}
      </div>
    </div>`;
  }

  renderRowOptions(row: TableRow, rowIndex: number) {
    const openRowOptions = (e: Event) => {
      e.stopPropagation();
      const element = e.currentTarget;
      if (element instanceof HTMLElement) {
        this.openRowOptions(popupTargetFromElement(element), row);
      }
    };
    return html`<div class=${rowOptionsCellStyle}>
      <div
        data-testid="drag-row-handle"
        role="button"
        tabindex="0"
        aria-label=${this.message(
          editorMessage("com.myoxus.editor.table.row-options", "Row options"),
        )}
        data-drag-row-id=${row.rowId}
        class=${classMap({
          [rowOptionsStyle]: true,
        })}
        style=${styleMap({
          opacity: rowIndex === this.hoverRowIndex$.value ? 1 : undefined,
        })}
        @click=${openRowOptions}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openRowOptions(event);
          }
        }}
      >
        ${threePointerIcon(true)}
      </div>
    </div>`;
  }
  renderOptionsButton() {
    if (this.readonly || !this.row || !this.column) {
      return nothing;
    }
    return html`
      ${
        this.rowIndex === 0
          ? this.renderColumnOptions(this.column, this.columnIndex)
          : nothing
      }
      ${
        this.columnIndex === 0
          ? this.renderRowOptions(this.row, this.rowIndex)
          : nothing
      }
    `;
  }

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

  tdStyle() {
    const columnWidth = this.virtualWidth$.value ?? this.column?.width;
    const backgroundColor =
      (this.row && this.column
        ? this.dataManager.getCell(this.row.rowId, this.column.columnId)
            ?.backgroundColor
        : undefined) ??
      this.column?.backgroundColor ??
      this.row?.backgroundColor ??
      (this.isHeader ? cssVar("backgroundSecondaryColor") : undefined);
    const theme =
      this.closest<TableBlockComponent>("myoxus-table")?.std.get(ThemeProvider);
    const appearance = this.dataManager.appearance$.value ?? "grid";
    return styleMap({
      ...(backgroundColor && theme
        ? resolveTableColors(theme, backgroundColor)
        : { backgroundColor }),
      borderWidth:
        appearance === "grid"
          ? undefined
          : appearance === "ruled"
            ? "1px 0"
            : "0",
      minWidth: columnWidth ? `${columnWidth}px` : `${DefaultColumnWidth}px`,
      maxWidth: columnWidth ? `${columnWidth}px` : `${ColumnMaxWidth}px`,
    });
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
  renderRowIndicator() {
    if (this.readonly) {
      return nothing;
    }
    const columnIndex = this.columnIndex;
    const isFirstColumn = columnIndex === 0;
    const isLastColumn =
      columnIndex === this.dataManager.uiColumns$.value.length - 1;
    const showIndicator = this.showRowIndicator$.value;
    const style = (show: boolean) =>
      styleMap({
        opacity: show ? 1 : 0,
        borderRadius: isFirstColumn
          ? "3px 0 0 3px"
          : isLastColumn
            ? "0 3px 3px 0"
            : "0",
      });
    const indicator0 =
      this.rowIndex === 0
        ? html`
            <div
              style=${style(showIndicator === "top")}
              class=${rowTopIndicatorStyle}
            ></div>
          `
        : nothing;
    return html`
      ${indicator0}
      <div
        style=${style(showIndicator === "bottom")}
        class=${rowBottomIndicatorStyle}
      ></div>
    `;
  }
  renderColumnIndicator() {
    if (this.readonly) {
      return nothing;
    }
    const hoverColumnId$ = this.dataManager.hoverDragHandleColumnId$;
    const draggingColumnId$ = this.dataManager.widthAdjustColumnId$;
    const rowIndex = this.rowIndex;
    const isFirstRow = rowIndex === 0;
    const isLastRow = rowIndex === this.dataManager.uiRows$.value.length - 1;
    const showWidthAdjustIndicator =
      draggingColumnId$.value === this.column?.columnId ||
      hoverColumnId$.value === this.column?.columnId;
    const showIndicator = this.showColumnIndicator$.value;
    const style = (show: boolean) =>
      styleMap({
        opacity: show ? 1 : 0,
        borderRadius: isFirstRow
          ? "3px 3px 0 0"
          : isLastRow
            ? "0 0 3px 3px"
            : "0",
      });
    const indicator0 =
      this.columnIndex === 0
        ? html`
            <div
              style=${style(showIndicator === "left")}
              class=${columnLeftIndicatorStyle}
            ></div>
          `
        : nothing;
    const mouseEnter = () => {
      hoverColumnId$.value = this.column?.columnId;
    };
    const mouseLeave = () => {
      hoverColumnId$.value = undefined;
    };
    return html` ${indicator0}
      <div
        @mouseenter=${mouseEnter}
        @mouseleave=${mouseLeave}
        style=${style(showWidthAdjustIndicator || showIndicator === "right")}
        data-width-adjust-column-id=${this.column?.columnId}
        class=${columnRightIndicatorStyle}
      ></div>`;
  }

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
    // A new row has no inline editor until Lit has mounted its cells and
    // rich-text children. Keep repeated keydowns from adding duplicate rows.
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

  override connectedCallback() {
    super.connectedCallback();
    if (this.readonly) {
      return;
    }
    const selectAll = (e: KeyboardEvent) => {
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
        !e.defaultPrevented &&
        ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu")
      ) {
        this._handleKeyDown(e);
      }
    });
    this.disposables.addFromEvent(this, "click", (e: MouseEvent) => {
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
  }

  override firstUpdated() {
    if (this.readonly) {
      return;
    }
    this.richText$.value?.updateComplete
      .then(() => {
        const inlineEditor = this.inlineEditor;
        if (inlineEditor) {
          this.disposables.add(
            inlineEditor.slots.keydown.subscribe(this._handleKeyDown),
          );
        }

        this.disposables.add(
          effect(() => {
            const richText = this.richText$.value;
            if (!richText) {
              return;
            }
            const inlineEditor = this.inlineEditor;
            if (!inlineEditor) {
              return;
            }
            const inlineRange = inlineEditor.inlineRange$.value;
            const targetSelection: TableAreaSelection = {
              type: "area",
              rowStartIndex: this.rowIndex,
              rowEndIndex: this.rowIndex,
              columnStartIndex: this.columnIndex,
              columnEndIndex: this.columnIndex,
            };
            const currentSelection = this.selectionController.selected$.peek();
            if (
              inlineRange &&
              (!this.menuSession || this.menuSession.aborted) &&
              !TableSelectionData.equals(targetSelection, currentSelection)
            ) {
              this.selectionController.setSelected(targetSelection, false);
            }
          }),
        );
      })
      .catch(console.error);
  }

  override render() {
    const cellTag = this.isHeader ? literal`th` : literal`td`;
    if (!this.text) {
      return staticHtml`<${cellTag}
        data-table-cell
        scope=${ifDefined(this.isHeader ? "col" : undefined)}
        class=${cellContainerStyle}
        style=${this.tdStyle()}
      >
        <div
          style=${styleMap({
            padding:
              "var(--myoxus-table-cell-padding-block) var(--myoxus-table-cell-padding-inline)",
          })}
        >
          <div style="height:22px"></div>
        </div>
      </${cellTag}>`;
    }
    return staticHtml`
      <${cellTag}
        data-table-cell
        scope=${ifDefined(this.isHeader ? "col" : undefined)}
        data-row-id=${this.row?.rowId}
        data-column-id=${this.column?.columnId}
        @mouseenter=${() => {
          this.tdMouseEnter(this.rowIndex, this.columnIndex);
        }}
        @mouseleave=${() => {
          this.tdMouseLeave();
        }}
        @contextmenu=${this.onContextMenu}
        @copy=${this.copyNativeFields}
        @cut=${this.copyNativeFields}
        @paste=${this.pasteNativeFields}
        class=${cellContainerStyle}
        style=${this.tdStyle()}
      >
        <rich-text
          ${ref(this.richText$)}
          data-disable-ask-ai
          data-not-block-text
          style=${styleMap({
            minHeight: "22px",
            padding:
              "var(--myoxus-table-cell-padding-block) var(--myoxus-table-cell-padding-inline)",
            textAlign:
              normalizeTableColumnTextAlign(this.column?.textAlign) ?? "start",
          })}
          .yText="${this.text}"
          .undoManager=${this.closest<TableBlockComponent>("myoxus-table")?.store.history.undoManager}
          .enableUndoRedo=${false}
          .inlineEventSource="${this.topContenteditableElement ?? nothing}"
          .attributesSchema="${this.inlineManager?.getSchema()}"
          .attributeRenderer="${this.inlineManager?.getRenderer()}"
          .embedChecker="${this.inlineManager?.embedChecker}"
          .markdownMatches="${this.inlineManager?.markdownMatches}"
          .readonly="${this.readonly || this.textProtected}"
          title=${textProtectionHint(this.textProtection, this.i18n)}
          .enableClipboard="${true}"
          .verticalScrollContainerGetter="${() =>
            this.topContenteditableElement?.host
              ? getViewportElement(this.topContenteditableElement.host)
              : null}"
          data-parent-flavour="myoxus:table"
        ></rich-text>
        ${this.renderOptionsButton()} ${this.renderColumnIndicator()}
        ${this.renderRowIndicator()}
      </${cellTag}>
    `;
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

const threePointerIcon = (vertical: boolean = false) => {
  return html`
    <div
      class=${threePointerIconStyle}
      style=${styleMap({
        transform: vertical ? "rotate(90deg)" : undefined,
      })}
    >
      <div class=${threePointerIconDotStyle}></div>
      <div class=${threePointerIconDotStyle}></div>
      <div class=${threePointerIconDotStyle}></div>
    </div>
  `;
};
declare global {
  interface HTMLElementTagNameMap {
    [TableCellComponentName]: TableCell;
  }
}
