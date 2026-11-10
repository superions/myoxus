// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import type { PopupTarget } from "@virgultum/components/context-menu";
import { normalizeTableColumnTextAlign, TextAlign } from "@virgultum/model";
import {
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
  type EditorI18nMessage,
  type SelectionAction,
} from "@virgultum/shared/services";
import { cssVar } from "@virgultum/shared/theme";
import { cellColorList, colorList } from "./color";
import type { TableBlockComponent } from "./table-block";
import type { TableCell } from "./table-cell";
import type { TableAreaSelection } from "./selection-schema";

export type TableMenuTarget =
  | { kind: "column"; id: string }
  | { kind: "row"; id: string; area?: TableAreaSelection }
  | { kind: "cell"; area: TableAreaSelection };
type Presentation = readonly [EditorI18nMessage, MyoxusIconExportName?];
const columnLabels = {
  before: editorMessage("com.myoxus.editor.table.insert-left", "Insert left"),
  after: editorMessage("com.myoxus.editor.table.insert-right", "Insert right"),
  previous: editorMessage("com.myoxus.editor.table.move-left", "Move left"),
  next: editorMessage("com.myoxus.editor.table.move-right", "Move right"),
  clear: editorMessage(
    "com.myoxus.editor.table.clear-column-contents",
    "Clear column contents",
  ),
  reset: editorMessage(
    "com.myoxus.editor.table.clear-column-style",
    "Clear column style",
  ),
} satisfies Record<string, EditorI18nMessage>;
const rowLabels = {
  before: editorMessage("com.myoxus.editor.table.insert-above", "Insert above"),
  after: editorMessage("com.myoxus.editor.table.insert-below", "Insert below"),
  previous: editorMessage("com.myoxus.editor.table.move-up", "Move up"),
  next: editorMessage("com.myoxus.editor.table.move-down", "Move down"),
  clear: editorMessage(
    "com.myoxus.editor.table.clear-row-contents",
    "Clear row contents",
  ),
  reset: editorMessage(
    "com.myoxus.editor.table.clear-row-style",
    "Clear row style",
  ),
} satisfies Record<string, EditorI18nMessage>;
const appearance = {
  grid: editorMessage("com.myoxus.editor.table.appearance.grid", "Grid"),
  ruled: editorMessage("com.myoxus.editor.table.appearance.ruled", "Ruled"),
  plain: editorMessage("com.myoxus.editor.table.appearance.plain", "Plain"),
};
const density = {
  normal: editorMessage("com.myoxus.editor.table.density.normal", "Normal"),
  compact: editorMessage("com.myoxus.editor.table.density.compact", "Compact"),
};
const colors: Record<string, EditorI18nMessage> = {
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

/** Plain presentation and existing commands; the session supplies live target guards. */
export function tableMenuActions(
  cell: TableCell,
  table: TableBlockComponent,
  target: TableMenuTarget,
  area: () => TableAreaSelection | undefined,
  anchor: PopupTarget,
  handoff: () => void,
): SelectionAction[] {
  const manager = cell.dataManager,
    selection = cell.selectionController;
  const i18n = table.std.getOptional(EditorI18nProvider) ?? undefined;
  const item = ([message, icon]: Presentation): SelectionAction => ({
    id: message.key,
    label: resolveEditorMessage(message, i18n),
    icon,
    disabled: false,
  });
  const action = (
    label: Presentation,
    run: () => void | Promise<void>,
    state: Partial<SelectionAction> = {},
  ): SelectionAction => ({ ...item(label), run, ...state });
  const group = (id: string, actions: SelectionAction[]): SelectionAction => ({
    id,
    label: "",
    disabled: false,
    actions,
  });
  const sub = (
    label: Presentation,
    items: SelectionAction[],
    disabled = false,
  ): SelectionAction => ({
    ...item(label),
    disabled,
    control: { type: "menu", items },
  });
  const choice = (
    message: EditorI18nMessage,
    run: () => void,
    active: boolean,
  ) => action([message], run, { active });
  const palette = (
    message: EditorI18nMessage,
    current: string | null | undefined,
    change: (color?: string) => void,
    cellColors = false,
    disabled = false,
  ) =>
    sub(
      [message, "ColorPickerIcon"],
      [
        { name: "Default", color: undefined },
        ...(cellColors ? cellColorList : colorList),
      ].map((option) =>
        action([colors[option.name]!], () => change(option.color), {
          active: current === option.color,
          disabled,
          swatch: option.color?.startsWith("--")
            ? cssVar(option.color)
            : (option.color ?? cssVar("backgroundPrimaryColor")),
        }),
      ),
      disabled,
    );
  const cellPalette = () => {
    const selected = area();
    const cells = selected ? manager.getCellsBySelection(selected) : [];
    const first = cells[0]?.backgroundColor;
    return palette(
      editorMessage(
        "com.myoxus.editor.table.cell-background-color",
        "Cell background color",
      ),
      cells.every((cell) => cell.backgroundColor === first) ? first : null,
      (color) => {
        const selected = area();
        if (selected) manager.setCellsBackgroundColor(selected, color);
      },
      true,
      cells.some((cell) => cell.textProtection === "fixed"),
    );
  };
  if (target.kind === "cell") {
    const selected = area();
    if (!selected) return [];
    const fixed = manager
      .getCellsBySelection(selected)
      .some((cell) => cell.textProtection === "fixed");
    return [
      ...cell.textProtectionActions(selected),
      ...cell.templateVariableActions(handoff),
      ...(!fixed ? [cellPalette()] : []),
      group("clipboard", [
        action([editorMessage("Copy", "Copy"), "CopyIcon"], () => {
          const selected = area();
          if (selected) selection.doCopyOrCut(selected, false);
        }),
        action(
          [
            editorMessage("com.myoxus.editor.table.paste", "Paste"),
            "PasteIcon",
          ],
          async () => {
            try {
              const value = await navigator.clipboard.readText(),
                selected = area();
              if (selected) {
                table.store.captureSync();
                selection.doPaste(value, selected);
                table.store.captureSync();
              }
            } catch (error) {
              if (area()) cell.notifyNativePasteFailure(table, error);
            }
          },
          { disabled: fixed || !navigator.clipboard?.readText },
        ),
      ]),
      action(
        [
          editorMessage(
            "com.myoxus.editor.table.clear-contents",
            "Clear contents",
          ),
          "CloseIcon",
        ],
        () => {
          const selected = area();
          if (selected) manager.clearCellsBySelection(selected);
        },
        { disabled: fixed },
      ),
    ];
  }
  const column = target.kind === "column",
    labels = column ? columnLabels : rowLabels;
  const icons = column
    ? ([
        "InsertLeftIcon",
        "InsertRightIcon",
        "ArrowLeftBigIcon",
        "ArrowRightBigIcon",
      ] as const)
    : ([
        "InsertAboveIcon",
        "InsertBelowIcon",
        "ArrowUpBigIcon",
        "ArrowDownBigIcon",
      ] as const);
  const index = () =>
    column
      ? manager.columns$.value.findIndex((item) => item.columnId === target.id)
      : manager.rows$.value.findIndex((item) => item.rowId === target.id);
  const axis = column
    ? manager.columns$.value[index()]
    : manager.rows$.value[index()];
  if (!axis) return [];
  const fixed = column
    ? manager.hasFixedColumn(target.id)
    : manager.hasFixedRow(target.id);
  const fill = (color?: string) =>
    column
      ? manager.setColumnBackgroundColor(target.id, color)
      : manager.setRowBackgroundColor(target.id, color);
  const insert = (after: number) => {
    if (column) manager.insertColumn(after);
    else manager.insertRow(after);
  };
  const move = (after: number) => {
    if (column) manager.moveColumn(index(), after);
    else if (!manager.moveRow(index(), after))
      cell.notifyHeaderRepeatConflict();
  };
  const header = (value: number) => {
    if (!manager.setHeaderRows(value)) cell.notifyHeaderRepeatConflict();
  };
  const headers = [
    choice(
      editorMessage("com.myoxus.editor.table.header.none", "No header"),
      () => header(0),
      (manager.headerRows$.value ?? 0) === 0,
    ),
    choice(
      editorMessage("com.myoxus.editor.table.header.first-row", "First row"),
      () => header(1),
      manager.headerRows$.value === 1,
    ),
  ];
  if (!column && index() > 0)
    headers.push(
      choice(
        editorMessage(
          "com.myoxus.editor.table.header.through-row",
          "Header through this row",
        ),
        () => header(index() + 1),
        manager.headerRows$.value === index() + 1,
      ),
    );
  const styles = [
    palette(
      editorMessage(
        "com.myoxus.editor.table.background-color",
        "Background color",
      ),
      axis.backgroundColor,
      fill,
      false,
      fixed,
    ),
  ];
  if (column) {
    const align = normalizeTableColumnTextAlign(
      manager.columns$.value[index()]?.textAlign,
    );
    const options = [
      [undefined, colors.Default!, "TextAlignLeftIcon"],
      [
        TextAlign.Left,
        editorMessage("com.myoxus.editor.menu.left", "Left"),
        "TextAlignLeftIcon",
      ],
      [
        TextAlign.Center,
        editorMessage("com.myoxus.editor.menu.center", "Center"),
        "TextAlignCenterIcon",
      ],
      [
        TextAlign.Right,
        editorMessage("com.myoxus.editor.menu.right", "Right"),
        "TextAlignRightIcon",
      ],
    ] as const;
    styles.push(
      sub(
        [
          editorMessage("com.myoxus.editor.toolbar.alignment", "Alignment"),
          "TextAlignLeftIcon",
        ],
        options.map(([value, message, icon]) =>
          action(
            [message, icon],
            () => manager.setColumnTextAlign(target.id, value),
            { active: align === value, disabled: fixed },
          ),
        ),
        fixed,
      ),
    );
  }
  if (axis.backgroundColor)
    styles.push(
      action([labels.reset, "CloseIcon"], () => fill(), { disabled: fixed }),
    );
  return [
    ...(!column
      ? [
          ...cell.templateVariableActions(handoff),
          ...cell.rowRepeatActions(anchor, target.id, handoff),
        ]
      : []),
    sub(
      [
        editorMessage("com.myoxus.editor.table.settings", "Table settings"),
        "SettingsIcon",
      ],
      [
        group("header", headers),
        group(
          "appearance",
          (["grid", "ruled", "plain"] as const).map((value) =>
            choice(
              appearance[value],
              () => manager.setAppearance(value),
              manager.appearance$.value === value,
            ),
          ),
        ),
        group(
          "density",
          (["normal", "compact"] as const).map((value) =>
            choice(
              density[value],
              () => manager.setDensity(value),
              manager.density$.value === value,
            ),
          ),
        ),
      ],
    ),
    ...("area" in target && target.area ? [cellPalette()] : []),
    group("style", styles),
    group("structure", [
      action([labels.before, icons[0]], () => insert(index() - 1)),
      action([labels.after, icons[1]], () => insert(index())),
      action([labels.previous, icons[2]], () => move(index() - 2), {
        disabled: fixed || index() === 0,
      }),
      action([labels.next, icons[3]], () => move(index() + 1), {
        disabled:
          fixed ||
          index() ===
            (column
              ? manager.columns$.value.length
              : manager.rows$.value.length) -
              1,
      }),
    ]),
    group("edit", [
      action(
        [
          editorMessage("com.myoxus.editor.table.duplicate", "Duplicate"),
          "DuplicateIcon",
        ],
        () => {
          if (column) manager.duplicateColumn(index());
          else manager.duplicateRow(index());
        },
      ),
      action(
        [labels.clear, "CloseIcon"],
        () => {
          if (column) manager.clearColumn(target.id);
          else manager.clearRow(target.id);
        },
        { disabled: fixed },
      ),
      action(
        [editorMessage("Delete", "Delete"), "DeleteIcon"],
        () => {
          if (column) manager.deleteColumn(target.id);
          else manager.deleteRow(target.id);
        },
        { disabled: fixed, variant: "destructive" },
      ),
    ]),
  ];
}
