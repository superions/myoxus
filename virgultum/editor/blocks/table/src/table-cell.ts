import {
  ArrowDownBigIcon,
  ArrowLeftBigIcon,
  ArrowRightBigIcon,
  ArrowUpBigIcon,
  CloseIcon,
  ColorPickerIcon,
  CopyIcon,
  DeleteIcon,
  DuplicateIcon,
  InsertAboveIcon,
  InsertBelowIcon,
  InsertLeftIcon,
  InsertRightIcon,
  PasteIcon,
  RefreshCwIcon,
  SettingsIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
} from "@myoxus/icons/lit";
import { computed, effect, signal } from "@preact/signals-core";
import {
  menu,
  popMenu,
  type PopupTarget,
  popupTargetFromElement,
  templateRepeatMenuOptions,
  templateRepeatLabel,
  templateVariableLabel,
} from "@virgultum/components/context-menu";
import { TextBackgroundDuotoneIcon } from "@virgultum/components/icons";
import { IS_MAC } from "@virgultum/global/env";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { DefaultInlineManagerExtension } from "@virgultum/inline-preset";
import {
  type TableAppearance,
  type TableColumn,
  type TableDensity,
  type TableRow,
  normalizeTableColumnTextAlign,
  TextAlign,
} from "@virgultum/model";

import { RichText } from "@virgultum/rich-text";
import {
  EditorI18nProvider,
  type EditorI18nMessage,
  MyoxusHostServiceIdentifier,
  NotificationProvider,
  ThemeProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/shared/services";
import { cssVar } from "@virgultum/shared/theme";
import { getViewportElement } from "@virgultum/shared/utils";
import { ShadowlessElement } from "@virgultum/std";
import type { Text } from "@virgultum/store";
import { html, nothing } from "lit";
import { property, query } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { html as staticHtml, literal } from "lit/static-html.js";

import { cellColorList, colorList, resolveTableColors } from "./color";
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
// Finite display choices keep resource keys discoverable; stored style/color
// identities remain independent of translated captions.
const appearanceMessages = {
  grid: editorMessage("com.myoxus.editor.table.appearance.grid", "Grid"),
  ruled: editorMessage("com.myoxus.editor.table.appearance.ruled", "Ruled"),
  plain: editorMessage("com.myoxus.editor.table.appearance.plain", "Plain"),
} satisfies Record<TableAppearance, EditorI18nMessage>;
const densityMessages = {
  normal: editorMessage("com.myoxus.editor.table.density.normal", "Normal"),
  compact: editorMessage("com.myoxus.editor.table.density.compact", "Compact"),
} satisfies Record<TableDensity, EditorI18nMessage>;
const colorMessages: Readonly<Record<string, EditorI18nMessage>> = {
  Default: editorMessage("com.myoxus.editor.table.color.default", "Default"),
  Blue: editorMessage("com.myoxus.editor.table.color.blue", "Blue"),
  Green: editorMessage("com.myoxus.editor.table.color.green", "Green"),
  Grey: editorMessage("com.myoxus.editor.table.color.grey", "Grey"),
  Orange: editorMessage("com.myoxus.editor.table.color.orange", "Orange"),
  Purple: editorMessage("com.myoxus.editor.table.color.purple", "Purple"),
  Red: editorMessage("com.myoxus.editor.table.color.red", "Red"),
  Teal: editorMessage("com.myoxus.editor.table.color.teal", "Teal"),
  Yellow: editorMessage("com.myoxus.editor.table.color.yellow", "Yellow"),
};

export const TableCellComponentName = "myoxus-table-cell";
export class TableCell extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor text: Text | undefined = undefined;

  get readonly() {
    return this.dataManager.readonly$.value;
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

  private restoreCellFocus(index?: number) {
    if (!this.isConnected) return;
    if (index === undefined) this.inlineEditor?.focusEnd();
    else this.inlineEditor?.setInlineRange({ index, length: 0 });
    // The requested range may equal the caret retained before a menu opened;
    // range equality must not prevent restoring native focus.
    this.inlineEditor?.syncInlineRange();
  }

  private notifyHeaderRepeatConflict() {
    this.closest<TableBlockComponent>("myoxus-table")
      ?.std.getOptional(NotificationProvider)
      ?.toast(
        this.message(
          editorMessage(
            "com.myoxus.editor.table.header-repeat-conflict",
            "Header rows cannot contain repeated template rows.",
          ),
        ),
      );
  }

  private tableSettingsMenu(rowIndex?: number) {
    const currentHeaderRows = this.dataManager.headerRows$.value ?? 0;
    const currentAppearance = this.dataManager.appearance$.value ?? "grid";
    const currentDensity = this.dataManager.density$.value ?? "normal";
    const select = (headerRows: number) => {
      if (!this.dataManager.setHeaderRows(headerRows)) {
        this.notifyHeaderRepeatConflict();
      }
      this.restoreCellFocus();
    };
    return menu.subMenu({
      name: this.message(
        editorMessage("com.myoxus.editor.table.settings", "Table settings"),
      ),
      prefix: SettingsIcon(),
      options: {
        i18n: this.i18n,
        items: [
          menu.group({
            items: [
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.header.none",
                    "No header",
                  ),
                ),
                isSelected: currentHeaderRows === 0,
                select: () => select(0),
              }),
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.header.first-row",
                    "First row",
                  ),
                ),
                isSelected: currentHeaderRows === 1,
                select: () => select(1),
              }),
              ...(rowIndex !== undefined && rowIndex > 0
                ? [
                    menu.action({
                      name: this.message(
                        editorMessage(
                          "com.myoxus.editor.table.header.through-row",
                          "Header through this row",
                        ),
                      ),
                      isSelected: currentHeaderRows === rowIndex + 1,
                      select: () => select(rowIndex + 1),
                    }),
                  ]
                : []),
            ],
          }),
          menu.group({
            items: (["grid", "ruled", "plain"] as TableAppearance[]).map(
              (appearance) =>
                menu.action({
                  name: this.message(appearanceMessages[appearance]),
                  isSelected: currentAppearance === appearance,
                  select: () => {
                    this.dataManager.setAppearance(appearance);
                    this.restoreCellFocus();
                  },
                }),
            ),
          }),
          menu.group({
            items: (["normal", "compact"] as TableDensity[]).map((density) =>
              menu.action({
                name: this.message(densityMessages[density]),
                isSelected: currentDensity === density,
                select: () => {
                  this.dataManager.setDensity(density);
                  this.restoreCellFocus();
                },
              }),
            ),
          }),
        ],
      },
    });
  }

  private colorName(name: string) {
    const message = colorMessages[name];
    return message ? this.message(message) : name;
  }

  openColumnOptions(
    target: PopupTarget,
    column: TableColumn,
    columnIndex: number,
  ) {
    if (this.readonly) return;
    const currentTextAlign = normalizeTableColumnTextAlign(column.textAlign);
    this.selectionController.setSelected({
      type: "column",
      columnId: column.columnId,
    });
    popMenu(target, {
      options: {
        i18n: this.i18n,
        onClose: () => {
          this.selectionController.setSelected(undefined);
          this.restoreCellFocus();
        },
        items: [
          this.tableSettingsMenu(),
          menu.group({
            items: [
              menu.subMenu({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.background-color",
                    "Background color",
                  ),
                ),
                prefix: ColorPickerIcon(),
                options: {
                  i18n: this.i18n,
                  items: [
                    { name: "Default", color: undefined },
                    ...colorList,
                  ].map((item) =>
                    menu.action({
                      prefix: html`<div
                        style="color: ${
                          item.color ?? cssVar("backgroundPrimaryColor")
                        };display: flex;align-items: center;justify-content: center;"
                      >
                        ${TextBackgroundDuotoneIcon}
                      </div>`,
                      name: this.colorName(item.name),
                      isSelected: column.backgroundColor === item.color,
                      select: () => {
                        this.dataManager.setColumnBackgroundColor(
                          column.columnId,
                          item.color,
                        );
                      },
                    }),
                  ),
                },
              }),
              menu.subMenu({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.toolbar.alignment",
                    "Alignment",
                  ),
                ),
                prefix: TextAlignLeftIcon(),
                options: {
                  i18n: this.i18n,
                  items: [
                    {
                      value: undefined,
                      name: this.colorName("Default"),
                      icon: TextAlignLeftIcon,
                    },
                    {
                      value: TextAlign.Left,
                      name: this.message(
                        editorMessage("com.myoxus.editor.menu.left", "Left"),
                      ),
                      icon: TextAlignLeftIcon,
                    },
                    {
                      value: TextAlign.Center,
                      name: this.message(
                        editorMessage(
                          "com.myoxus.editor.menu.center",
                          "Center",
                        ),
                      ),
                      icon: TextAlignCenterIcon,
                    },
                    {
                      value: TextAlign.Right,
                      name: this.message(
                        editorMessage("com.myoxus.editor.menu.right", "Right"),
                      ),
                      icon: TextAlignRightIcon,
                    },
                  ].map((item) =>
                    menu.action({
                      prefix: item.icon(),
                      name: item.name,
                      isSelected: currentTextAlign === item.value,
                      select: () => {
                        this.dataManager.setColumnTextAlign(
                          column.columnId,
                          item.value,
                        );
                      },
                    }),
                  ),
                },
              }),
              ...(column.backgroundColor
                ? [
                    menu.action({
                      name: this.message(
                        editorMessage(
                          "com.myoxus.editor.table.clear-column-style",
                          "Clear column style",
                        ),
                      ),
                      prefix: CloseIcon(),
                      select: () => {
                        this.dataManager.setColumnBackgroundColor(
                          column.columnId,
                          undefined,
                        );
                      },
                    }),
                  ]
                : []),
            ],
          }),
          menu.group({
            items: [
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.insert-left",
                    "Insert left",
                  ),
                ),
                prefix: InsertLeftIcon(),
                select: () => {
                  this.dataManager.insertColumn(
                    columnIndex > 0 ? columnIndex - 1 : undefined,
                  );
                },
              }),
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.insert-right",
                    "Insert right",
                  ),
                ),
                prefix: InsertRightIcon(),
                select: () => {
                  this.dataManager.insertColumn(columnIndex);
                },
              }),
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.move-left",
                    "Move left",
                  ),
                ),
                prefix: ArrowLeftBigIcon(),
                select: () => {
                  this.dataManager.moveColumn(columnIndex, columnIndex - 2);
                },
              }),
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.move-right",
                    "Move right",
                  ),
                ),
                prefix: ArrowRightBigIcon(),
                select: () => {
                  this.dataManager.moveColumn(columnIndex, columnIndex + 1);
                },
              }),
            ],
          }),
          menu.group({
            items: [
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.duplicate",
                    "Duplicate",
                  ),
                ),
                prefix: DuplicateIcon(),
                select: () => {
                  this.dataManager.duplicateColumn(columnIndex);
                },
              }),

              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.clear-column-contents",
                    "Clear column contents",
                  ),
                ),
                prefix: CloseIcon(),
                select: () => {
                  this.dataManager.clearColumn(column.columnId);
                },
              }),

              menu.action({
                name: this.message(editorMessage("Delete", "Delete")),
                class: {
                  "delete-item": true,
                },
                prefix: DeleteIcon(),
                select: () => {
                  this.dataManager.deleteColumn(column.columnId);
                },
              }),
            ],
          }),
        ],
      },
    });
  }

  private templateVariableActions() {
    const block = this.closest<TableBlockComponent>("myoxus-table");
    const host = block?.std.getOptional(MyoxusHostServiceIdentifier);
    if (
      this.readonly ||
      !host?.isTemplateDocument() ||
      !host.openTemplateVariablePicker ||
      !host.getTemplateVariableCapabilities().length
    )
      return [];
    const range = this.inlineEditor?.getInlineRange() ?? {
      index: this.text?.length ?? 0,
      length: 0,
    };
    let nextCaret = range.index;
    return [
      menu.action({
        name: resolveEditorMessage(templateVariableLabel, this.i18n),
        select: () =>
          host.openTemplateVariablePicker?.({
            i18n: this.i18n,
            canWrite: () =>
              !this.readonly &&
              host.isTemplateDocument() &&
              this.isConnected &&
              Boolean(this.inlineEditor),
            insert: (token) => {
              block?.store.captureSync();
              this.inlineEditor?.insertText(range, token);
              nextCaret = range.index + token.length;
              block?.store.captureSync();
            },
            onClose: () => this.restoreCellFocus(nextCaret),
          }),
      }),
    ];
  }

  openRowOptions(
    target: PopupTarget,
    row: TableRow,
    rowIndex: number,
    cellSelection?: TableAreaSelection,
  ) {
    if (this.readonly) return;
    const block = this.closest<TableBlockComponent>("myoxus-table");
    const host = block?.std.getOptional(MyoxusHostServiceIdentifier);
    const i18n = this.i18n;
    const range = this.inlineEditor?.getInlineRange() ?? {
      index: this.text?.length ?? 0,
      length: 0,
    };
    const nextCaret = range.index;
    this.selectionController.setSelected({
      type: "row",
      rowId: row.rowId,
    });
    const { menu: rowMenu } = popMenu(target, {
      options: {
        i18n: this.i18n,
        onClose: () => {
          this.selectionController.setSelected(undefined);
          this.restoreCellFocus(nextCaret);
        },
        items: [
          ...this.templateVariableActions(),
          ...(host?.isTemplateDocument()
            ? [
                menu.action({
                  name: resolveEditorMessage(templateRepeatLabel, i18n),
                  prefix: RefreshCwIcon(),
                  select: () => {
                    // Hand off the same row selection to the shared repeat
                    // menu. A hover submenu must not own focus restoration.
                    rowMenu.close();
                    this.selectionController.setSelected({
                      type: "row",
                      rowId: row.rowId,
                    });
                    popMenu(target, {
                      options: templateRepeatMenuOptions({
                        i18n,
                        unit: () => ({
                          binding: this.dataManager.rows$.value.find(
                            (current) => current.rowId === row.rowId,
                          )?.repeat,
                          texts: this.dataManager.columns$.value.map(
                            (column) =>
                              this.dataManager
                                .getCell(row.rowId, column.columnId)
                                ?.text.toString() ?? "",
                          ),
                          leaf: block?.model.children.length === 0,
                        }),
                        canWrite: () =>
                          !this.readonly &&
                          Boolean(host?.isTemplateDocument()) &&
                          this.dataManager.canSetRowRepeat(row.rowId) &&
                          this.dataManager.rows$.value.some(
                            (current) => current.rowId === row.rowId,
                          ),
                        change: (repeat) => {
                          if (
                            !this.dataManager.setRowRepeat(row.rowId, repeat)
                          ) {
                            this.notifyHeaderRepeatConflict();
                          }
                        },
                        onClose: () => {
                          this.selectionController.setSelected(undefined);
                          this.restoreCellFocus();
                        },
                      }),
                    });
                  },
                }),
              ]
            : []),
          this.tableSettingsMenu(rowIndex),
          ...(cellSelection ? [this.cellColorPickerMenu(cellSelection)] : []),
          menu.group({
            items: [
              menu.subMenu({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.background-color",
                    "Background color",
                  ),
                ),
                prefix: ColorPickerIcon(),
                options: {
                  i18n: this.i18n,
                  items: [
                    { name: "Default", color: undefined },
                    ...colorList,
                  ].map((item) =>
                    menu.action({
                      prefix: html`<div
                        style="color: ${
                          item.color ?? cssVar("backgroundPrimaryColor")
                        };display: flex;align-items: center;justify-content: center;"
                      >
                        ${TextBackgroundDuotoneIcon}
                      </div>`,
                      name: this.colorName(item.name),
                      isSelected: row.backgroundColor === item.color,
                      select: () => {
                        this.dataManager.setRowBackgroundColor(
                          row.rowId,
                          item.color,
                        );
                      },
                    }),
                  ),
                },
              }),
              ...(row.backgroundColor
                ? [
                    menu.action({
                      name: this.message(
                        editorMessage(
                          "com.myoxus.editor.table.clear-row-style",
                          "Clear row style",
                        ),
                      ),
                      prefix: CloseIcon(),
                      select: () => {
                        this.dataManager.setRowBackgroundColor(
                          row.rowId,
                          undefined,
                        );
                      },
                    }),
                  ]
                : []),
            ],
          }),
          menu.group({
            items: [
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.insert-above",
                    "Insert above",
                  ),
                ),
                prefix: InsertAboveIcon(),
                select: () => {
                  this.dataManager.insertRow(
                    rowIndex > 0 ? rowIndex - 1 : undefined,
                  );
                },
              }),
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.insert-below",
                    "Insert below",
                  ),
                ),
                prefix: InsertBelowIcon(),
                select: () => {
                  this.dataManager.insertRow(rowIndex);
                },
              }),
              menu.action({
                name: this.message(
                  editorMessage("com.myoxus.editor.table.move-up", "Move up"),
                ),
                prefix: ArrowUpBigIcon(),
                select: () => {
                  if (!this.dataManager.moveRow(rowIndex, rowIndex - 1)) {
                    this.notifyHeaderRepeatConflict();
                  }
                },
              }),
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.move-down",
                    "Move down",
                  ),
                ),
                prefix: ArrowDownBigIcon(),
                select: () => {
                  if (!this.dataManager.moveRow(rowIndex, rowIndex + 1)) {
                    this.notifyHeaderRepeatConflict();
                  }
                },
              }),
            ],
          }),
          menu.group({
            items: [
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.duplicate",
                    "Duplicate",
                  ),
                ),
                prefix: DuplicateIcon(),
                select: () => {
                  this.dataManager.duplicateRow(rowIndex);
                },
              }),
              menu.action({
                name: this.message(
                  editorMessage(
                    "com.myoxus.editor.table.clear-row-contents",
                    "Clear row contents",
                  ),
                ),
                prefix: CloseIcon(),
                select: () => {
                  this.dataManager.clearRow(row.rowId);
                },
              }),
              menu.action({
                name: this.message(editorMessage("Delete", "Delete")),
                class: {
                  "delete-item": true,
                },
                prefix: DeleteIcon(),
                select: () => {
                  this.dataManager.deleteRow(row.rowId);
                },
              }),
            ],
          }),
        ],
      },
    });
  }

  /** Undefined is inherited paint; null is mixed paint with no checked swatch. */
  createColorPickerMenu(
    currentColor: string | null | undefined,
    select: (color?: string) => void,
    colors = colorList,
  ) {
    return menu.subMenu({
      name: this.message(
        editorMessage(
          "com.myoxus.editor.table.cell-background-color",
          "Cell background color",
        ),
      ),
      prefix: ColorPickerIcon(),
      options: {
        i18n: this.i18n,
        items: [{ name: "Default", color: undefined }, ...colors].map((item) =>
          menu.action({
            prefix: html`<div
              style="color: ${
                item.color?.startsWith("--")
                  ? cssVar(item.color)
                  : (item.color ?? cssVar("backgroundPrimaryColor"))
              };display: flex;align-items: center;justify-content: center;"
            >
              ${TextBackgroundDuotoneIcon}
            </div>`,
            name: this.colorName(item.name),
            isSelected: currentColor === item.color,
            select: () => {
              select(item.color);
            },
          }),
        ),
      },
    });
  }

  private cellColorPickerMenu(selection: TableAreaSelection) {
    const cells = this.dataManager.getCellsBySelection(selection);
    const first = cells[0]?.backgroundColor;
    const current = cells.every((cell) => cell.backgroundColor === first)
      ? first
      : null;
    return this.createColorPickerMenu(
      current,
      (color) => {
        this.dataManager.setCellsBackgroundColor(selection, color);
        this.restoreCellFocus();
      },
      cellColorList,
    );
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
    if (selected.type === "area" && e.currentTarget instanceof HTMLElement) {
      const target = popupTargetFromElement(e.currentTarget);
      popMenu(target, {
        options: {
          i18n: this.i18n,
          items: [
            ...this.templateVariableActions(),
            ...(!this.readonly ? [this.cellColorPickerMenu(selected)] : []),
            menu.group({
              items: [
                menu.action({
                  name: this.message(editorMessage("Copy", "Copy")),
                  prefix: CopyIcon(),
                  select: () => {
                    this.selectionController.doCopyOrCut(selected, false);
                  },
                }),
                menu.action({
                  name: this.message(
                    editorMessage("com.myoxus.editor.table.paste", "Paste"),
                  ),
                  prefix: PasteIcon(),
                  select: () => {
                    navigator.clipboard.readText().then((text) => {
                      this.selectionController.doPaste(text, selected);
                    });
                  },
                }),
              ],
            }),
            menu.group({
              items: [
                menu.action({
                  name: this.message(
                    editorMessage(
                      "com.myoxus.editor.table.clear-contents",
                      "Clear contents",
                    ),
                  ),
                  prefix: CloseIcon(),
                  select: () => {
                    this.dataManager.clearCellsBySelection(selected);
                  },
                }),
              ],
            }),
          ],
        },
      });
    }
  }

  renderColumnOptions(column: TableColumn, columnIndex: number) {
    const openColumnOptions = (e: Event) => {
      e.stopPropagation();
      const element = e.currentTarget;
      if (element instanceof HTMLElement) {
        this.openColumnOptions(
          popupTargetFromElement(element),
          column,
          columnIndex,
        );
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
        this.openRowOptions(popupTargetFromElement(element), row, rowIndex);
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
          this.rowIndex,
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
          .readonly="${this.readonly}"
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
