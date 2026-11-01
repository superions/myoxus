import { AddCursorIcon } from "@myoxus/icons/lit";
import { computed, signal } from "@preact/signals-core";
import {
  menu,
  popMenu,
  popupTargetFromElement,
} from "@virgultum/components/context-menu";
import { css } from "@virgultum/shared/styles";
import type { InsertToPosition } from "@virgultum/shared/utils";
import { type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { html } from "lit/static-html.js";

import {
  type GroupTrait,
  groupTraitKey,
} from "../../../core/group-by/trait.js";
import {
  createUniComponentFromWebComponent,
  renderUniLit,
} from "../../../core/index.js";
import { defaultActivators } from "../../../core/utils/wc-dnd/sensors/index.js";
import {
  createSortContext,
  sortable,
} from "../../../core/utils/wc-dnd/sort/sort-context.js";
import { horizontalListSortingStrategy } from "../../../core/utils/wc-dnd/sort/strategies/index.js";
import {
  DataViewUIBase,
  DataViewUILogicBase,
} from "../../../core/view/data-view-base.js";
import type { KanbanSingleView } from "../kanban-view-manager.js";
import type { KanbanViewSelectionWithType } from "../selection.js";
import { PAGE_VIEWPORT, type ViewportContext } from "../viewport-context.js";
import { KanbanClipboardController } from "./controller/clipboard.js";
import { KanbanDragController } from "./controller/drag.js";
import { KanbanHotkeysController } from "./controller/hotkeys.js";
import { KanbanSelectionController } from "./controller/selection.js";

export class KanbanViewUILogic extends DataViewUILogicBase<
  KanbanSingleView,
  KanbanViewSelectionWithType
> {
  ui$ = signal<KanbanViewUI | undefined>();
  clipboardController = new KanbanClipboardController(this);
  dragController = new KanbanDragController(this);
  hotkeysController = new KanbanHotkeysController(this);
  selectionController = new KanbanSelectionController(this);

  /**
   * Liefert die aktuelle `ViewportContext` (P-VIRG-ARCH-E-02).
   *
   * Page-Modus: `root.config.viewportProvider$` ist `undefined` ->
   * `PAGE_VIEWPORT` (`{ scale: 1 }`).
   *
   * Edgeless-Modus: Provider liefert eine Funktion, die
   * `edgelessViewportContext(block)` aufruft. Das
   * Funktions-Return wird hier per Cast auf `ViewportContext`
   * geschmalert, weil der Core (`DataViewRendererConfig`) den
   * konkreten Typ nicht kennen darf.
   */
  override currentViewport(): ViewportContext {
    const provider = this.root.config.viewportProvider$?.value;
    if (!provider) return PAGE_VIEWPORT;
    const result = (provider as () => ViewportContext)();
    return result ?? PAGE_VIEWPORT;
  }

  groupTrait$ = computed(() => {
    return this.view.traitGet(groupTraitKey);
  });

  groups$ = computed(() => {
    const groupTrait = this.groupTrait$.value;
    return groupTrait?.groupsDataList$.value || [];
  });

  private get readonly() {
    return this.view.readonly$.value;
  }

  clearSelection = () => {
    this.selectionController.clear();
  };

  addRow = (position: InsertToPosition) => {
    if (this.readonly) return;
    const rowId = this.view.rowAdd(position);
    if (rowId) {
      this.root.openDetailPanel({
        view: this.view,
        rowId,
      });
    }
    this.ui$.value?.requestUpdate();
    return rowId;
  };

  focusFirstCell = () => {
    this.selectionController.focusFirstCell();
  };

  showIndicator = (evt: MouseEvent) => {
    return this.dragController.showIndicator(evt, undefined) != null;
  };

  hideIndicator = () => {
    this.dragController.dropPreview.remove();
  };

  moveTo = (id: string, evt: MouseEvent) => {
    const position = this.dragController.getInsertPosition(evt);
    if (position) {
      position.group.group.manager.moveCardTo(
        id,
        "",
        position.group.group.key,
        position.position,
      );
    }
  };

  onWheel = (event: WheelEvent) => {
    if (event.metaKey || event.ctrlKey) {
      return;
    }
    const ele = event.currentTarget;
    if (ele instanceof HTMLElement) {
      if (ele.scrollWidth <= ele.clientWidth) {
        return;
      }
      const mostlyHorizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (mostlyHorizontal || event.shiftKey) {
        event.stopPropagation();
      }
    }
  };

  renderAddGroup = (groupHelper: GroupTrait) => {
    const addGroup = groupHelper.addGroup;
    if (!addGroup) {
      return;
    }
    const add = (e: MouseEvent) => {
      const ele = e.currentTarget as HTMLElement;
      popMenu(popupTargetFromElement(ele), {
        options: {
          items: [
            menu.input({
              onComplete: (text) => {
                const column = groupHelper.property$.value;
                if (column) {
                  column.dataUpdate(() =>
                    addGroup({
                      text,
                      oldData: column.data$.value,
                      dataSource: this.view.manager.dataSource,
                    }),
                  );
                }
              },
            }),
          ],
        },
      });
    };
    return html` <div class="${addGroupButtonStyle}" @click="${add}">
      <div class="${addGroupIconStyle}">${AddCursorIcon()}</div>
    </div>`;
  };

  scrollContainer$ = signal<HTMLElement | undefined>(undefined);

  renderer = createUniComponentFromWebComponent(KanbanViewUI);
}

export class KanbanViewUI extends DataViewUIBase<KanbanViewUILogic> {
  readonly sortContext = createSortContext({
    activators: defaultActivators,
    container: this,
    onDragEnd: (evt) => {
      const over = evt.over;
      const activeId = evt.active.id;
      const groupTrait = this.logic.groupTrait$.value;
      const groups = groupTrait?.groupsDataList$.value;
      if (over && over.id !== activeId && groups) {
        const activeIndex = groups.findIndex((data) => data?.key === activeId);
        const overIndex = groups.findIndex((data) => data?.key === over.id);

        groupTrait?.moveGroupTo(
          activeId,
          activeIndex > overIndex
            ? {
                before: true,
                id: over.id,
              }
            : {
                before: false,
                id: over.id,
              },
        );
      }
    },
    modifiers: [
      ({ transform }) => {
        return {
          ...transform,
          y: 0,
        };
      },
    ],
    items: computed(() => {
      return (
        this.logic.groups$.value?.map((v) => v?.key ?? "default key") ?? []
      );
    }),
    strategy: horizontalListSortingStrategy,
  });

  private renderGroups() {
    const groups = this.logic.groups$.value;
    if (!groups) {
      return html``;
    }

    const safeGroups = groups.filter(
      (group): group is NonNullable<(typeof groups)[number]> => group != null,
    );

    return html`${safeGroups.map((group) => {
      return html` <myoxus-data-view-kanban-group
        ${sortable(group.key)}
        data-key="${group.key}"
        .kanbanViewLogic="${this.logic}"
        .group="${group}"
      ></myoxus-data-view-kanban-group>`;
    })}`;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.logic.ui$.value = this;
    this.logic.clipboardController.hostConnected();
    this.logic.dragController.hostConnected();
    this.logic.hotkeysController.hostConnected();
    this.logic.selectionController.hostConnected();
    this.classList.add("kanban-view", kanbanViewStyle);
    this.style.userSelect = "none";
    this.style.display = "flex";
    this.style.flexDirection = "column";
  }

  override render(): TemplateResult {
    const groups = this.logic.groups$.value?.filter(
      (
        group,
      ): group is NonNullable<(typeof this.logic.groups$.value)[number]> =>
        group != null,
    );
    if (!groups || groups.length === 0) {
      return html``;
    }

    const vPadding = this.logic.root.config.virtualPadding$.value;
    const wrapperStyle = styleMap({
      marginLeft: `-${vPadding}px`,
      marginRight: `-${vPadding}px`,
      paddingLeft: `${vPadding}px`,
      paddingRight: `${vPadding}px`,
    });

    const groupTrait = this.logic.groupTrait$.value;

    return html`
      ${renderUniLit(this.logic.root.config.headerWidget, {
        dataViewLogic: this.logic,
      })}
      <div
        ${ref(this.logic.scrollContainer$)}
        aria-label="Kanban"
        class="${kanbanGroupsStyle}"
        role="list"
        style="${wrapperStyle}"
        @wheel="${this.logic.onWheel}"
      >
        ${this.renderGroups()}
        ${groupTrait ? this.logic.renderAddGroup(groupTrait) : ""}
      </div>
    `;
  }
}

const kanbanViewStyle = css({
  userSelect: "none",
  display: "flex",
  flexDirection: "column",
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
});

const kanbanGroupsStyle = css({
  position: "relative",
  zIndex: 1,
  display: "flex",
  flex: "1 1 auto",
  alignItems: "stretch",
  gap: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
  minHeight: 0,
  maxWidth: "100%",
  paddingBottom: "var(--mantine-spacing-xs)",
  overflowX: "auto",
  overflowY: "hidden",
  overscrollBehaviorX: "contain",
  overscrollBehaviorY: "auto",

  "&:hover": {
    paddingBottom: 0,
  },

  "&::-webkit-scrollbar": {
    WebkitAppearance: "none",
    display: "block",
  },

  "&::-webkit-scrollbar:horizontal": {
    height: "var(--mantine-spacing-xs)",
  },

  "&::-webkit-scrollbar-thumb": {
    borderRadius: "2px",
    backgroundColor: "transparent",
  },

  "&:hover::-webkit-scrollbar:horizontal": {
    height: "var(--mantine-spacing-sm)",
  },

  "&:hover::-webkit-scrollbar-thumb": {
    borderRadius: "16px",
    backgroundColor: "var(--myoxus-black-30)",
  },

  "&:hover::-webkit-scrollbar-track": {
    backgroundColor: "var(--myoxus-hover-color)",
  },
});

const addGroupButtonStyle = css({
  alignItems: "center",
  display: "flex",
  flexShrink: 0,
  height: "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
});

const addGroupIconStyle = css({
  padding: "var(--mantine-spacing-xs)",
  borderRadius: "var(--mantine-radius-sm)",
  display: "flex",
  alignItems: "center",
  cursor: "pointer",

  "&:hover": {
    backgroundColor: "var(--myoxus-hover-color)",
  },

  "& svg": {
    width: "var(--mantine-spacing-lg)",
    height: "var(--mantine-spacing-lg)",
    fill: "var(--myoxus-icon-color)",
    color: "var(--myoxus-icon-color)",
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "dv-kanban-view-ui": KanbanViewUI;
  }
}
