import { signal } from "@preact/signals-core";
import { describe, expect, it, vi } from "vitest";

import type { GroupBy } from "../core/common/types.js";
import type { DataSource } from "../core/data-source/base.js";
import { DetailSelection } from "../core/detail/selection.js";
import type { FilterGroup } from "../core/filter/types.js";
import { groupByMatchers } from "../core/group-by/define.js";
import { GroupTrait, sortByManually } from "../core/group-by/trait.js";
import { t } from "../core/logical/type-presets.js";
import type { DataViewCellLifeCycle } from "../core/property/index.js";
import type { SingleView } from "../core/view-manager/single-view.js";
import { checkboxPropertyModelConfig } from "../property-presets/checkbox/define.js";
import { multiSelectPropertyModelConfig } from "../property-presets/multi-select/define.js";
import { selectPropertyModelConfig } from "../property-presets/select/define.js";
import { textPropertyModelConfig } from "../property-presets/text/define.js";
import {
  canGroupable,
  ensureKanbanGroupColumn,
  pickKanbanGroupColumn,
  resolveKanbanGroupBy,
} from "../view-presets/kanban/group-by-utils.js";
import { kanbanAccessibleText } from "../view-presets/kanban/kanban-accessibility.js";
import {
  KanbanSingleView,
  materializeKanbanColumns,
} from "../view-presets/kanban/kanban-view-manager.js";
import { KanbanCard } from "../view-presets/kanban/pc/card.js";
import { KanbanDragController } from "../view-presets/kanban/pc/controller/drag.js";
import { KanbanSelectionController } from "../view-presets/kanban/pc/controller/selection.js";
import type { KanbanGroup } from "../view-presets/kanban/pc/group.js";
import { KanbanViewUILogic } from "../view-presets/kanban/pc/kanban-view-ui-logic.js";

type Column = {
  id: string;
  type: string;
  data?: Record<string, unknown>;
};

type TestPropertyMeta = {
  type: string;
  config: {
    kanbanGroup?: {
      enabled: boolean;
      mutable?: boolean;
    };
    propertyData: {
      default: () => Record<string, unknown>;
    };
    jsonValue: {
      type: (options: {
        data: Record<string, unknown>;
        dataSource: DataSource;
      }) => unknown;
    };
  };
};

type MockDataSource = {
  properties$: ReturnType<typeof signal<string[]>>;
  provider: {
    getAll: () => Map<unknown, unknown>;
  };
  serviceGetOrCreate: (key: unknown, create: () => unknown) => unknown;
  propertyTypeGet: (propertyId: string) => string | undefined;
  propertyMetaGet: (type: string) => TestPropertyMeta | undefined;
  propertyDataGet: (propertyId: string) => Record<string, unknown>;
  propertyDataTypeGet: (propertyId: string) => unknown;
  propertyAdd: (
    _position: unknown,
    ops?: {
      type?: string;
    },
  ) => string;
  propertyDataSet: (propertyId: string, data: Record<string, unknown>) => void;
};

const asDataSource = (dataSource: object): DataSource =>
  dataSource as DataSource;

const toTestMeta = <TData extends Record<string, unknown>>(
  type: string,
  config: {
    kanbanGroup?: {
      enabled: boolean;
      mutable?: boolean;
    };
    propertyData: {
      default: () => TData;
    };
    jsonValue: {
      type: (options: { data: TData; dataSource: DataSource }) => unknown;
    };
  },
): TestPropertyMeta => ({
  type,
  config: {
    kanbanGroup: config.kanbanGroup,
    propertyData: {
      default: () => config.propertyData.default(),
    },
    jsonValue: {
      type: ({ data, dataSource }) =>
        config.jsonValue.type({
          data: data as TData,
          dataSource,
        }),
    },
  },
});

const immutableBooleanMeta = toTestMeta("immutable-boolean", {
  ...checkboxPropertyModelConfig.config,
  kanbanGroup: {
    enabled: true,
    mutable: false,
  },
});

const createMockDataSource = (columns: Column[]): MockDataSource => {
  const properties$ = signal(columns.map((column) => column.id));
  const typeById = new Map(columns.map((column) => [column.id, column.type]));
  const dataById = new Map(
    columns.map((column) => [column.id, column.data ?? {}]),
  );
  const services = new Map<unknown, unknown>();

  const metaEntries: Array<[string, TestPropertyMeta]> = [
    [
      checkboxPropertyModelConfig.type,
      toTestMeta(
        checkboxPropertyModelConfig.type,
        checkboxPropertyModelConfig.config,
      ),
    ],
    [
      selectPropertyModelConfig.type,
      toTestMeta(
        selectPropertyModelConfig.type,
        selectPropertyModelConfig.config,
      ),
    ],
    [
      multiSelectPropertyModelConfig.type,
      toTestMeta(
        multiSelectPropertyModelConfig.type,
        multiSelectPropertyModelConfig.config,
      ),
    ],
    [
      textPropertyModelConfig.type,
      toTestMeta(textPropertyModelConfig.type, textPropertyModelConfig.config),
    ],
    [immutableBooleanMeta.type, immutableBooleanMeta],
  ];
  const metaByType = new Map(metaEntries);

  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value != null
      ? (value as Record<string, unknown>)
      : {};

  let autoColumnId = 0;

  const dataSource = {
    properties$,
    provider: {
      getAll: () => new Map<unknown, unknown>(),
    },
    serviceGetOrCreate: (key: unknown, create: () => unknown) => {
      if (!services.has(key)) {
        services.set(key, create());
      }
      return services.get(key);
    },
    propertyTypeGet: (propertyId: string) => typeById.get(propertyId),
    propertyMetaGet: (type: string) => metaByType.get(type),
    propertyDataGet: (propertyId: string) => asRecord(dataById.get(propertyId)),
    propertyDataTypeGet: (propertyId: string) => {
      const type = typeById.get(propertyId);
      if (!type) {
        return;
      }
      const meta = metaByType.get(type);
      if (!meta) {
        return;
      }
      return meta.config.jsonValue.type({
        data: asRecord(dataById.get(propertyId)),
        dataSource: asDataSource(dataSource),
      });
    },
    propertyAdd: (
      _position: unknown,
      ops?: {
        type?: string;
      },
    ) => {
      const type = ops?.type ?? selectPropertyModelConfig.type;
      const id = `auto-${++autoColumnId}`;
      const meta = metaByType.get(type);
      const data = meta?.config.propertyData.default() ?? {};

      typeById.set(id, type);
      dataById.set(id, data);
      properties$.value = [...properties$.value, id];
      return id;
    },
    propertyDataSet: (propertyId: string, data: Record<string, unknown>) => {
      dataById.set(propertyId, data);
    },
  };

  return dataSource;
};

const createDragController = () => {
  type DragLogic = ConstructorParameters<typeof KanbanDragController>[0];
  return new KanbanDragController({} as DragLogic);
};

describe("kanban", () => {
  describe("accessibility", () => {
    it("normalizes native Kanban role labels without leaking object fallbacks", () => {
      expect(kanbanAccessibleText("  Spec  ")).toBe("Spec");
      expect(kanbanAccessibleText({ toString: () => "  Done  " })).toBe("Done");
      expect(kanbanAccessibleText({})).toBe("");
      expect(kanbanAccessibleText(undefined)).toBe("");
    });

    it("keeps native card labels user-facing when title values are pending", () => {
      if (!customElements.get("myoxus-data-view-kanban-card")) {
        customElements.define("myoxus-data-view-kanban-card", KanbanCard);
      }
      const createCard = (label: string) => {
        const card = document.createElement(
          "myoxus-data-view-kanban-card",
        ) as KanbanCard;
        card.cardId = "row-technical-id";
        card.kanbanViewLogic = {
          view: {
            getHeaderTitle: () => ({
              cellGetOrCreate: () => ({
                value$: { value: "" },
              }),
              stringValueGet: () => label,
            }),
          },
        } as unknown as KanbanViewUILogic;
        (
          card as unknown as {
            syncAccessibilityAttributes: () => void;
          }
        ).syncAccessibilityAttributes();
        return card;
      };

      expect(createCard("Keyboard").getAttribute("aria-label")).toBe(
        "Keyboard",
      );
      expect(createCard("").hasAttribute("aria-label")).toBe(false);

      const visibleTitleCard = createCard("");
      const visibleTitle = document.createElement("div");
      visibleTitle.className = "card-header-title";
      visibleTitle.textContent = "Keyboard";
      visibleTitleCard.append(visibleTitle);
      (
        visibleTitleCard as unknown as {
          syncAccessibilityAttributes: () => void;
        }
      ).syncAccessibilityAttributes();
      expect(visibleTitleCard.getAttribute("aria-label")).toBe("Keyboard");
    });
  });

  describe("group-by define", () => {
    it("boolean group should not include ungroup bucket", () => {
      const booleanGroup = groupByMatchers.find(
        (group) => group.name === "boolean",
      );
      expect(booleanGroup).toBeDefined();

      const keys = booleanGroup!
        .defaultKeys(t.boolean.instance())
        .map((group) => group.key);

      expect(keys).toEqual(["true", "false"]);
    });

    it("boolean group should fallback invalid values to false bucket", () => {
      const booleanGroup = groupByMatchers.find(
        (group) => group.name === "boolean",
      );
      expect(booleanGroup).toBeDefined();

      const groups = booleanGroup!.valuesGroup(undefined, t.boolean.instance());
      expect(groups).toEqual([{ key: "false", value: false }]);
    });
  });

  describe("columns materialization", () => {
    it("appends missing properties while preserving existing order and state", () => {
      const columns = [{ id: "status", hide: true }, { id: "title" }];

      const next = materializeKanbanColumns(columns, [
        "title",
        "status",
        "date",
      ]);

      expect(next).toEqual([
        { id: "status", hide: true },
        { id: "title" },
        { id: "date" },
      ]);
    });

    it("drops stale columns that no longer exist in data source", () => {
      const columns = [{ id: "title" }, { id: "removed", hide: true }];

      const next = materializeKanbanColumns(columns, ["title"]);

      expect(next).toEqual([{ id: "title" }]);
    });

    it("returns original reference when columns are already materialized", () => {
      const columns = [{ id: "title" }, { id: "status", hide: true }];

      const next = materializeKanbanColumns(columns, ["title", "status"]);

      expect(next).toBe(columns);
    });
  });

  describe("group sort persistence", () => {
    it("keeps manual group order when a card move updates row sort", () => {
      const dataSource = createMockDataSource([
        {
          data: {
            options: [
              { color: "blue", id: "todo", value: "To Do" },
              { color: "green", id: "done", value: "Done" },
              { color: "yellow", id: "review", value: "Review" },
            ],
          },
          id: "status",
          type: selectPropertyModelConfig.type,
        },
      ]);
      const groupBy = signal<GroupBy | undefined>({
        columnId: "status",
        hideEmpty: false,
        name: "select",
        type: "groupBy",
      });
      const viewData = signal({
        groupProperties: [
          { hide: false, key: "review", manuallyCardSort: [] },
          { hide: false, key: "todo", manuallyCardSort: ["row-1"] },
          { hide: false, key: "done", manuallyCardSort: [] },
        ],
      });
      const cellValues = new Map<string, string | null>([["row-1", "todo"]]);
      const changeRowSort = vi.fn();

      const view = {
        cellGetOrCreate: (rowId: string) => ({
          jsonValue$: {
            get value() {
              return cellValues.get(rowId) ?? null;
            },
          },
          jsonValueSet: (value: string | null) => {
            cellValues.set(rowId, value);
          },
        }),
        data$: viewData,
        isLocked$: signal(false),
        manager: { dataSource: asDataSource(dataSource) },
        propertyGetOrCreate: () => ({
          dataType$: {
            value: dataSource.propertyDataTypeGet("status"),
          },
          id: "status",
        }),
        rows$: {
          value: [{ rowId: "row-1" }],
        },
      };
      const trait = new GroupTrait(groupBy, view as unknown as SingleView, {
        changeGroupSort: vi.fn(),
        changeRowSort,
        groupBySet: vi.fn(),
        sortGroup: (ids, asc) => {
          const sorted = sortByManually(
            ids,
            (id) => id,
            viewData.value.groupProperties.map((group) => group.key),
          );
          return asc === false ? sorted.reverse() : sorted;
        },
        sortRow: (_key, rows) => rows,
      });

      trait.moveCardTo("row-1", "todo", "done", "end");

      expect(cellValues.get("row-1")).toBe("done");
      expect(changeRowSort).toHaveBeenCalledWith(
        ["review", "todo", "done", "Ungroups"],
        "done",
        ["row-1"],
      );
    });
  });

  describe("filtering", () => {
    const sharedFilter: FilterGroup = {
      type: "group",
      op: "and",
      conditions: [
        {
          type: "filter",
          left: {
            type: "ref",
            name: "status",
          },
          function: "is",
          args: [{ type: "literal", value: "Done" }],
        },
      ],
    };

    const sharedTitleProperty = {
      id: "title",
      cellGetOrCreate: () => ({
        jsonValue$: {
          value: "Task 1",
        },
      }),
    };

    it("evaluates filters with hidden columns", () => {
      const statusProperty = {
        id: "status",
        cellGetOrCreate: () => ({
          jsonValue$: {
            value: "Done",
          },
        }),
      };

      const view = {
        filter$: { value: sharedFilter },
        // Simulate status being hidden in current view.
        properties$: { value: [sharedTitleProperty] },
        propertiesRaw$: { value: [sharedTitleProperty, statusProperty] },
      } as unknown as KanbanSingleView;

      expect(KanbanSingleView.prototype.isShow.call(view, "row-1")).toBe(true);
    });

    it("returns false when hidden filtered column does not match", () => {
      const statusProperty = {
        id: "status",
        cellGetOrCreate: () => ({
          jsonValue$: {
            value: "In Progress",
          },
        }),
      };

      const view = {
        filter$: { value: sharedFilter },
        // Simulate status being hidden in current view.
        properties$: { value: [sharedTitleProperty] },
        propertiesRaw$: { value: [sharedTitleProperty, statusProperty] },
      } as unknown as KanbanSingleView;

      expect(KanbanSingleView.prototype.isShow.call(view, "row-1")).toBe(false);
    });
  });

  describe("drag indicator", () => {
    it("shows drop preview when insert position exists", () => {
      const controller = createDragController();
      const position = {
        group: {} as KanbanGroup,
        position: "end" as const,
      };
      controller.getInsertPosition = vi.fn().mockReturnValue(position);

      const displaySpy = vi.spyOn(controller.dropPreview, "display");
      const removeSpy = vi.spyOn(controller.dropPreview, "remove");

      const result = controller.showIndicator({} as MouseEvent, undefined);

      expect(result).toBe(position);
      // P-VIRG-ARCH-E-02: `display` nimmt jetzt 4 Argumente
      // (group, self, card, ctx). Page-Modus -> `ctx.scale === 1`.
      expect(displaySpy).toHaveBeenCalledWith(
        position.group,
        undefined,
        undefined,
        expect.objectContaining({ scale: 1 }),
      );
      expect(removeSpy).not.toHaveBeenCalled();
    });

    it("removes drop preview when insert position does not exist", () => {
      const controller = createDragController();
      controller.getInsertPosition = vi.fn().mockReturnValue(undefined);

      const displaySpy = vi.spyOn(controller.dropPreview, "display");
      const removeSpy = vi.spyOn(controller.dropPreview, "remove");

      const result = controller.showIndicator({} as MouseEvent, undefined);

      expect(result).toBeUndefined();
      expect(displaySpy).not.toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalledOnce();
    });

    it("forwards hovered card to drop preview for precise insertion cursor", () => {
      const controller = createDragController();
      const hoveredCard = document.createElement(
        "myoxus-data-view-kanban-card",
      ) as KanbanCard;
      const positionCard = document.createElement(
        "myoxus-data-view-kanban-card",
      ) as KanbanCard;
      const position = {
        group: {} as KanbanGroup,
        card: positionCard,
        position: { before: true, id: "card-id" } as const,
      };
      controller.getInsertPosition = vi.fn().mockReturnValue(position);

      const displaySpy = vi.spyOn(controller.dropPreview, "display");

      controller.showIndicator({} as MouseEvent, hoveredCard);

      // P-VIRG-ARCH-E-02: 4. Argument `ctx` (ViewportContext).
      expect(displaySpy).toHaveBeenCalledWith(
        position.group,
        hoveredCard,
        position.card,
        expect.objectContaining({ scale: 1 }),
      );
    });
  });

  describe("group-by utils", () => {
    it("allows only kanban-enabled property types to group", () => {
      const dataSource = createMockDataSource([
        { id: "text", type: textPropertyModelConfig.type },
        { id: "select", type: selectPropertyModelConfig.type },
        { id: "multi-select", type: multiSelectPropertyModelConfig.type },
        { id: "checkbox", type: checkboxPropertyModelConfig.type },
      ]);

      expect(canGroupable(asDataSource(dataSource), "text")).toBe(false);
      expect(canGroupable(asDataSource(dataSource), "select")).toBe(true);
      expect(canGroupable(asDataSource(dataSource), "multi-select")).toBe(true);
      expect(canGroupable(asDataSource(dataSource), "checkbox")).toBe(true);
    });

    it("prefers mutable group column over immutable ones", () => {
      const dataSource = createMockDataSource([
        {
          id: "immutable-bool",
          type: "immutable-boolean",
        },
        {
          id: "checkbox",
          type: checkboxPropertyModelConfig.type,
        },
      ]);

      expect(pickKanbanGroupColumn(asDataSource(dataSource))).toBe("checkbox");
    });

    it("creates default status select column when no groupable column exists", () => {
      const dataSource = createMockDataSource([
        {
          id: "text",
          type: textPropertyModelConfig.type,
        },
      ]);

      const statusColumnId = ensureKanbanGroupColumn(asDataSource(dataSource));

      expect(statusColumnId).toEqual(expect.any(String));
      expect(statusColumnId).not.toBe("");
      expect(dataSource.propertyTypeGet(statusColumnId as string)).toBe(
        selectPropertyModelConfig.type,
      );
      const options =
        (
          dataSource.propertyDataGet(statusColumnId as string) as {
            options?: { value: string }[];
          }
        ).options ?? [];
      expect(options.map((option) => option.value)).toEqual([
        "Todo",
        "In Progress",
        "Done",
      ]);
    });

    it("defaults hideEmpty to true for non-option groups", () => {
      const dataSource = createMockDataSource([
        {
          id: "checkbox",
          type: checkboxPropertyModelConfig.type,
        },
      ]);

      const next = resolveKanbanGroupBy(asDataSource(dataSource));
      expect(next?.columnId).toBe("checkbox");
      expect(next?.hideEmpty).toBe(true);
      expect(next?.name).toBe("boolean");
    });

    it("defaults hideEmpty to false for select grouping", () => {
      const dataSource = createMockDataSource([
        {
          id: "select",
          type: selectPropertyModelConfig.type,
        },
      ]);

      const next = resolveKanbanGroupBy(asDataSource(dataSource));
      expect(next?.columnId).toBe("select");
      expect(next?.hideEmpty).toBe(false);
      expect(next?.name).toBe("select");
    });

    it("preserves sort and explicit hideEmpty when resolving groupBy", () => {
      const dataSource = createMockDataSource([
        {
          id: "checkbox",
          type: checkboxPropertyModelConfig.type,
        },
      ]);
      const current: GroupBy = {
        type: "groupBy",
        columnId: "checkbox",
        name: "boolean",
        sort: { desc: true },
        hideEmpty: true,
      };

      const next = resolveKanbanGroupBy(asDataSource(dataSource), current);

      expect(next?.columnId).toBe("checkbox");
      expect(next?.sort).toEqual({ desc: true });
      expect(next?.hideEmpty).toBe(true);
    });

    it("replaces current non-groupable column with a valid kanban column", () => {
      const dataSource = createMockDataSource([
        { id: "text", type: textPropertyModelConfig.type },
        { id: "checkbox", type: checkboxPropertyModelConfig.type },
      ]);

      const next = resolveKanbanGroupBy(asDataSource(dataSource), {
        type: "groupBy",
        columnId: "text",
        name: "text",
      });

      expect(next?.columnId).toBe("checkbox");
      expect(next?.name).toBe("boolean");
      expect(next?.hideEmpty).toBe(true);
    });
  });

  describe("detail selection", () => {
    it("should avoid recursive selection update when exiting select edit mode", () => {
      vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      }) as typeof requestAnimationFrame);
      try {
        let selection: DetailSelection;
        let beforeExitCalls = 0;

        const cell = {
          beforeEnterEditMode: () => true,
          beforeExitEditingMode: () => {
            beforeExitCalls += 1;
            selection.selection = {
              propertyId: "status",
              isEditing: false,
            };
          },
          afterEnterEditingMode: () => {},
          focusCell: () => true,
          blurCell: () => true,
          forceUpdate: () => {},
        } satisfies DataViewCellLifeCycle;

        const field = {
          isFocus$: signal(false),
          isEditing$: signal(false),
          cell,
          focus: () => {},
          blur: () => {},
        };

        const detail = {
          querySelector: () => field,
        };

        selection = new DetailSelection(detail);
        selection.selection = {
          propertyId: "status",
          isEditing: true,
        };

        selection.selection = {
          propertyId: "status",
          isEditing: false,
        };

        expect(beforeExitCalls).toBe(1);
        expect(field.isEditing$.value).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("selection controller", () => {
    it("keeps selected card membership in sync after native Move To", () => {
      const raf = vi
        .spyOn(globalThis, "requestAnimationFrame")
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 0;
        });
      try {
        let controller: KanbanSelectionController;
        const host = document.createElement("div") as HTMLElement & {
          disposables?: { add: () => void };
        };
        host.disposables = { add: () => {} };
        const moveCardTo = vi.fn();
        const logic = {
          setSelection: (selection?: unknown) => {
            (
              controller as unknown as {
                _selection?: unknown;
              }
            )._selection = selection;
          },
          ui$: signal(host),
          view: {
            groupTrait: {
              moveCardTo,
            },
          },
        } as unknown as KanbanViewUILogic;
        controller = new KanbanSelectionController(logic);
        (
          controller as unknown as {
            _selection: unknown;
          }
        )._selection = {
          selectionType: "card",
          cards: [{ cardId: "spec", groupKey: "todo" }],
          type: "kanban",
          viewId: "kanban-view",
        };

        controller.moveCard("spec", "done");

        expect(moveCardTo).toHaveBeenCalledWith(
          "spec",
          "todo",
          "done",
          "start",
        );
        expect(controller.selection).toMatchObject({
          selectionType: "card",
          cards: [{ cardId: "spec", groupKey: "done" }],
        });
      } finally {
        raf.mockRestore();
      }
    });
  });

  describe("pc scrolling", () => {
    const createWheelEvent = (
      container: HTMLElement,
      options: Partial<WheelEvent> = {},
    ) =>
      ({
        currentTarget: container,
        ctrlKey: false,
        deltaX: 0,
        deltaY: 0,
        metaKey: false,
        shiftKey: false,
        stopPropagation: vi.fn(),
        ...options,
      }) as unknown as WheelEvent & {
        stopPropagation: ReturnType<typeof vi.fn>;
      };

    const createScrollContainer = (
      scrollWidth: number,
      clientWidth: number,
    ) => {
      const container = document.createElement("div");
      Object.defineProperties(container, {
        clientWidth: { configurable: true, value: clientWidth },
        scrollWidth: { configurable: true, value: scrollWidth },
      });
      return container;
    };

    const createLogic = () =>
      new KanbanViewUILogic(
        { config: {} } as ConstructorParameters<typeof KanbanViewUILogic>[0],
        {
          id: "kanban-test",
          readonly$: signal(false),
          traitGet: () => undefined,
          type: "kanban",
        } as unknown as ConstructorParameters<typeof KanbanViewUILogic>[1],
      );

    it("does not trap vertical editor scrolling when the kanban board overflows horizontally", () => {
      const logic = createLogic();
      const container = createScrollContainer(800, 300);
      const event = createWheelEvent(container, { deltaX: 0, deltaY: 120 });

      logic.onWheel(event);

      expect(event.stopPropagation).not.toHaveBeenCalled();
    });

    it("keeps horizontal board scrolling isolated from the surrounding editor", () => {
      const logic = createLogic();
      const container = createScrollContainer(800, 300);
      const event = createWheelEvent(container, { deltaX: 80, deltaY: 5 });

      logic.onWheel(event);

      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    });

    it("does not intercept wheel events when the board has no horizontal overflow", () => {
      const logic = createLogic();
      const container = createScrollContainer(300, 300);
      const event = createWheelEvent(container, { deltaX: 80, deltaY: 5 });

      logic.onWheel(event);

      expect(event.stopPropagation).not.toHaveBeenCalled();
    });
  });
});
